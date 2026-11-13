// OPT-IN concurrency test: real PostgreSQL + real, simultaneous connections running the repo's actual migrations.
// PGlite (used by `npm test`) has a single connection, so it cannot race. Run:
//   npm i --no-save embedded-postgres pg && npm run test:concurrency
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
let EmbeddedPostgres, pg;
try {
  EmbeddedPostgres = (await import("embedded-postgres")).default;
  pg = (await import("pg")).default;
} catch {
  console.error("Missing optional deps. Run: npm i --no-save embedded-postgres pg");
  process.exit(2);
}
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PORT = 54500 + Math.floor(Math.random() * 400);
const ep = new EmbeddedPostgres({ databaseDir: fs.mkdtempSync((process.env.TMPDIR || "/tmp") + "/bm-pg-"), user: "postgres", password: "pw", port: PORT, persistent: false });
await ep.initialise(); await ep.start(); await ep.createDatabase("bm");
const conn = async () => { const c = new pg.Client({ host: "localhost", port: PORT, user: "postgres", password: "pw", database: "bm" }); await c.connect(); return c; };
const admin = await conn();
await admin.query(fs.readFileSync(ROOT + "/tests/db/supabase-shim.sql", "utf8"));
for (const f of fs.readdirSync(ROOT + "/supabase/migrations").filter(n => n.endsWith(".sql")).sort()) await admin.query(fs.readFileSync(`${ROOT}/supabase/migrations/${f}`, "utf8"));
console.log("migrations applied on real PostgreSQL", (await admin.query("select version()")).rows[0].version.split(",")[0]);

const results = []; const check = (n, ok, info = "") => { results.push(ok); console.log((ok ? "PASS " : "FAIL ") + n + (info ? " — " + info : "")); };
const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");
const asUser = async (c, sub) => { await c.query("reset role"); await c.query("set role authenticated"); await c.query("select set_config('request.jwt.claim.sub',$1,false)", [sub]); await c.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub })]); };
const asSvc = async (c) => { await c.query("reset role"); await c.query("set role service_role"); };

const hostId = (await admin.query("insert into auth.users (email) values ('h@x.io') returning id")).rows[0].id;
await asSvc(admin); await admin.query("select public.admin_set_subscription($1,'activate','pro',30,null)", [hostId]);
await admin.query("reset role");

async function newGame(names, items = ["a", "b"]) {
  await admin.query("update public.games set status='canceled' where owner_id=$1 and status in ('draft','lobby','live')", [hostId]); // free plan slots between scenarios
  await asUser(admin, hostId);
  const g = (await admin.query("select * from public.create_game_with_rounds('conc', $1)", [items])).rows[0];
  await admin.query("reset role");
  const hashes = [];
  for (const n of names) { const h = sha(crypto.randomUUID()); hashes.push(h); await asSvc(admin); await admin.query("select * from public.join_game($1,$2,$3,null)", [g.code, n, h]); await admin.query("reset role"); }
  return { ...g, hashes };
}
const ver = async (id) => Number((await admin.query("select state_version v from public.games where id=$1", [id])).rows[0].v);

// N parallel connections each run the SAME GM request (same expected version)
async function race(gameId, action, n, expected, winner = null) {
  const conns = await Promise.all(Array.from({ length: n }, conn));
  await Promise.all(conns.map((c) => asUser(c, hostId)));
  const out = await Promise.allSettled(conns.map((c) => c.query("select public.game_transition($1,$2,$3,$4)", [gameId, action, expected, winner])));
  await Promise.all(conns.map((c) => c.end()));
  return out.map((o) => (o.status === "fulfilled" ? "ok" : o.reason.message));
}

// A. duplicate start_game x10
{ const g = await newGame(["A", "B"]); const r = await race(g.game_id, "start_game", 10, await ver(g.game_id));
  check("10 simultaneous start_game: exactly one succeeds", r.filter(x => x === "ok").length === 1 && r.filter(x => x === "stale_state").length === 9, JSON.stringify(r.reduce((a, x) => (a[x] = (a[x] || 0) + 1, a), {})));
  check("state advanced exactly once (version +1... status live)", (await admin.query("select status from public.games where id=$1", [g.game_id])).rows[0].status === "live"); }

// B. start_round x10 racing
{ const g = await newGame(["A", "B"]); const id = g.game_id;
  let c = await conn(); await asUser(c, hostId);
  await c.query("select public.game_transition($1,'start_game',$2,null)", [id, await ver(id)]);
  await c.query("select public.game_transition($1,'start_countdown',$2,null)", [id, await ver(id)]); await c.end();
  const v = await ver(id);
  const r = await race(id, "start_round", 10, v);
  const open = (await admin.query("select count(*)::int n from public.game_rounds where game_id=$1 and status='open'", [id])).rows[0].n;
  check("10 simultaneous start_round: opened exactly once", r.filter(x => x === "ok").length === 1 && open === 1, `ok=${r.filter(x => x === "ok").length} open_rounds=${open}`);
  check("version advanced by exactly 1 for the winner", (await ver(id)) === v + 1, `${v} -> ${await ver(id)}`); }

// C. two different GM actions racing on the same version: only one wins
{ const g = await newGame(["A"]); const id = g.game_id;
  const c0 = await conn(); await asUser(c0, hostId); await c0.query("select public.game_transition($1,'start_game',$2,null)", [id, await ver(id)]); await c0.end();
  const v = await ver(id);
  const [a, b] = await Promise.all([race(id, "start_countdown", 1, v), race(id, "end_game", 1, v)]);
  check("start_countdown vs end_game on the same version: one wins, one stale", [a[0], b[0]].sort().join() === "ok,stale_state", `${a[0]} / ${b[0]}`); }

// D. capacity under concurrency: 12 players race for 3 slots
{ await asUser(admin, hostId);
  const g = (await admin.query("select * from public.create_game_with_rounds('cap', array['x'])")).rows[0];
  await admin.query("update public.games set max_players=3 where id=$1", [g.game_id]); await admin.query("reset role");
  const conns = await Promise.all(Array.from({ length: 12 }, conn)); await Promise.all(conns.map(asSvc));
  const out = await Promise.allSettled(conns.map((c, i) => c.query("select * from public.join_game($1,$2,$3,null)", [g.code, "P" + i, sha("t" + i)])));
  await Promise.all(conns.map(c => c.end()));
  const okN = out.filter(o => o.status === "fulfilled").length; const full = out.filter(o => o.status === "rejected" && /game_full/.test(o.reason.message)).length;
  const n = (await admin.query("select count(*)::int n from public.players where game_id=$1", [g.game_id])).rows[0].n;
  check("12 simultaneous joins into 3 slots: exactly 3 admitted", okN === 3 && full === 9 && n === 3, `ok=${okN} full=${full} rows=${n}`); }

// E. joins racing Start Game: nobody gets in after the game started
{ const g = await newGame(["First"]); const id = g.game_id;
  const joiners = await Promise.all(Array.from({ length: 8 }, conn)); await Promise.all(joiners.map(asSvc));
  const starter = await conn(); await asUser(starter, hostId);
  const v = await ver(id);
  const [start, ...joins] = await Promise.allSettled([
    starter.query("select public.game_transition($1,'start_game',$2,null)", [id, v]),
    ...joiners.map((c, i) => c.query("select * from public.join_game($1,$2,$3,null)", [g.code, "J" + i, sha("j" + i)])),
  ]);
  await Promise.all([starter.end(), ...joiners.map(c => c.end())]);
  // a join that slipped in between creating the version and locking makes start_game 'stale'; retry as the UI would
  let started = start.status === "fulfilled";
  if (!started) { const c = await conn(); await asUser(c, hostId); await c.query("select public.game_transition($1,'start_game',$2,null)", [id, await ver(id)]); await c.end(); started = true; }
  const late = (await admin.query("select count(*)::int n from public.players p join public.games g on g.id=p.game_id where p.game_id=$1 and p.joined_at > g.started_at", [id])).rows[0].n;
  const bad = joins.filter(j => j.status === "rejected" && !/game_not_joinable/.test(j.reason.message)).length;
  check("joins racing Start Game: none admitted after the start; rejections are clean", late === 0 && bad === 0 && started, `joined_after_start=${late} unexpected_errors=${bad} start_first_try=${start.status === "fulfilled"}`); }


