// Phase 2 benchmark (local, repeatable): sync traffic of one game BEFORE vs AFTER migration 20261113000002.
//
//   npm i --no-save embedded-postgres pg && npm run bench:realtime            (N = 10, 30, 50)
//   BENCH_N=10 npm run bench:realtime                                          (one size)
//
// Real PostgreSQL (embedded), the repo's real migrations, the real client sync core (lib/game/sync.ts) and refresh
// keys (lib/game/refresh-keys.ts). Every snapshot / list read a client makes is a REAL query, counted. Realtime is
// emulated: a poller hands each new realtime.messages row to the clients subscribed to its topic (players: game:<id>;
// host console + presenter: game:<id> and, after Phase 2, game:<id>:host).
//   before = migrations up to Phase 1, legacy clients (re-read everything on every hint, side lists on every version)
//   after  = all migrations, Phase 2 clients (audience routing, debounced joins, dependency-keyed side lists)
// What is NOT emulated: network latency (local socket only), Storage (photo URL signing is COUNTED, not executed),
// Vercel cold starts, the 30 s safety re-read (no step lasts 30 s), focus/visibility events.
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { GameSyncCore, guestRoute, routeEverything } from "../../lib/game/sync.ts";
import { rosterKey, roundsKey, submissionsKey } from "../../lib/game/refresh-keys.ts";

let EmbeddedPostgres, pg;
try { EmbeddedPostgres = (await import("embedded-postgres")).default; pg = (await import("pg")).default; }
catch { console.error("Missing optional deps. Run: npm i --no-save embedded-postgres pg"); process.exit(2); }

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PHASE2 = "20261113000002_realtime_audience.sql";
const SIZES = (process.env.BENCH_N ?? "10,30,50").split(",").map(Number);
const ROUNDS = 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");
const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

/** Each mode gets its own throwaway server (the shim creates cluster-wide roles). */
async function makeDb(name, withPhase2) {
  const PORT = 56000 + Math.floor(Math.random() * 800);
  const ep = new EmbeddedPostgres({ databaseDir: fs.mkdtempSync((process.env.TMPDIR || "/tmp") + "/bm-bench-"), user: "postgres", password: "pw", port: PORT, persistent: false, onLog: () => {}, onError: () => {} });
  await ep.initialise(); await ep.start(); await ep.createDatabase(name);
  const c = new pg.Client({ host: "localhost", port: PORT, user: "postgres", password: "pw", database: name }); await c.connect();
  await c.query(fs.readFileSync(ROOT + "/tests/db/supabase-shim.sql", "utf8"));
  for (const f of fs.readdirSync(ROOT + "/supabase/migrations").filter((n) => n.endsWith(".sql")).sort()) {
    if (!withPhase2 && f === PHASE2) continue;
    await c.query(fs.readFileSync(`${ROOT}/supabase/migrations/${f}`, "utf8"));
  }
  const host = (await c.query("insert into auth.users (email) values ('bench@x.io') returning id")).rows[0].id;
  await c.query("set role service_role"); await c.query("select public.admin_set_subscription($1,'activate','pro',30,null)", [host]); await c.query("reset role");
  const pool = (setup) => { const p = new pg.Pool({ host: "localhost", port: PORT, user: "postgres", password: "pw", database: name, max: 12 }); p.on("connect", (cl) => { void cl.query(setup); }); return p; };
  const svc = pool("set role service_role");
  const hostPool = pool(`set role authenticated; select set_config('request.jwt.claim.sub','${host}',false), set_config('request.jwt.claims','${JSON.stringify({ sub: host })}',false)`);
  return { name, admin: c, svc, hostPool, host, withPhase2, ep };
}