// ---------- Phase 8: submissions under concurrency
async function activeRound(names) {
  const g = await newGame(names); const id = g.game_id;
  const c0 = await conn(); await asUser(c0, hostId);
  for (const a of ["start_game", "start_countdown", "start_round"]) await c0.query("select public.game_transition($1,$2,$3,null)", [id, a, await ver(id)]);
  await c0.end();
  await admin.query("update public.game_rounds set opened_at = clock_timestamp() - interval '3 seconds' where game_id=$1 and status='open'", [id]);
  const round = (await admin.query("select current_round_id r from public.games where id=$1", [id])).rows[0].r;
  return { ...g, id, round };
}
async function parallelSvc(n, fn) {
  const conns = await Promise.all(Array.from({ length: n }, conn)); await Promise.all(conns.map(asSvc));
  const out = await Promise.allSettled(conns.map((c, i) => fn(c, i))); await Promise.all(conns.map((c) => c.end()));
  return out.map((o) => (o.status === "fulfilled" ? o.value.rows[0] && Object.values(o.value.rows[0])[0] : { error: o.reason.message }));
}
const countRows = async (t, w, args) => (await admin.query(`select count(*)::int n from public.${t} where ${w}`, args)).rows[0].n;

{ const g = await activeRound(["A", "B"]); const h = g.hashes[0]; const attempt = crypto.randomUUID();
  const begins = await parallelSvc(10, (c) => c.query("select public.begin_submission($1,$2,$3,1500,'{}')", [h, g.round, attempt]));
  const st = begins.map((b) => b.status);
  check("10 simultaneous begins of the same capture: one 'ready', the rest 'resumed', ONE intent", st.filter((x) => x === "ready").length === 1 && st.filter((x) => x === "resumed").length === 9 && (await countRows("submission_intents", "round_id=$1", [g.round])) === 1, JSON.stringify(st.reduce((a, x) => (a[x] = (a[x] || 0) + 1, a), {})));
  const comps = await parallelSvc(10, (c) => c.query("select public.complete_submission($1,$2,$3,'{}')", [h, g.round, attempt]));
  const cs = comps.map((b) => b.status);
  check("10 simultaneous completes: exactly one 'accepted', nine idempotent 'duplicate', ONE submission", cs.filter((x) => x === "accepted").length === 1 && cs.filter((x) => x === "duplicate").length === 9 && (await countRows("submissions", "round_id=$1", [g.round])) === 1, JSON.stringify(cs.reduce((a, x) => (a[x] = (a[x] || 0) + 1, a), {})));
  const dupBegins = await parallelSvc(5, (c) => c.query("select public.begin_submission($1,$2,$3,1,'{}')", [h, g.round, crypto.randomUUID()]));
  check("after acceptance, every new capture attempt is answered 'already_submitted' (nothing overwritten)", dupBegins.every((b) => b.status === "already_submitted") && (await countRows("submissions", "round_id=$1", [g.round])) === 1); }

{ const g = await activeRound(["A", "B"]); const h = g.hashes[1]; const a1 = crypto.randomUUID(), a2 = crypto.randomUUID();
  const out = await parallelSvc(2, (c, i) => c.query("select public.begin_submission($1,$2,$3,1000,'{}')", [h, g.round, i === 0 ? a1 : a2]));
  const intents = (await admin.query("select attempt_id from public.submission_intents where round_id=$1", [g.round])).rows;
  const winner = intents[0].attempt_id, loser = winner === a1 ? a2 : a1;
  const [rWin] = await parallelSvc(1, (c) => c.query("select public.complete_submission($1,$2,$3,'{}')", [h, g.round, winner]));
  check("two devices racing different captures: exactly one intent survives and only it can complete", intents.length === 1 && out.every((o) => !o.error) && rWin.status === "accepted", `survivor accepted=${rWin.status}`);
  const [rLose] = await parallelSvc(1, (c) => c.query("select public.complete_submission($1,$2,$3,'{}')", [h, g.round, loser]));
  check("…and the losing capture is refused or answered as a duplicate (never a second submission)", (rLose.error || rLose.status === "duplicate") && (await countRows("submissions", "round_id=$1 and player_id=(select id from public.players where token_hash=$2)", [g.round, h])) === 1, JSON.stringify(rLose)); }

{ const g = await activeRound(["A"]); const h = g.hashes[0]; const attempt = crypto.randomUUID();
  await parallelSvc(1, (c) => c.query("select public.begin_submission($1,$2,$3,800,'{}')", [h, g.round, attempt]));
  const host = await conn(); await asUser(host, hostId); const v = await ver(g.id);
  const [closeRes, completeRes] = await Promise.allSettled([
    host.query("select public.game_transition($1,'close_submissions',$2,null)", [g.id, v]),
    parallelSvc(1, (c) => c.query("select public.complete_submission($1,$2,$3,'{}')", [h, g.round, attempt])).then((r) => r[0]),
  ]);
  await host.end();
  check("a capture racing the host's 'close submissions': the tap came first, so it is accepted either way (no lost photo, no double)", closeRes.status === "fulfilled" && completeRes.value?.status === "accepted" && (await countRows("submissions", "round_id=$1", [g.round])) === 1, `close=${closeRes.status} complete=${completeRes.value?.status ?? completeRes.value?.error}`); }

// ---------- Phase 9: review decisions vs. winner announcement
async function reviewingGame() {
  const g = await activeRound(["Ann", "Bo"]);
  for (const [i, claimed] of [2600, 2800].entries()) {
    const att = crypto.randomUUID();
    await parallelSvc(1, (c) => c.query("select public.begin_submission($1,$2,$3,$4,'{\"syncRttMs\":30,\"syncAgeMs\":500}')", [g.hashes[i], g.round, att, claimed]));
    await parallelSvc(1, (c) => c.query("select public.complete_submission($1,$2,$3,'{}')", [g.hashes[i], g.round, att]));
  }
  const rows = (await admin.query("select s.id, pl.nickname from public.submissions s join public.players pl on pl.id=s.player_id where s.round_id=$1 order by s.rank_ms", [g.round])).rows;
  const host = await conn(); await asUser(host, hostId);
  for (const r of rows) await host.query("select public.review_submission($1,'approve')", [r.id]);
  for (const a of ["close_submissions", "move_to_review"]) await host.query("select public.game_transition($1,$2,$3,null)", [g.id, a, await ver(g.id)]);
  await host.end();
  const players = (await admin.query("select id, nickname from public.players where game_id=$1", [g.id])).rows;
  return { ...g, subs: rows, ann: players.find((p) => p.nickname === "Ann").id };
}

{ let announcedFirst = 0, disqualifiedFirst = 0, bad = 0;
  for (let i = 0; i < 8; i++) {
    const g = await reviewingGame(); const v = await ver(g.id);
    const [h1, h2] = await Promise.all([conn(), conn()]); await asUser(h1, hostId); await asUser(h2, hostId);
    const annSub = g.subs.find((x) => x.nickname === "Ann").id;
    const [rev, ann] = await Promise.allSettled([
      h1.query("select public.review_submission($1,'disqualify')", [annSub]),
      h2.query("select public.game_transition($1,'announce_winner',$2,$3)", [g.id, v, g.ann]),
    ]);
    await Promise.all([h1.end(), h2.end()]);
    const r = (await admin.query("select winner_player_id w, winner_confirmed_at c from public.game_rounds where id=$1", [g.round])).rows[0];
    const annStatus = (await admin.query("select status from public.submissions where id=$1", [annSub])).rows[0].status;
    if (r.w === g.ann && annStatus === "rejected") bad++;           // the forbidden outcome: a disqualified winner
    if (ann.status === "fulfilled" && rev.status === "rejected") announcedFirst++;
    if (rev.status === "fulfilled" && ann.status === "rejected") disqualifiedFirst++;
    if (ann.status === "fulfilled" && rev.status === "fulfilled") bad++; // both can't succeed
  }
  check("review vs announce race (8 rounds): NEVER a disqualified winner, never both succeed", bad === 0, `announce-first=${announcedFirst} disqualify-first=${disqualifiedFirst}`);
}

{ const g = await reviewingGame(); const v = await ver(g.id);
  const conns = await Promise.all(Array.from({ length: 10 }, conn)); await Promise.all(conns.map((c) => asUser(c, hostId)));
  const out = await Promise.allSettled(conns.map((c) => c.query("select public.game_transition($1,'announce_winner',$2,$3)", [g.id, v, g.ann])));
  await Promise.all(conns.map((c) => c.end()));
  const okN = out.filter((o) => o.status === "fulfilled").length;
  const msgs = out.filter((o) => o.status === "rejected").map((o) => o.reason.message);
  const w = (await admin.query("select winner_player_id w from public.game_rounds where id=$1", [g.round])).rows[0].w;
  check("10 simultaneous 'announce winner' requests: exactly ONE winner announcement", okN === 1 && msgs.every((m) => /stale_state/.test(m)) && w === g.ann, `ok=${okN} rejected=${[...new Set(msgs)]}`); }

{ const g = await reviewingGame();
  const subs = g.subs.map((x) => x.id);
  const outs = await Promise.allSettled(await Promise.all(Array.from({ length: 6 }, async (_, i) => { const c = await conn(); await asUser(c, hostId); return c.query("select public.review_submission($1,$2)", [subs[i % 2], i % 3 === 0 ? "disqualify" : i % 3 === 1 ? "approve" : "reset"]).finally(() => c.end()); })));
  const states = (await admin.query("select status from public.submissions where round_id=$1", [g.round])).rows.map((r) => r.status);
  check("concurrent review decisions never corrupt state (each photo ends in a valid status)", outs.every((o) => o.status === "fulfilled") && states.every((x) => ["pending", "approved", "rejected"].includes(x)) && states.length === 2); }

// ---------- Audit G1: submissions from DIFFERENT players of one game (migration 20261113000001)
// Before the fix, complete_submission held the game row FOR SHARE and then UPDATEd it (state_version):
// two players doing that at once deadlocked (40P01 after deadlock_timeout). Each call runs on its own
// connection with a statement timeout, and every outcome (ok / deadlock / timeout / other) is counted.
const TIMEOUT_MS = 20_000;
async function timedParallel(n, fn) {
  const conns = await Promise.all(Array.from({ length: n }, conn));
  await Promise.all(conns.map(async (c) => { await asSvc(c); await c.query(`set statement_timeout = ${TIMEOUT_MS}`); }));
  const t0 = Date.now();
  const out = await Promise.allSettled(conns.map(async (c, i) => { const s = Date.now(); const r = await fn(c, i); return { r, ms: Date.now() - s }; }));
  const wall = Date.now() - t0;
  await Promise.all(conns.map((c) => c.end()));
  const tally = { ok: 0, deadlock: 0, timeout: 0, other: 0 }; const others = new Set(); let slowest = 0;
  for (const o of out) {
    if (o.status === "fulfilled") { tally.ok++; slowest = Math.max(slowest, o.value.ms); continue; }
    const code = o.reason.code;
    if (code === "40P01") tally.deadlock++; else if (code === "57014") tally.timeout++; else { tally.other++; others.add(o.reason.message.slice(0, 50)); }
  }
  return { out, tally, wall, slowest, others: [...others] };
}
const fmt = (t) => `ok=${t.tally.ok} deadlock=${t.tally.deadlock} timeout=${t.tally.timeout} other=${t.tally.other}${t.others.length ? " " + JSON.stringify(t.others) : ""} wall=${t.wall}ms slowest=${t.slowest}ms`;
const META = '{"syncRttMs":30,"syncAgeMs":500}';
async function begunRound(n) {
  const g = await activeRound(Array.from({ length: n }, (_, i) => "P" + i));
  const atts = g.hashes.map(() => crypto.randomUUID());
  for (let i = 0; i < n; i++) { await asSvc(admin); await admin.query(`select public.begin_submission($1,$2,$3,$4,'${META}')`, [g.hashes[i], g.round, atts[i], 1000 + i * 10]); }
  await admin.query("reset role");
  return { ...g, atts };
}

const lastMsg = async () => Number((await admin.query("select coalesce(max(id),0)::int m from realtime.messages")).rows[0].m);
const hintsSince = async (gameId, since) => (await admin.query("select topic, payload from realtime.messages where id > $1 and topic in ($2, $3) order by id", [since, `game:${gameId}`, `game:${gameId}:host`])).rows;
for (const n of [2, 10, 30, 50]) {
  const g = await begunRound(n); const v0 = await ver(g.id); const m0 = await lastMsg();
  const res = await timedParallel(n, (c, i) => c.query("select public.complete_submission($1,$2,$3,'{}') r", [g.hashes[i], g.round, g.atts[i]]));
  const accepted = res.out.filter((o) => o.status === "fulfilled" && o.value.r.rows[0].r.status === "accepted").length;
  const rows = (await admin.query("select s.claimed_elapsed_ms c, s.server_elapsed_ms sv, s.rank_ms rk, s.timing_status t from public.submissions s where s.round_id=$1 order by s.claimed_elapsed_ms", [g.round])).rows;
  const v1 = await ver(g.id);
  // timing untouched: each claim kept its tap-time value, and the ranking rule (flagged -> server time) still applies
  const timingOk = rows.every((r, i) => r.c === 1000 + i * 10 && r.rk === (r.t === "flagged" ? Math.max(r.sv, 0) : Math.max(r.c, 0)));
  check(`${n} DIFFERENT players complete at the same instant: all accepted first try, no deadlock/timeout, ${n} rows, version +${n}, timing kept`,
    accepted === n && res.tally.ok === n && rows.length === n && v1 - v0 === n && timingOk, fmt(res));
  // Phase 2: every one of those hints is host-only (owner topic), none reaches the players' topic
  const hs = await hintsSince(g.id, m0);
  const onHost = hs.filter((h) => h.topic.endsWith(":host") && h.payload.scope === "host").length;
  const vs = hs.map((h) => h.payload.version);
  check(`Phase 2: ${n} concurrent photos -> ${n} hints on the host topic, 0 on the players' topic, distinct versions`,
    onHost === n && hs.length === n && new Set(vs).size === n && Math.max(...vs) === v1, `host=${onHost} total=${hs.length}`);
}

{ // Phase 2: simultaneous joins -> one 'roster' hint each, distinct versions; capacity still exact
  const g = await newGame([]); const m0 = await lastMsg();
  const outs = await Promise.allSettled(Array.from({ length: 30 }, async (_, i) => { const c = await conn(); await asSvc(c);
    return c.query("select * from public.join_game($1,$2,$3,null)", [g.code, "J" + i, sha("join30-" + i + g.code)]).finally(() => c.end()); }));
  const hs = await hintsSince(g.game_id, m0);
  const vs = hs.map((h) => h.payload.version);
  check("Phase 2: 30 simultaneous joins -> 30 'roster' hints on the players' topic, distinct versions, 30 players",
    outs.every((o) => o.status === "fulfilled") && hs.length === 30 && hs.every((h) => h.payload.scope === "roster" && !h.topic.endsWith(":host"))
      && new Set(vs).size === 30 && (await countRows("players", "game_id=$1 and kicked_at is null", [g.game_id])) === 30, `hints=${hs.length}`);
}