/** One benchmark run: a Bring Me game with N players, ROUNDS rounds, every player submits, the host reviews every photo. */
async function runBringMe(db, n) {
  const after = db.withPhase2;
  const C = { rpc: { playerSnapshot: 0, hostSnapshot: 0, presenterSnapshot: 0, roster: 0, rounds: 0, submissionsRoute: 0, actions: 0 },
    signs: 0, vercel: 0, deliveries: 0, broadcasts: { game: 0, host: 0 }, initial: 0, dupApplied: 0, regressions: 0 };
  const q = async (pool, sql, args, bucket) => { if (bucket) C.rpc[bucket]++; return (await pool.query(sql, args)).rows; };
  await db.admin.query("update public.games set status='canceled' where owner_id=$1 and status in ('draft','lobby','live')", [db.host]);
  const g = (await q(db.hostPool, "select * from public.create_game_with_rounds('bench', $1)", [["a", "b", "c"]], "actions"))[0];
  const gameId = g.game_id;
  const ver = async () => Number((await db.admin.query("select state_version v from public.games where id=$1", [gameId])).rows[0].v);

  // --------------------------------------------------------------- clients
  let inflight = 0;
  const track = (fn) => async () => { inflight++; try { return await fn(); } finally { inflight--; } };
  const allMsgs = []; const hostMsgs = []; // [{v, t}] delivery times, for latency
  const lat = { phase: [], roster: [], host: [], transition: [] };
  let prevPhase = null;
  const clients = [];
  function makeClient(kind, initial, fetchFn, extra = {}) {
    // latency is measured only for hints delivered after this client subscribed (earlier ones are in its first snapshot)
    const cl = { kind, seen: new Set(), lastV: initial.version, ptrAll: allMsgs.length, ptrHost: hostMsgs.length, state: initial, stopped: false, ...extra };
    const record = (s) => {
      if (s.version < cl.lastV) C.regressions++;
      if (s.version === cl.lastV && cl.applied) C.dupApplied++;
      cl.applied = true; cl.lastV = s.version; cl.state = s;
      cl.seen.add(`${s.phase}:${s.round?.id ?? "-"}`);
      const now = performance.now();
      if (kind === "player") {
        while (cl.ptrAll < allMsgs.length && allMsgs[cl.ptrAll].v <= s.version) {
          const m = allMsgs[cl.ptrAll];
          if (m.transition) lat.transition.push(now - m.t);
          if (m.scope === "all") lat.phase.push(now - m.t); else if (m.scope === "roster") lat.roster.push(now - m.t);
          cl.ptrAll++;
        }
      } else if (kind === "host") {
        while (cl.ptrHost < hostMsgs.length && hostMsgs[cl.ptrHost].v <= s.version) { lat.host.push(now - hostMsgs[cl.ptrHost].t); cl.ptrHost++; }
      }
      extra.onState?.(s, cl);
    };
    cl.core = new GameSyncCore({
      initial, fetch: track(fetchFn), onState: record, onUnauthorized: () => { cl.stopped = true; },
      route: kind === "player" && after ? guestRoute(() => false) : routeEverything,   // Bring Me: claim reviews never concern players
      debounce: { baseMs: 1000, jitterMs: 1500 },
    });
    cl.topics = kind === "player" || !after ? [`game:${gameId}`] : [`game:${gameId}`, `game:${gameId}:host`];
    clients.push(cl);
    return cl;
  }

  // host console + presenter: snapshot + side lists, refreshed like the React effects (before: on every version; after: on keys)
  const sideLists = (who, s, cl) => {
    const inRound = ["active", "reviewing", "winner_announced"].includes(s.phase) && Boolean(s.round);
    const deps = after
      ? { roster: rosterKey(s), rounds: roundsKey(s), rows: inRound ? submissionsKey(s) : "none" }
      : { roster: `v${s.version}`, rounds: `v${s.version}`, rows: inRound ? `v${s.version}|${s.round?.id}` : "none" };
    const prev = cl.deps ?? {};
    const jobs = [];
    if (deps.roster !== prev.roster) jobs.push(q(db.hostPool, "select id, nickname from public.players where game_id=$1 and kicked_at is null order by joined_at", [gameId], "roster"));
    if (who === "console" && deps.rounds !== prev.rounds) jobs.push(q(db.hostPool, "select round_no, prompt, status from public.game_rounds where game_id=$1 order by round_no", [gameId], "rounds"));
    if (inRound && deps.rows !== prev.rows) jobs.push(submissionsRoute());
    cl.deps = deps;
    void Promise.all(jobs.map((j) => { inflight++; return j.finally(() => inflight--); }));
  };
  const submissionsRoute = async () => {   // /api/host/games/[id]/submissions: host_game_state + round_ranking + sign every photo
    C.vercel++; C.rpc.submissionsRoute++;
    const st = (await db.hostPool.query("select public.host_game_state($1) s", [gameId])).rows[0].s;
    if (!st.round?.id) return;
    const rows = (await db.hostPool.query("select * from public.round_ranking($1)", [st.round.id])).rows;
    C.signs += rows.length;
  };
  const hostFetch = (bucket) => async () => ({ status: "ok", state: (await q(db.hostPool, "select public.host_game_state($1) s", [gameId], bucket))[0].s });
  const hostInitial = (await q(db.hostPool, "select public.host_game_state($1) s", [gameId]))[0].s;
  const consoleCl = makeClient("host", hostInitial, hostFetch("hostSnapshot"), { onState: (s, cl) => sideLists("console", s, cl) });
  const presenterCl = makeClient("presenter", hostInitial, hostFetch("presenterSnapshot"), { onState: (s, cl) => sideLists("presenter", s, cl) });
  sideLists("console", hostInitial, consoleCl); sideLists("presenter", hostInitial, presenterCl);

  const players = [];
  const playerFetch = (hash) => async () => { C.vercel++; return { status: "ok", state: (await q(db.svc, "select public.player_game_state($1) s", [hash], "playerSnapshot"))[0].s }; };
  async function joinPlayer(i) {
    const hash = sha(`${db.name}-${n}-${i}-${gameId}`);
    await q(db.svc, "select * from public.join_game($1,$2,$3,null)", [g.code, `P${i}`, hash], "actions"); C.vercel++;
    const joinedAt = performance.now();
    C.initial++;
    const init = (await q(db.svc, "select public.player_game_state($1) s", [hash], "playerSnapshot"))[0].s; C.vercel++;
    const cl = makeClient("player", init, playerFetch(hash), { hash, joinedAt });
    players.push(cl);
    await cl.core.resync();   // useGameSync re-reads once its channel is SUBSCRIBED (same in both modes)
  }

  // --------------------------------------------------------------- realtime emulation
  let lastId = Number((await db.admin.query("select coalesce(max(id),0) m from realtime.messages")).rows[0].m);
  let polling = true;
  const poller = (async () => {
    while (polling) {
      const rows = (await db.admin.query("select id, topic, payload from realtime.messages where id > $1 and topic in ($2,$3) order by id", [lastId, `game:${gameId}`, `game:${gameId}:host`])).rows;
      for (const m of rows) {
        lastId = Number(m.id);
        const isHost = m.topic.endsWith(":host");
        C.broadcasts[isHost ? "host" : "game"]++;
        const t = performance.now();
        const scope = isHost ? "host" : (m.payload.scope ?? "all");
        const transition = !isHost && prevPhase !== null && m.payload.phase !== prevPhase;
        if (!isHost) prevPhase = m.payload.phase;
        allMsgs.push({ v: m.payload.version, t, scope: isHost ? "host" : scope, transition }); hostMsgs.push({ v: m.payload.version, t });
        for (const cl of clients) {
          if (cl.stopped || !cl.topics.includes(m.topic)) continue;
          C.deliveries++;
          cl.core.handleSignal(m.payload, isHost ? "host" : "game");
        }
      }
      await sleep(3);
    }
  })();
  const quiet = async (minMs = 120) => { let calm = 0; while (calm < minMs) { await sleep(10); calm = inflight === 0 ? calm + 10 : 0; } };
  const hostAct = async (action, winner = null) => {
    C.vercel++;
    const st = (await q(db.hostPool, "select public.game_transition($1,$2,$3,$4) s", [gameId, action, await ver(), winner], "actions"))[0].s;
    consoleCl.core.applyIfNewer(st);   // the console applies its own action's answer, like runAction()
    await quiet();
  };

  // --------------------------------------------------------------- the game
  // Lobby: everyone scans the QR within ~3 s
  await Promise.all(Array.from({ length: n }, (_, i) => sleep(Math.random() * 3000).then(() => joinPlayer(i))));
  await sleep(2700); await quiet();
  const kickIdx = n - 1;
  for (let r = 1; r <= ROUNDS; r++) {
    if (r === 1) await hostAct("start_game");
    await hostAct("start_countdown");
    // clock-sync burst (4 extra reads per player at each countdown, unchanged by Phase 2)
    await Promise.all(players.filter((p) => !p.stopped).map(async (p) => { for (let k = 0; k < 4; k++) { await playerFetch(p.hash)(); } }));
    await hostAct("start_round");
    await db.admin.query("update public.game_rounds set opened_at = clock_timestamp() - interval '3 seconds' where game_id=$1 and status='open'", [gameId]);
    await Promise.all(players.filter((p) => !p.stopped).map((p) => p.core.resync()));   // boundary re-read at the official start
    const round = (await db.admin.query("select current_round_id r from public.games where id=$1", [gameId])).rows[0].r;
    // photos: taps spread over ~6 s, uploads take 0.3–2 s
    const live = players.filter((p) => !p.stopped);
    await Promise.all(live.map(async (p, i) => {
      await sleep(Math.random() * 6000);
      const a = crypto.randomUUID();
      await q(db.svc, "select public.begin_submission($1,$2,$3,$4,'{\"syncRttMs\":30,\"syncAgeMs\":500}')", [p.hash, round, a, 3000 + i], "actions"); C.vercel++;
      await sleep(300 + Math.random() * 1700);
      await q(db.svc, "select public.complete_submission($1,$2,$3,'{}')", [p.hash, round, a], "actions"); C.vercel++;
    }));
    await quiet();
    if (r === 1) {   // a removal during gameplay
      const id = (await db.admin.query("select id from public.players where token_hash=$1", [players[kickIdx].hash])).rows[0].id;
      C.vercel++; await q(db.hostPool, "update public.players set kicked_at = now() where id=$1", [id], "actions");
      await quiet();
      players[kickIdx].stopped = true;
    }
    await hostAct("close_submissions");
    await hostAct("move_to_review");
    // the host reviews every photo (each: the review route, then the console re-reads its list, like host-console.tsx)
    const subs = (await db.admin.query("select s.id from public.submissions s join public.players p on p.id=s.player_id where s.round_id=$1 and p.kicked_at is null order by s.rank_ms", [round])).rows;
    for (const s of subs) {
      C.vercel++;
      const st = (await q(db.hostPool, "select public.review_submission($1,'approve') s", [s.id], "actions"))[0].s;
      consoleCl.core.applyIfNewer(st);
      void submissionsRoute();
      await sleep(40);
    }
    await quiet();
    const winner = (await db.admin.query("select s.player_id from public.submissions s join public.players p on p.id=s.player_id where s.round_id=$1 and p.kicked_at is null order by s.rank_ms limit 1", [round])).rows[0].player_id;
    await hostAct("announce_winner", winner);
    await sleep(200);
    await hostAct(r < ROUNDS ? "next_round" : "end_game");
  }
  await sleep(300); await quiet();
  polling = false; await poller;

  // --------------------------------------------------------------- correctness
  const finalV = await ver();
  const active = players.filter((p) => !p.stopped);
  const rounds = (await db.admin.query("select id from public.game_rounds where game_id=$1 and status <> 'pending' order by round_no", [gameId])).rows.map((x) => x.id);
  let missed = 0;
  for (const p of active) {
    for (const rid of rounds) for (const ph of ["countdown", "active", "reviewing", "winner_announced"]) if (!p.seen.has(`${ph}:${rid}`)) missed++;
    if (!p.seen.has("finished:-")) missed++;
  }
  const stale = active.filter((p) => p.lastV !== finalV).length + [consoleCl, presenterCl].filter((c) => c.lastV !== finalV).length;
  for (const cl of clients) cl.core.stop();
  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  return {
    n, ...C, totalRpc: sum(C.rpc), syncRpc: sum(C.rpc) - C.rpc.actions, missed, staleAtEnd: stale, finalV,
    playerStats: active.reduce((a, p) => { for (const [k, v] of Object.entries(p.core.stats)) a[k] = (a[k] ?? 0) + v; return a; }, {}),
    latency: { transitionN: lat.transition.length, transitionP50: pct(lat.transition, 50), transitionP95: pct(lat.transition, 95), transitionMax: pct(lat.transition, 100), phaseP50: pct(lat.phase, 50), phaseP95: pct(lat.phase, 95), phaseMax: pct(lat.phase, 100), rosterP50: pct(lat.roster, 50), rosterP95: pct(lat.roster, 95), hostP95: pct(lat.host, 95) },
  };
}