{ // realistic mix: half the players finishing, half tapping (begin), all at once
  const n = 30; const g = await activeRound(Array.from({ length: n }, (_, i) => "M" + i));
  const atts = g.hashes.map(() => crypto.randomUUID());
  for (let i = 0; i < n / 2; i++) { await asSvc(admin); await admin.query(`select public.begin_submission($1,$2,$3,1500,'${META}')`, [g.hashes[i], g.round, atts[i]]); }
  await admin.query("reset role");
  const res = await timedParallel(n, (c, i) => i < n / 2
    ? c.query("select public.complete_submission($1,$2,$3,'{}')", [g.hashes[i], g.round, atts[i]])
    : c.query(`select public.begin_submission($1,$2,$3,1800,'${META}')`, [g.hashes[i], g.round, atts[i]]));
  check("15 completes + 15 begins of different players at once: no deadlock/timeout, 15 submissions, 30 intents",
    res.tally.ok === n && (await countRows("submissions", "round_id=$1", [g.round])) === n / 2 && (await countRows("submission_intents", "round_id=$1", [g.round])) === n, fmt(res));
}

// Deterministic interleaving: the host's action is queued on the game row FIRST, then the player's request arrives.
async function waitUntilBlocked(pid) {
  for (let i = 0; i < 200; i++) {
    const w = (await admin.query("select wait_event_type from pg_stat_activity where pid=$1", [pid])).rows[0]?.wait_event_type;
    if (w === "Lock") return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}
async function hostFirstThenPlayer(gameId, hostSql, hostArgs, playerSql, playerArgs) {
  const blocker = await conn(); await blocker.query("begin"); await blocker.query("select 1 from public.games where id=$1 for update", [gameId]);
  const host = await conn(); await asUser(host, hostId); await host.query(`set statement_timeout = ${TIMEOUT_MS}`);
  const player = await conn(); await asSvc(player); await player.query(`set statement_timeout = ${TIMEOUT_MS}`);
  const hostPid = (await host.query("select pg_backend_pid() p")).rows[0].p;
  const playerPid = (await player.query("select pg_backend_pid() p")).rows[0].p;
  const hp = host.query(hostSql, hostArgs).then(() => "ok", (e) => e.code ?? e.message);
  await waitUntilBlocked(hostPid);
  const pp = player.query(playerSql, playerArgs).then(() => "ok", (e) => e.code ?? e.message);
  await waitUntilBlocked(playerPid);
  await blocker.query("commit"); await blocker.end();
  const [h, p] = await Promise.all([hp, pp]);
  await host.end(); await player.end();
  return { host: h, player: p };
}

{ // The winner's phone retries 'complete' (lost response) exactly while the host announces them as the winner.
  // announce_winner writes game_rounds.winner_player_id -> FK check takes KEY SHARE on that player's row.
  const g = await reviewingGame(); const v = await ver(g.id);
  const annHash = g.hashes[0];
  const att = (await admin.query("select attempt_id a from public.submissions where player_id=$1", [g.ann])).rows[0].a;
  const r = await hostFirstThenPlayer(g.id, "select public.game_transition($1,'announce_winner',$2,$3)", [g.id, v, g.ann],
    "select public.complete_submission($1,$2,$3,'{}')", [annHash, g.round, att]);
  check("winner's retried 'complete' while the host announces them: both succeed, no deadlock", r.host === "ok" && r.player === "ok", JSON.stringify(r));
}

{ // Same, for a late 'begin' (resume of an upload) while the host announces that player.
  const g = await reviewingGame(); const v = await ver(g.id);
  const r = await hostFirstThenPlayer(g.id, "select public.game_transition($1,'announce_winner',$2,$3)", [g.id, v, g.ann],
    "select public.begin_submission($1,$2,$3,1000,'{}')", [g.hashes[0], g.round, crypto.randomUUID()]);
  check("winner's late 'begin' while the host announces them: both succeed, no deadlock", r.host === "ok" && r.player === "ok", JSON.stringify(r));
}

{ // Completes racing the host removing OTHER players and removing a player who is completing.
  const n = 12; const g = await begunRound(n);
  const kicked = [0, 1, 2]; // 0..2 are completing AND being removed; the rest only complete
  const ids = (await admin.query("select id from public.players where token_hash = any($1) order by array_position($1, token_hash)", [g.hashes])).rows.map((r) => r.id);
  const hostConnsK = await Promise.all(kicked.map(async () => { const c = await conn(); await asUser(c, hostId); return c; }));
  const [res, kicks] = await Promise.all([
    timedParallel(n, (c, i) => c.query("select public.complete_submission($1,$2,$3,'{}')", [g.hashes[i], g.round, g.atts[i]])),
    Promise.allSettled(hostConnsK.map((c, k) => c.query("update public.players set kicked_at = now() where id=$1 and game_id=$2", [ids[kicked[k]], g.id]))),
  ]);
  await Promise.all(hostConnsK.map((c) => c.end()));
  const clean = res.out.every((o) => o.status === "fulfilled" || /player_removed/.test(o.reason.message));
  check("12 completes racing 3 removals: no deadlock/timeout; a removed player is either accepted first or refused 'player_removed'",
    res.tally.deadlock === 0 && res.tally.timeout === 0 && clean && kicks.every((k) => k.status === "fulfilled"), fmt(res));
}

{ // Completes racing 'close submissions' and host review decisions on already accepted photos.
  const n = 20; const g = await begunRound(n);
  const early = 5;
  for (let i = 0; i < early; i++) { await asSvc(admin); await admin.query("select public.complete_submission($1,$2,$3,'{}')", [g.hashes[i], g.round, g.atts[i]]); }
  await admin.query("reset role");
  const subs = (await admin.query("select id from public.submissions where round_id=$1", [g.round])).rows.map((r) => r.id);
  const reviewers = await Promise.all(subs.map(async () => { const c = await conn(); await asUser(c, hostId); return c; }));
  const closer = await conn(); await asUser(closer, hostId);
  const [res, reviews, close] = await Promise.all([
    timedParallel(n - early, (c, i) => c.query("select public.complete_submission($1,$2,$3,'{}')", [g.hashes[early + i], g.round, g.atts[early + i]])),
    Promise.allSettled(reviewers.map((c, i) => c.query("select public.review_submission($1,'approve')", [subs[i]]))),
    closer.query("select public.game_transition($1,'close_submissions',$2,null)", [g.id, await ver(g.id)]).then(() => "ok", (e) => e.message),
  ]);
  await Promise.all([...reviewers.map((c) => c.end()), closer.end()]);
  const badReview = reviews.filter((r) => r.status === "rejected" && r.reason.code === "40P01").length;
  check("15 completes racing 5 review decisions and 'close submissions': no deadlock/timeout anywhere",
    res.tally.deadlock === 0 && res.tally.timeout === 0 && res.tally.other === 0 && badReview === 0 && (close === "ok" || /stale_state/.test(close)),
    `${fmt(res)} reviews=${reviews.filter((r) => r.status === "fulfilled").length}/${reviews.length} close=${close}`);
}

// ---------- Game Pass ledger under concurrency (migrations 20261112000001..7)
await admin.query("reset role");
await admin.query("update public.plan_prices pp set polar_product_id = 'prod_' || p.code || '_' || pp.currency from public.subscription_plans p where p.id = pp.plan_id and not p.is_trial");
const newHost = async (e) => (await admin.query("insert into auth.users (email) values ($1) returning id", [e])).rows[0].id;
const overlaps = async () => (await admin.query(`select count(*)::int n from public.pass_segments a join public.pass_segments b
  on a.user_id=b.user_id and a.id<b.id and tstzrange(a.starts_at,a.ends_at,'[)') && tstzrange(b.starts_at,b.ends_at,'[)')`)).rows[0].n;
const mkOrder = async (u, plan) => { await asSvc(admin); const r = (await admin.query("select * from public.create_pass_order($1,$2,'PHP')", [u, plan])).rows[0]; await admin.query("reset role"); return r; };
const paidEffect = (o) => JSON.stringify({ kind: "order_paid", order_id: o.order_id, polar_order_id: "po_" + o.order_id, polar_product_id: o.polar_product_id, currency: "PHP", amount_minor: o.amount_minor });

{ const u = await newHost("trial-race@x.io");   // unconfirmed signup
  // The confirmation (auto-trial trigger) races 10 sign-ins / dashboard clicks (ensure_my_trial).
  const outs = await Promise.allSettled([
    (async () => { const c = await conn(); return c.query("update auth.users set email_confirmed_at = now() where id=$1", [u]).finally(() => c.end()); })(),
    ...Array.from({ length: 10 }, async () => { const c = await conn(); await asUser(c, u); return c.query("select * from public.ensure_my_trial()").finally(() => c.end()); }),
  ]);
  const errs = outs.filter((o) => o.status === "rejected").map((o) => o.reason.message);
  const n = await countRows("game_passes", "user_id=$1 and source='trial'", [u]);
  const segsN = await countRows("pass_segments", "user_id=$1", [u]);
  check("confirmation racing 10 activation requests: exactly ONE trial, no errors", errs.length === 0 && n === 1 && segsN === 1, `trials=${n} segments=${segsN} ${errs}`); }

{ const u = await newHost("webhook-race@x.io");
  const o = await mkOrder(u, "party");
  const outs = await Promise.all(Array.from({ length: 10 }, async () => { const c = await conn(); await asSvc(c);
    return c.query("select public.apply_payment_event('polar','evt_race','order.paid','{}',$1) r", [paidEffect(o)]).then((r) => r.rows[0].r).finally(() => c.end()); }));
  const n = await countRows("game_passes", "user_id=$1", [u]);
  check("the same webhook delivered 10x at once: ONE pass, 9 duplicates", n === 1 && outs.filter((x) => x === "applied").length === 1 && outs.filter((x) => x === "duplicate").length === 9, outs.join(",")); }

{ const u = await newHost("double-buy@x.io");
  const a = await mkOrder(u, "starter"); const b = await mkOrder(u, "pro");
  const outs = await Promise.all([[a, "e_a"], [b, "e_b"]].map(async ([o, id]) => { const c = await conn(); await asSvc(c);
    return c.query("select public.apply_payment_event('polar',$1,'order.paid','{}',$2) r", [id, paidEffect(o)]).then((r) => r.rows[0].r).finally(() => c.end()); }));
  const rows = (await admin.query("select pl.code, extract(epoch from (s.ends_at - s.starts_at))::float8 secs from public.pass_segments s join public.game_passes p on p.id=s.pass_id join public.subscription_plans pl on pl.id=p.plan_id where s.user_id=$1 order by s.starts_at", [u])).rows;
  const total = (code) => rows.filter((r) => r.code === code).reduce((a, r) => a + r.secs, 0);
  const active = (await admin.query("select plan_code from public.pass_entitlement($1)", [u])).rows[0]?.plan_code;
  // Whichever commits first, Pro ends up active now; Starter (maybe paused for a few ms) keeps exactly 7 days.
  check("two different orders paid at the same moment: both granted, no overlap, Pro active, no paid time lost",
    outs.every((x) => x === "applied") && (await overlaps()) === 0 && active === "pro"
      && Math.abs(total("starter") - 604800) < 1e-3 && Math.abs(total("pro") - 604800) < 1e-3, `${outs} ${rows.map((r) => r.code)}`); }

{ const u = await newHost("trial-vs-buy@x.io");
  const o = await mkOrder(u, "starter");
  const [t, w] = await Promise.allSettled([
    (async () => { const c = await conn(); return c.query("update auth.users set email_confirmed_at = now() where id=$1", [u]).finally(() => c.end()); })(),
    (async () => { const c = await conn(); await asSvc(c); return c.query("select public.apply_payment_event('polar','e_tvb','order.paid','{}',$1) r", [paidEffect(o)]).finally(() => c.end()); })(),
  ]);
  const st = (await admin.query("select p.source::text, p.disposition::text from public.game_passes p where user_id=$1 order by seq", [u])).rows;
  const active = (await admin.query("select plan_code from public.pass_entitlement($1)", [u])).rows[0]?.plan_code;
  const trial = st.filter((r) => r.source === "trial");
  const ok = t.status === "fulfilled" && w.status === "fulfilled" && active === "starter" && (await overlaps()) === 0
    && (trial.length === 0 || (trial.length === 1 && trial[0].disposition === "forfeited"));
  check("auto-trial racing a purchase: the paid pass wins either way (no trial, or trial forfeited)", ok, JSON.stringify(st)); }

{ const u = await newHost("double-click@x.io");
  const prod = "11111111-1111-4111-8111-111111111111";
  const outs = await Promise.allSettled(Array.from({ length: 10 }, async () => { const c = await conn(); await asSvc(c);
    return c.query("select * from public.start_checkout_order($1,'starter','PHP','sandbox',$2)", [u, prod]).then((r) => r.rows[0]).finally(() => c.end()); }));
  const ok = outs.filter((o) => o.status === "fulfilled").map((o) => o.value);
  const ids = new Set(ok.map((r) => r.order_id));
  const n = await countRows("pass_orders", "user_id=$1", [u]);
  check("10 simultaneous 'Buy' clicks: ONE order; the other 9 see it in flight", ok.length === 10 && ids.size === 1 && n === 1 && ok.filter((r) => r.in_flight).length === 9, `orders=${n} distinct=${ids.size}`); }

// ---------- Phase 6: full webhook path (signature -> fetch -> apply) under concurrent deliveries
{ const { handlePolarWebhook } = await import("../../lib/billing/webhook.ts");
  const { parseWebhookEnv } = await import("../../lib/billing/config.ts");
  const ORG = "44444444-4444-4444-8444-444444444444", PROD = "11111111-1111-4111-8111-111111111111";
  const SECRET = "whsec_" + Buffer.from("race-secret-0123456789").toString("base64");
  const config = parseWebhookEnv({ NODE_ENV: "development", POLAR_SERVER: "sandbox", POLAR_ACCESS_TOKEN: "t", POLAR_WEBHOOK_SECRET: SECRET, POLAR_ORGANIZATION_ID: ORG });
  const setup = async (email) => {
    const u = await newHost(email); await asSvc(admin);
    const o = (await admin.query("select * from public.start_checkout_order($1,'starter','PHP','sandbox',$2)", [u, PROD])).rows[0];
    await admin.query("select public.attach_verified_checkout($1,$2,$3,'php',9900,null,$4,now() + interval '1 hour')", [o.order_id, "co_" + email, PROD, "https://sandbox.polar.sh/c/x"]);
    await admin.query("reset role");
    const polar = { id: "ord_" + email, status: "paid", paid: true, currency: "php", discount_amount: 0, net_amount: 9900, tax_amount: 0, total_amount: 9900, refunded_amount: 0,
      billing_reason: "purchase", product_id: PROD, checkout_id: "co_" + email, customer_id: "cus", customer: { external_id: u, organization_id: ORG }, product: { organization_id: ORG }, metadata: { bringme_order_id: o.order_id } };
    return { u, order: o.order_id, polar };
  };
  const deliver = (id, polarId) => { const ts = String(Math.floor(Date.now() / 1000)); const body = JSON.stringify({ type: "order.paid", data: { id: polarId } });
    const sig = crypto.createHmac("sha256", Buffer.from(SECRET.slice(6), "base64")).update(`${id}.${ts}.${body}`).digest("base64");
    const h = new Map([["webhook-id", id], ["webhook-timestamp", ts], ["webhook-signature", "v1," + sig]]); return { headers: { get: (k) => h.get(k) ?? null }, body }; };
  const run = async (p, ids) => Promise.all(ids.map(async (id) => { const c = await conn(); await asSvc(c);
    try { return await handlePolarWebhook({ config, fetchOrder: async () => p.polar, fetchCheckout: async () => null,
      apply: async (eventId, type, summary, effect) => (await c.query("select public.apply_payment_event('polar',$1,$2,$3,$4) r", [eventId, type, summary, effect])).rows[0].r }, deliver(id, p.polar.id));
    } finally { await c.end(); } }));
  const passesFor = async (order) => (await admin.query("select count(*)::int n, coalesce(sum(extract(epoch from (s.ends_at - s.starts_at))),0)::float8 secs from public.game_passes g left join public.pass_segments s on s.pass_id=g.id where g.order_id=$1", [order])).rows[0];
  const a = await setup("race-same@x.io");
  const ra = await run(a, Array.from({ length: 10 }, () => "msg_same"));
  const oa = ra.flatMap((r) => r.body.outcomes); const pa = await passesFor(a.order);
  check("webhook: the SAME delivery 10x concurrently -> 1 applied, 9 duplicate, ONE 7-day pass", oa.filter((x) => x === "applied").length === 1 && oa.filter((x) => x === "duplicate").length === 9 && pa.n === 1 && pa.secs === 604800, oa.join(","));
  const b = await setup("race-diff@x.io");
  const rb = await run(b, Array.from({ length: 10 }, (_, i) => "msg_diff_" + i));
  const ob = rb.flatMap((r) => r.body.outcomes); const pb = await passesFor(b.order);
  check("webhook: 10 DIFFERENT deliveries for the same paid order concurrently -> ONE 7-day pass", ob.filter((x) => x === "applied").length === 1 && ob.filter((x) => x === "duplicate_effect").length === 9 && pb.n === 1 && pb.secs === 604800, ob.join(",")); }

// ---------- Phase 7: final-slot races under the pass capacity
{ const u = await newHost("final-slot@x.io");
  await admin.query("reset role"); await admin.query("update auth.users set email_confirmed_at = now() where id=$1", [u]);   // auto trial: 3 players
  const c0 = await conn(); await asUser(c0, u);
  const g = (await c0.query("select * from public.create_game_with_rounds('Race', array['a'])")).rows[0]; await c0.end();
  await asSvc(admin);
  for (const nm of ["A", "B"]) await admin.query("select * from public.join_game($1,$2,$3,null)", [g.code, nm, sha(crypto.randomUUID())]);
  const outs = await Promise.allSettled(Array.from({ length: 10 }, async (_, i) => { const c = await conn(); await asSvc(c);
    return c.query("select * from public.join_game($1,$2,$3,null)", [g.code, "R" + i, sha(crypto.randomUUID())]).finally(() => c.end()); }));
  await admin.query("reset role");
  const active = await countRows("players", "game_id=$1 and kicked_at is null", [g.game_id]);
  const fulls = outs.filter((o) => o.status === "rejected" && /game_full/.test(o.reason.message)).length;
  check("trial (3 players): 10 simultaneous joins for the LAST slot -> exactly 1 gets it", active === 3 && fulls === 9, `active=${active} game_full=${fulls}`);

  // un-remove racing a join for the last slot
  const victim = (await admin.query("select id from public.players where game_id=$1 and nickname='A'", [g.game_id])).rows[0].id;
  const ch = await conn(); await asUser(ch, u); await ch.query("update public.players set kicked_at = now() where id=$1", [victim]);
  const [restore, joinOne] = await Promise.allSettled([
    ch.query("update public.players set kicked_at = null where id=$1", [victim]),
    (async () => { const c = await conn(); await asSvc(c); return c.query("select * from public.join_game($1,'Late',$2,null)", [g.code, sha(crypto.randomUUID())]).finally(() => c.end()); })(),
  ]);
  await ch.end();
  const after = await countRows("players", "game_id=$1 and kicked_at is null", [g.game_id]);
  check("restoring a removed player racing a join for the last slot: exactly one wins, never 4", after === 3 && [restore, joinOne].filter((o) => o.status === "fulfilled").length === 1, `active=${after} restore=${restore.status} join=${joinOne.status}`); }

// ---------------------------------------------------------------- BingoSnap ----
{ const u = (await admin.query("insert into auth.users (email) values ('bingo-race@x.io') returning id")).rows[0].id;
  await admin.query("update auth.users set email_confirmed_at = now() where id=$1", [u]);   // auto trial: 3 players
  const c0 = await conn(); await asUser(c0, u);
  const g = (await c0.query("select * from public.create_bingosnap_game('Race', 3, 'traditional', false, 600, 'ranked', $1)",
    [Array.from({ length: 9 }, (_, i) => "c" + i)])).rows[0];
  await c0.end();
  // 12 simultaneous joins into a 3-player BingoSnap room -> exactly 3 (same capacity trigger as Bring Me)
  const outs = await Promise.allSettled(Array.from({ length: 12 }, async (_, i) => { const c = await conn(); await asSvc(c);
    return c.query("select * from public.join_game($1,$2,$3,null)", [g.code, "J" + i, sha("bingo-race-" + i)]).finally(() => c.end()); }));
  const active = await countRows("players", "game_id=$1 and kicked_at is null", [g.game_id]);
  check("BingoSnap trial (3 players): 12 simultaneous joins -> exactly 3", active === 3 && outs.filter((o) => o.status === "fulfilled").length === 3, `active=${active}`);

  // the hunt: 10 simultaneous claims by the SAME participant -> exactly one pending claim
  const ch = await conn(); await asUser(ch, u);
  for (const a of ["start_game", "start_countdown", "start_hunt"]) await ch.query("select public.bingo_transition($1,$2,$3,null)", [g.game_id, a, await ver(g.game_id)]);
  await admin.query("update public.bingo_games set hunt_started_at = clock_timestamp() - interval '1 second' where game_id=$1", [g.game_id]);
  const winner = (await admin.query("select token_hash h, id from public.players where game_id=$1 and kicked_at is null order by joined_at limit 1", [g.game_id])).rows[0];
  const row0 = (await admin.query("select array_agg(cell_id order by pos) ids from public.bingo_layout($1,$2) where row_no = 0", [g.game_id, winner.id])).rows[0].ids;
  const claims = await parallelSvc(10, (c) => c.query("select public.bingo_submit_claim($1,$2)", [winner.h, row0]));
  const okClaims = claims.filter((x) => !x?.error).length;
  check("BingoSnap: 10 simultaneous claims by one participant -> exactly 1", okClaims === 1 && (await countRows("bingo_submissions", "player_id=$1", [winner.id])) === 1,
    JSON.stringify(claims.map((x) => x?.error ?? "ok").reduce((a, x) => (a[x.replace(/^.*(claim_pending).*$/, "$1")] = (a[x] || 0) + 1, a), {})));

  // a claim racing close_hunt: either accepted before the close, or refused; never accepted after it
  const second = (await admin.query("select token_hash h, id from public.players where game_id=$1 and kicked_at is null order by joined_at offset 1 limit 1", [g.game_id])).rows[0];
  const row1 = (await admin.query("select array_agg(cell_id order by pos) ids from public.bingo_layout($1,$2) where row_no = 1", [g.game_id, second.id])).rows[0].ids;
  const v = await ver(g.game_id);
  const [cl, close] = await Promise.allSettled([
    (async () => { const c = await conn(); await asSvc(c); return c.query("select public.bingo_submit_claim($1,$2)", [second.h, row1]).finally(() => c.end()); })(),
    ch.query("select public.bingo_transition($1,'close_hunt',$2,null)", [g.game_id, v]),
  ]);
  const late = (await admin.query("select count(*)::int n from public.bingo_submissions s join public.bingo_games b on b.game_id=s.game_id where s.player_id=$1 and s.submitted_at > b.hunt_ends_at + interval '2 seconds'", [second.id])).rows[0].n;
  check("BingoSnap: a claim racing close_hunt is never recorded after the deadline", late === 0 && (close.status === "fulfilled" || /stale_state/.test(close.reason?.message ?? "")), `claim=${cl.status} close=${close.status}`);
  await ch.end(); }

// BingoSnap board saves: 10 simultaneous saves with the same board revision -> exactly one, nine stale_board
{ const u = (await admin.query("insert into auth.users (email) values ('bingo-board-race@x.io') returning id")).rows[0].id;
  await asSvc(admin); await admin.query("select public.admin_set_subscription($1,'activate','pro',30,null)", [u]); await admin.query("reset role");
  const c0 = await conn(); await asUser(c0, u);
  const g = (await c0.query("select public.bingo_save_board(null,0,'Race',3,'traditional',false,600,'ranked',$1) s", [Array(9).fill("")])).rows[0].s;
  await c0.end();
  const conns = await Promise.all(Array.from({ length: 10 }, conn));
  await Promise.all(conns.map((c) => asUser(c, u)));
  const outs = await Promise.allSettled(conns.map((c, i) => c.query("select public.bingo_save_board($1,0,'Race',3,'traditional',false,600,'ranked',$2)", [g.gameId, Array(9).fill("v" + i)])));
  await Promise.all(conns.map((c) => c.end()));
  const ok = outs.filter((o) => o.status === "fulfilled").length;
  const stale = outs.filter((o) => o.status === "rejected" && /stale_board/.test(o.reason.message)).length;
  const rev = (await admin.query("select board_revision r from public.bingo_games where game_id=$1", [g.gameId])).rows[0].r;
  const distinct = (await admin.query("select count(distinct challenge)::int n from public.bingo_cells where game_id=$1", [g.gameId])).rows[0].n;
  check("BingoSnap: 10 simultaneous board saves (same revision) -> exactly one wins, nine stale_board, board from one save", ok === 1 && stale === 9 && rev === 1 && distinct === 1, `ok=${ok} stale=${stale} rev=${rev}`); }

// BingoSnap lobby (migration 20): 12 joins racing the one-step start in a 3-player (trial) room.
// The start and every join lock the same game row, so each join either lands before the start
// (and is counted by its pass check) or is refused as game_not_joinable; the cap is never passed.
{ const u = (await admin.query("insert into auth.users (email) values ('bingo-start-race@x.io') returning id")).rows[0].id;
  await admin.query("update auth.users set email_confirmed_at = now() where id=$1", [u]);   // auto trial: 3 players
  const c0 = await conn(); await asUser(c0, u);
  const g = (await c0.query("select public.bingo_save_board(null,0,'Start race',3,'traditional',false,600,'ranked',$1,true) s",
    [Array.from({ length: 9 }, (_, i) => "c" + i)])).rows[0].s;
  const code = (await admin.query("select join_code c from public.games where id=$1", [g.gameId])).rows[0].c;
  await admin.query("select * from public.join_game($1,'First',$2,null)", [code, sha("bingo-start-first")]);
  const jc = await Promise.all(Array.from({ length: 12 }, conn));   // connected first, so joins and the start really overlap
  await Promise.all(jc.map(asSvc));
  // warm each connection's plpgsql cache (a cold first call is much slower than the host's warm one)
  await Promise.all(jc.map((c) => c.query("select * from public.join_game('ZZZZZZ','w',$1,null)", [sha("warm")]).catch(() => null)));
  const v0 = await ver(g.gameId);
  const joins = jc.map((c, i) => c.query("select * from public.join_game($1,$2,$3,null)", [code, "S" + i, sha("bingo-start-race-" + i)]).finally(() => c.end()));
  const starter = (async () => {
    try { return await c0.query("select public.bingo_start($1,$2)", [g.gameId, v0]); } catch (e) { if (!/stale_state/.test(e.message)) throw e; } // the host's client retries a stale version (players joining meanwhile)
    for (let i = 0; i < 30; i++) {
      try { return await c0.query("select public.bingo_start($1,$2)", [g.gameId, await ver(g.gameId)]); }
      catch (e) { if (!/stale_state/.test(e.message)) throw e; }
    }
    throw new Error("never started");
  })();
  const [startOut, ...outs] = await Promise.allSettled([starter, ...joins]);
  await c0.end();
  const ok = outs.filter((o) => o.status === "fulfilled").length;
  const refusedOk = outs.every((o) => o.status === "fulfilled" || /game_not_joinable|game_full/.test(o.reason.message));
  const active = await countRows("players", "game_id=$1 and kicked_at is null", [g.gameId]);
  const st = (await admin.query("select status::text s, phase::text p from public.games where id=$1", [g.gameId])).rows[0];
  check("BingoSnap: 12 joins racing Start game (3-player room) -> started, players = successful joins <= 3, others refused cleanly",
    startOut.status === "fulfilled" && st.s === "live" && st.p === "active" && active === ok + 1 && active <= 3 && refusedOk,
    `start=${startOut.status} ${st.s}/${st.p} active=${active} joined=${ok} refused=${JSON.stringify(outs.filter((o) => o.status === "rejected").map((o) => o.reason.message.slice(0, 40)).reduce((a, m) => (a[m] = (a[m] || 0) + 1, a), {}))}`); }

// BingoSnap reliable claims (migration 21): idempotent retries and the deadline judged on arrival.
{ const u = (await admin.query("insert into auth.users (email) values ('bingo-claims-race@x.io') returning id")).rows[0].id;
  await admin.query("update auth.users set email_confirmed_at = now() where id=$1", [u]);
  const c0 = await conn(); await asUser(c0, u);
  const g = (await c0.query("select public.bingo_save_board(null,0,'Claims race',3,'traditional',false,600,'ranked',$1,true) s",
    [Array.from({ length: 9 }, (_, i) => "c" + i)])).rows[0].s;
  const code = (await admin.query("select join_code c from public.games where id=$1", [g.gameId])).rows[0].c;
  for (const n of ["A", "B", "C"]) await admin.query("select * from public.join_game($1,$2,$3,null)", [code, n, sha("claims-race-" + n)]);
  await c0.query("select public.bingo_start($1,$2)", [g.gameId, await ver(g.gameId)]);
  await c0.end();
  await admin.query("update public.bingo_games set hunt_started_at = clock_timestamp() - interval '1 minute', hunt_ends_at = clock_timestamp() + interval '10 minutes' where game_id=$1", [g.gameId]);
  const pl = async (n) => { const r = (await admin.query("select id from public.players where game_id=$1 and nickname=$2", [g.gameId, n])).rows[0];
    return { id: r.id, h: sha("claims-race-" + n), row0: (await admin.query("select array_agg(cell_id order by pos) ids from public.bingo_layout($1,$2) where row_no = 0", [g.gameId, r.id])).rows[0].ids }; };
  const [A, B, C] = [await pl("A"), await pl("B"), await pl("C")];

  // 10 copies of the SAME request at once (a retried / replayed submit): all succeed, ONE claim.
  const req = crypto.randomUUID();
  const same = await parallelSvc(10, (c) => c.query("select public.bingo_submit_claim($1,$2,$3)", [A.h, A.row0, req]));
  check("BingoSnap: the same claim request 10x at once -> all answered OK, exactly ONE claim", same.every((x) => !x?.error) && (await countRows("bingo_submissions", "player_id=$1", [A.id])) === 1,
    JSON.stringify(same.map((x) => x?.error?.slice(0, 30) ?? "ok").reduce((a, x) => (a[x] = (a[x] || 0) + 1, a), {})));

  // two tabs, two different request ids at once: one claim, the other claim_pending
  const tabs = await parallelSvc(2, (c) => c.query("select public.bingo_submit_claim($1,$2,$3)", [B.h, B.row0, crypto.randomUUID()]));
  check("BingoSnap: two tabs submitting at once -> one claim, the other 'claim_pending'", tabs.filter((x) => !x?.error).length === 1 && tabs.some((x) => /claim_pending/.test(x?.error ?? "")) && (await countRows("bingo_submissions", "player_id=$1", [B.id])) === 1);

  // arrived in time, but queued behind a lock until after deadline + grace: still accepted, stamped with its arrival
  await admin.query("update public.bingo_games set hunt_ends_at = clock_timestamp() + interval '1 second' where game_id=$1", [g.gameId]);
  const blocker = await conn(); await blocker.query("begin"); await blocker.query("select 1 from public.games where id=$1 for update", [g.gameId]);
  const cc = await conn(); await asSvc(cc);
  const queued = cc.query("select public.bingo_submit_claim($1,$2,$3)", [C.h, C.row0, crypto.randomUUID()]).then(() => "ok", (e) => e.message);
  await new Promise((r) => setTimeout(r, 3600));   // the deadline and the 2 s grace pass while it waits
  const lateConn = await conn(); await asSvc(lateConn);
  const late = lateConn.query("select public.bingo_submit_claim($1,$2,$3)", [C.h, C.row0, crypto.randomUUID()]).then(() => "ok", (e) => e.message);
  await new Promise((r) => setTimeout(r, 200));
  await blocker.query("commit"); await blocker.end();
  const [q, l] = [await queued, await late]; await cc.end(); await lateConn.end();
  const st = (await admin.query("select s.submitted_at <= b.hunt_ends_at as on_time from public.bingo_submissions s join public.bingo_games b on b.game_id = s.game_id where s.player_id=$1", [C.id])).rows;
  check("BingoSnap: a claim that ARRIVED before the deadline but waited on a lock is accepted (stamped with its arrival)", q === "ok" && st.length === 1 && st[0].on_time, `queued=${q}`);
  const settleHint = (await admin.query("select topic, payload from realtime.messages where topic in ($1,$2) order by id desc limit 1", [`game:${g.gameId}`, `game:${g.gameId}:host`])).rows[0];
  check("Phase 2: that claim also moved the expired hunt to review, so its hint goes to EVERYONE (not host-only)",
    settleHint.topic === `game:${g.gameId}` && settleHint.payload.scope === "all" && settleHint.payload.phase === "reviewing", JSON.stringify(settleHint));
  check("BingoSnap: a claim arriving after the deadline + grace is refused, even if the earlier one is still being processed", /hunt_over|claim_pending/.test(l), l.slice(0, 60)); }

// BingoSnap host review (Phase 9): double taps, two host tabs, undo racing a resubmission.
{ const u = (await admin.query("insert into auth.users (email) values ('bingo-review-race@x.io') returning id")).rows[0].id;
  await admin.query("update auth.users set email_confirmed_at = now() where id=$1", [u]);
  const c0 = await conn(); await asUser(c0, u);
  const g = (await c0.query("select public.bingo_save_board(null,0,'Review race',3,'traditional',false,600,'ranked',$1,true) s",
    [Array.from({ length: 9 }, (_, i) => "c" + i)])).rows[0].s;
  const code = (await admin.query("select join_code c from public.games where id=$1", [g.gameId])).rows[0].c;
  for (const n of ["A", "B", "C"]) await admin.query("select * from public.join_game($1,$2,$3,null)", [code, n, sha("review-race-" + n)]);
  await c0.query("select public.bingo_start($1,$2)", [g.gameId, await ver(g.gameId)]);
  await admin.query("update public.bingo_games set hunt_started_at = clock_timestamp() - interval '1 minute', hunt_ends_at = clock_timestamp() + interval '9 minutes' where game_id=$1", [g.gameId]);
  const claimOf = async (n, row = 0) => {
    const id = (await admin.query("select id from public.players where game_id=$1 and nickname=$2", [g.gameId, n])).rows[0].id;
    const cells = (await admin.query("select array_agg(cell_id order by pos) ids from public.bingo_layout($1,$2) where row_no = $3", [g.gameId, id, row])).rows[0].ids;
    await asSvc(admin); await admin.query("select public.bingo_submit_claim($1,$2,$3)", [sha("review-race-" + n), cells, crypto.randomUUID()]); await admin.query("reset role");
    return { player: id, sub: (await admin.query("select id from public.bingo_submissions where player_id=$1 order by attempt_no desc limit 1", [id])).rows[0].id, cells };
  };
  const hostConns = async (k) => { const cs = await Promise.all(Array.from({ length: k }, conn)); await Promise.all(cs.map((c) => asUser(c, u))); return cs; };
  const settle = async (cs, fn) => { const out = await Promise.allSettled(cs.map(fn)); await Promise.all(cs.map((c) => c.end())); return out.map((o) => (o.status === "fulfilled" ? "ok" : o.reason.message.replace(/^.*?(already_reviewed|already_pending|claim_superseded|claim_pending).*$/, "$1"))); };
  const tally = (xs) => JSON.stringify(xs.reduce((a, x) => (a[x] = (a[x] || 0) + 1, a), {}));

  const a = await claimOf("A");
  const ten = await settle(await hostConns(10), (c) => c.query("select public.bingo_review_submission($1,'verify',null)", [a.sub]));
  check("BingoSnap review: 10 simultaneous Verify taps -> one decision, nine already_reviewed", ten.filter((x) => x === "ok").length === 1 && ten.filter((x) => x === "already_reviewed").length === 9, tally(ten));

  const b = await claimOf("B");
  const [vr, rj] = await settle(await hostConns(2), (c, i) => c.query("select public.bingo_review_submission($1,$2,$3)", [b.sub, i ? "reject" : "verify", i ? "blurry" : null]));
  const bFinal = (await admin.query("select status::text s from public.bingo_submissions where id=$1", [b.sub])).rows[0].s;
  check("BingoSnap review: Verify vs Reject from two host tabs -> exactly one wins and the row matches it",
    [vr, rj].filter((x) => x === "ok").length === 1 && bFinal === (vr === "ok" ? "verified" : "rejected"), `verify=${vr} reject=${rj} final=${bFinal}`);

  // Undo of a rejection racing the player's new claim: never two open claims for one player.
  const c = await claimOf("C");
  await c0.end();
  const h1 = await conn(); await asUser(h1, u); await h1.query("select public.bingo_review_submission($1,'reject','blurry')", [c.sub]); await h1.end();
  const cells2 = (await admin.query("select array_agg(cell_id order by pos) ids from public.bingo_layout($1,$2) where row_no = 1", [g.gameId, c.player])).rows[0].ids;
  const [hc] = await hostConns(1);
  const pc = await conn(); await asSvc(pc);
  const [undo, resub] = await Promise.allSettled([
    hc.query("select public.bingo_review_submission($1,'reset',null)", [c.sub]),
    pc.query("select public.bingo_submit_claim($1,$2,$3)", [sha("review-race-C"), cells2, crypto.randomUUID()]),
  ]);
  await hc.end(); await pc.end();
  const open = await countRows("bingo_submissions", "player_id=$1 and status in ('pending','verified')", [c.player]);
  check("BingoSnap review: Undo racing a resubmission -> exactly one open claim, the loser refused cleanly",
    open === 1 && [undo, resub].filter((o) => o.status === "fulfilled").length === 1
      && [undo, resub].every((o) => o.status === "fulfilled" || /claim_superseded|claim_pending|duplicate key/.test(o.reason.message)),
    `undo=${undo.status === "fulfilled" ? "ok" : undo.reason.message.slice(0, 40)} resubmit=${resub.status === "fulfilled" ? "ok" : resub.reason.message.slice(0, 40)} open=${open}`); }

await admin.end(); await ep.stop();
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`); process.exit(results.every(Boolean) ? 0 : 1);