const before = await makeDb("bm_before", false);
const after = await makeDb("bm_after", true);
const results = [];
for (const n of SIZES) {
  for (const db of [before, after]) {
    const r = await runBringMe(db, n);
    results.push({ mode: db.withPhase2 ? "after" : "before", ...r });
    console.log(`N=${n} ${db.withPhase2 ? "after " : "before"}: syncRPC=${r.syncRpc} player=${r.rpc.playerSnapshot} host=${r.rpc.hostSnapshot}+${r.rpc.roster}r+${r.rpc.rounds}q presenter=${r.rpc.presenterSnapshot} subsRoute=${r.rpc.submissionsRoute} signs=${r.signs} deliveries=${r.deliveries} broadcasts=${r.broadcasts.game}+${r.broadcasts.host}h missed=${r.missed} stale=${r.staleAtEnd} regress=${r.regressions}`);
  }
}
for (const db of [before, after]) { await db.svc.end(); await db.hostPool.end(); await db.admin.end(); await db.ep.stop(); }
const out = process.env.BENCH_OUT;
if (out) fs.writeFileSync(out, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results.map((r) => ({ mode: r.mode, n: r.n, latency: r.latency, initial: r.initial, vercel: r.vercel, dupApplied: r.dupApplied, playerStats: r.playerStats })), null, 1));
