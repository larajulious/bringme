// Phase 3 benchmark (local, repeatable): photo Storage + signed-URL work of one Bring Me game, BEFORE vs AFTER.
//
//   npm i --no-save embedded-postgres pg && npm run bench:photos            (N = 10, 30, 50 + an expiry scenario)
//   BENCH_N=10 npm run bench:photos      BENCH_RANGE=ignored npm run bench:photos      BENCH_OUT=results.json
//
// REAL: PostgreSQL (embedded) with every migration (Phase 1 + 2), the real sync core and refresh keys, every database
// query a route makes (counted), and in AFTER mode the real Phase 3 modules (listSubmissionPhotos, SubmissionPhotoLoader,
// PhotoUrlCache, probePhoto/readPrefix, SharedSignedUrlCache).
// MOCKED: Supabase Storage (an in-process fake that counts requests, signed paths, issued URL lifetimes and the bytes a
// function buffers; photos are 400 KB, streams arrive in 64 KiB chunks; Range honoured unless BENCH_RANGE=ignored).
// MODELLED (BEFORE): the pre-Phase-3 routes and host/presenter loaders, call for call (see the functions marked legacy).
// Not emulated: network latency, real Storage latency/limits, Vercel instances (the winner-photo cache is modelled as ONE
// warm instance; with k instances it signs up to k times), the 30 s safety re-read, focus/visibility events.
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { GameSyncCore, guestRoute, routeEverything } from "../../lib/game/sync.ts";
import { rosterKey, roundsKey, submissionsKey } from "../../lib/game/refresh-keys.ts";
import { PHOTO_URL_TTL_SECONDS, listSubmissionPhotos } from "../../lib/game/submission-photos.ts";
import { PhotoUrlCache, SubmissionPhotoLoader } from "../../lib/game/photo-url-cache.ts";
import { probePhoto } from "../../lib/players/photo-probe.ts";
import { SharedSignedUrlCache } from "../../lib/players/shared-url-cache.ts";

let EmbeddedPostgres, pg;
try { EmbeddedPostgres = (await import("embedded-postgres")).default; pg = (await import("pg")).default; }
catch { console.error("Missing optional deps. Run: npm i --no-save embedded-postgres pg"); process.exit(2); }

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SIZES = (process.env.BENCH_N ?? "10,30,50").split(",").map(Number);
const RANGE_HONOURED = process.env.BENCH_RANGE !== "ignored";
const PHOTO_BYTES = 400 * 1024;   // assumption: a typical 1600 px JPEG at the app's quality ladder (cap 1.5 MB)
const CHUNK = 64 * 1024;
const ROUNDS = 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");
const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

async function makeDb(name) {
  const PORT = 58000 + Math.floor(Math.random() * 800);
  const ep = new EmbeddedPostgres({ databaseDir: fs.mkdtempSync((process.env.TMPDIR || "/tmp") + "/bm-photo-"), user: "postgres", password: "pw", port: PORT, persistent: false, onLog: () => {}, onError: () => {} });
  await ep.initialise(); await ep.start(); await ep.createDatabase(name);
  const c = new pg.Client({ host: "localhost", port: PORT, user: "postgres", password: "pw", database: name }); await c.connect();
  await c.query(fs.readFileSync(ROOT + "/tests/db/supabase-shim.sql", "utf8"));
  for (const f of fs.readdirSync(ROOT + "/supabase/migrations").filter((n) => n.endsWith(".sql")).sort()) await c.query(fs.readFileSync(`${ROOT}/supabase/migrations/${f}`, "utf8"));
  const host = (await c.query("insert into auth.users (email) values ('bench@x.io') returning id")).rows[0].id;
  await c.query("set role service_role"); await c.query("select public.admin_set_subscription($1,'activate','pro',30,null)", [host]); await c.query("reset role");
  const pool = (setup) => { const p = new pg.Pool({ host: "localhost", port: PORT, user: "postgres", password: "pw", database: name, max: 12 }); p.on("connect", (cl) => { void cl.query(setup); }); return p; };
  const svc = pool("set role service_role");
  const hostPool = pool(`set role authenticated; select set_config('request.jwt.claim.sub','${host}',false), set_config('request.jwt.claims','${JSON.stringify({ sub: host })}',false)`);
  return { name, admin: c, svc, hostPool, host, ep };
}

/** In-process stand-in for Supabase Storage. Counts everything; never pretends to know real latencies. */
function mockStorage() {
  const S = { requests: { remove: 0, uploadUrl: 0, upload: 0, info: 0, download: 0, rangedGet: 0, signBatch: 0, signOne: 0 }, signed: 0, buffered: 0, maxBufferedPerCompletion: 0, issued: new Map() };
  const photo = new Uint8Array(PHOTO_BYTES); photo.set([0xff, 0xd8, 0xff, 0xe0]);
  const urlFor = (path, ttl) => { const u = `https://storage.mock/sign/${path}?t=${crypto.randomUUID()}`; S.issued.set(u, performance.now() + ttl * 1000); S.signed++; return u; };
  const streamOf = (bytes) => new ReadableStream({ pull(ctl) { const off = this.off ?? 0; if (off >= bytes.length) return ctl.close(); ctl.enqueue(bytes.subarray(off, off + CHUNK)); this.off = off + CHUNK; } });
  return {
    S,
    signMany: async (paths, ttl) => { S.requests.signBatch++; return new Map(paths.map((p) => [p, urlFor(p, ttl)])); },
    signOne: async (path, ttl) => { S.requests.signOne++; return urlFor(path, ttl); },
    info: async () => { S.requests.info++; return { size: PHOTO_BYTES, contentType: "image/jpeg" }; },
    downloadAll: async () => { S.requests.download++; return photo; },               // legacy: the whole object, as a Blob
    stream: async (n) => { S.requests.rangedGet++; return { body: streamOf(RANGE_HONOURED ? photo.subarray(0, n) : photo), abort: () => {} }; },
    begin: () => { S.requests.remove++; S.requests.uploadUrl++; },
    upload: () => { S.requests.upload++; },
  };
}

async function runGame(db, n, mode, { ttl = PHOTO_URL_TTL_SECONDS, idleReviewMs = 0, label = "" } = {}) {
  const after = mode === "after";
  const st = mockStorage();
  const DBC = { begin: 0, complete: 0, listing: 0, winnerPhoto: 0, results: 0, sync: 0, actions: 0 };
  const VER = { listing: 0, complete: 0, winnerPhoto: 0, results: 0 };
  const q = async (pool, sql, args, bucket) => { if (bucket) DBC[bucket]++; return (await pool.query(sql, args)).rows; };
  await db.admin.query("update public.games set status='canceled' where owner_id=$1 and status in ('draft','lobby','live')", [db.host]);
  const g = (await q(db.hostPool, "select * from public.create_game_with_rounds('bench', $1)", [["a", "b", "c"]], "actions"))[0];
  const gameId = g.game_id;
  const ver = async () => Number((await db.admin.query("select state_version v from public.games where id=$1", [gameId])).rows[0].v);
  const lat = { hostPhoto: [] };
  const pendingPhoto = new Map(); // playerId -> completed at
  let expiredShownSamples = 0, missingShownSamples = 0, displaySamples = 0;

  // ------------------------------------------------------------ listing routes
  async function legacyListing(view) {   // legacy: host_game_state + round_ranking + sign EVERY photo (even an empty list)
    void view; VER.listing++;
    const s = (await q(db.hostPool, "select public.host_game_state($1) s", [gameId], "listing"))[0].s;
    if (!s.round?.id) return { status: "ok", rows: [], ttlSeconds: ttl };
    const rows = await q(db.hostPool, "select * from public.round_ranking($1)", [s.round.id], "listing");
    const urls = await st.signMany(rows.map((r) => r.storage_path), ttl);
    return { status: "ok", ttlSeconds: ttl, rows: rows.map((r) => ({ submissionId: r.submission_id, playerId: r.player_id, nickname: r.nickname, status: r.status, photoKey: `submissions/${r.storage_path}`, photoUrl: urls.get(r.storage_path) ?? null })) };
  }
  async function newListing(view, have) {   // the real Phase 3 logic with real queries and the mocked signer
    VER.listing++;
    const listing = await listSubmissionPhotos({
      game: async () => { const r = (await q(db.hostPool, "select current_round_id, phase from public.games where id=$1 and owner_id=$2", [gameId, db.host], "listing"))[0]; return r ? { currentRoundId: r.current_round_id, phase: r.phase } : null; },
      ranking: async (roundId) => q(db.hostPool, "select * from public.round_ranking($1)", [roundId], "listing"),
      officialWinner: async (roundId) => { const r = (await q(db.hostPool, "select winner_player_id, winner_confirmed_at from public.game_rounds where id=$1", [roundId], "listing"))[0]; return r?.winner_confirmed_at ? r.winner_player_id : null; },
      sign: (paths, t) => st.signMany(paths, t),
    }, { gameId, view, have: new Set(have), ttlSeconds: ttl });
    return listing ? { status: "ok", rows: listing.submissions, ttlSeconds: listing.ttlSeconds } : { status: "fatal" };
  }

  // ------------------------------------------------------------ host console / presenter photo lists
  function photoList(view) {
    const pl = { rows: null, enabled: false, dep: null, loader: null };
    const onRows = (rows) => {
      pl.rows = rows;
      if (view === "host") for (const r of rows) if (r.photoUrl && pendingPhoto.has(r.playerId)) { lat.hostPhoto.push(performance.now() - pendingPhoto.get(r.playerId)); pendingPhoto.delete(r.playerId); }
    };
    pl.update = (enabled, dep) => {
      if (!enabled) { if (pl.enabled) { pl.loader?.stop?.(); pl.loader = null; pl.rows = null; } pl.enabled = false; pl.dep = null; return; }
      if (!pl.enabled) {
        pl.enabled = true;
        pl.loader = after
          ? new SubmissionPhotoLoader({ fetchListing: (have) => newListing(view, have), onRows, cache: new PhotoUrlCache() })
          : { load: async () => { onRows((await legacyListing(view)).rows); } };   // legacy: every trigger runs, no reuse
      }
      if (dep !== pl.dep) { pl.dep = dep; track(pl.loader.load()); }
    };
    return pl;
  }
  const consolePhotos = photoList("host");
  const presenterPhotos = photoList(after ? "presenter" : "host");   // legacy presenter used the host listing (all photos)

  // ------------------------------------------------------------ clients (Phase 2 sync, identical in both modes)
  let inflight = 0;
  const track = (p) => { inflight++; return Promise.resolve(p).finally(() => inflight--); };
  const clients = [];
  function makeClient(kind, initial, fetchFn, onState) {
    const cl = { kind, seen: new Set(), lastV: initial.version, stopped: false };
    cl.core = new GameSyncCore({
      initial, fetch: async () => track(fetchFn()), onUnauthorized: () => { cl.stopped = true; },
      onState: (s) => { cl.lastV = s.version; cl.seen.add(`${s.phase}:${s.round?.id ?? "-"}`); onState?.(s, cl); },
      route: kind === "player" ? guestRoute(() => false) : routeEverything, debounce: { baseMs: 1000, jitterMs: 1500 },
    });
    cl.topics = kind === "player" ? [`game:${gameId}`] : [`game:${gameId}`, `game:${gameId}:host`];
    clients.push(cl); return cl;
  }
  const inRound = (s) => ["active", "reviewing", "winner_announced"].includes(s.phase) && Boolean(s.round);
  const sideLists = (who, s, cl) => {
    const deps = { roster: rosterKey(s), rounds: roundsKey(s) }; const prev = cl.deps ?? {};
    if (deps.roster !== prev.roster) track(q(db.hostPool, "select id, nickname from public.players where game_id=$1 and kicked_at is null order by joined_at", [gameId], "sync"));
    if (who === "console" && deps.rounds !== prev.rounds) track(q(db.hostPool, "select round_no, prompt, status from public.game_rounds where game_id=$1 order by round_no", [gameId], "sync"));
    cl.deps = deps;
    (who === "console" ? consolePhotos : presenterPhotos).update(inRound(s), submissionsKey(s));
  };
  const hostFetch = async () => ({ status: "ok", state: (await q(db.hostPool, "select public.host_game_state($1) s", [gameId], "sync"))[0].s });
  const init = (await q(db.hostPool, "select public.host_game_state($1) s", [gameId]))[0].s;
  const consoleCl = makeClient("host", init, hostFetch, (s, cl) => sideLists("console", s, cl));
  makeClient("presenter", init, hostFetch, (s, cl) => sideLists("presenter", s, cl));   // the projector tab
  const players = [];
  const playerFetch = (hash) => async () => ({ status: "ok", state: (await q(db.svc, "select public.player_game_state($1) s", [hash], "sync"))[0].s });

  // Realtime emulation
  let lastId = Number((await db.admin.query("select coalesce(max(id),0) m from realtime.messages")).rows[0].m);
  let polling = true;
  const poller = (async () => {
    while (polling) {
      for (const m of (await db.admin.query("select id, topic, payload from realtime.messages where id > $1 and topic in ($2,$3) order by id", [lastId, `game:${gameId}`, `game:${gameId}:host`])).rows) {
        lastId = Number(m.id);
        for (const cl of clients) if (!cl.stopped && cl.topics.includes(m.topic)) cl.core.handleSignal(m.payload, m.topic.endsWith(":host") ? "host" : "game");
      }
      await sleep(3);
    }
  })();
  // what the host console currently SHOWS: sample for expired / missing pictures
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      if (consolePhotos.rows) for (const r of consolePhotos.rows) {
        if (!r.photoKey) continue;
        displaySamples++;
        if (!r.photoUrl) missingShownSamples++;
        else if ((st.S.issued.get(r.photoUrl) ?? 0) < performance.now()) expiredShownSamples++;
      }
      await sleep(200);
    }
  })();
  const quiet = async (minMs = 150) => { let calm = 0; while (calm < minMs) { await sleep(10); calm = inflight === 0 ? calm + 10 : 0; } };
  const hostAct = async (action, winner = null) => {
    const s = (await q(db.hostPool, "select public.game_transition($1,$2,$3,$4) s", [gameId, action, await ver(), winner], "actions"))[0].s;
    consoleCl.core.applyIfNewer(s); await quiet();
  };

  // ------------------------------------------------------------ player routes
  async function complete(p, round, attempt) {
    VER.complete++;
    if (!after) {   // legacy: full snapshot, info, settings, FULL download, then the RPC
      const me = (await q(db.svc, "select public.player_game_state($1) s", [p.hash], "complete"))[0].s;
      if (me.me.hasSubmitted && me.round?.id === round) return;
      await st.info();
      await q(db.svc, "select max_photo_size_mb from public.platform_settings where id", [], "complete");
      const blob = await st.downloadAll();
      st.S.buffered += blob.byteLength; st.S.maxBufferedPerCompletion = Math.max(st.S.maxBufferedPerCompletion, blob.byteLength);
    } else {        // Phase 3: identity row, duplicate check, then a bounded probe
      const me = (await q(db.svc, "select id, game_id, kicked_at from public.players where token_hash=$1", [p.hash], "complete"))[0];
      const dup = await q(db.svc, "select claimed_elapsed_ms, timing_status from public.submissions where round_id=$1 and player_id=$2", [round, me.id], "complete");
      if (dup.length) return;
      const v = await probePhoto({
        info: () => st.info(),
        maxBytes: async () => ((await q(db.svc, "select max_photo_size_mb from public.platform_settings where id", [], "complete"))[0].max_photo_size_mb) * 1048576,
        stream: (k) => st.stream(k),
      });
      if (!v.ok) throw new Error("probe failed: " + v.reason);
      st.S.buffered += v.bytesBuffered; st.S.maxBufferedPerCompletion = Math.max(st.S.maxBufferedPerCompletion, v.bytesBuffered);
    }
    await q(db.svc, "select public.complete_submission($1,$2,$3,'{}')", [p.hash, round, attempt], "complete");
  }
  const winnerCache = new SharedSignedUrlCache({ ttlSeconds: 120, minRemainingMs: 60_000 });
  async function winnerPhoto(p) {
    VER.winnerPhoto++;
    const path = (await q(db.svc, "select public.player_winner_photo($1) p", [p.hash], "winnerPhoto"))[0].p;
    if (!path) return null;
    return after ? winnerCache.get(`submissions/${path}`, () => st.signOne(path, 120)) : st.signOne(path, 120);
  }
  async function results() {   // FinishedResults + presenter final screen (unchanged by Phase 3)
    VER.results++;
    const rows = await q(db.hostPool, "select * from public.game_results($1)", [gameId], "results");
    const paths = rows.map((r) => r.winner_path).filter(Boolean);
    if (paths.length) await st.signMany(paths, 120);
  }

  // ------------------------------------------------------------ the game
  await Promise.all(Array.from({ length: n }, (_, i) => sleep(Math.random() * 3000).then(async () => {
    const hash = sha(`${db.name}-${mode}-${label}-${n}-${i}-${gameId}`);
    await q(db.svc, "select * from public.join_game($1,$2,$3,null)", [g.code, `P${i}`, hash], "actions");
    const s = (await q(db.svc, "select public.player_game_state($1) s", [hash], "sync"))[0].s;
    const cl = makeClient("player", s, playerFetch(hash)); cl.hash = hash; players.push(cl);
    await cl.core.resync();
  })));
  await sleep(2700); await quiet();
  let photosOk = 0, winnersShown = 0;
  for (let r = 1; r <= ROUNDS; r++) {
    if (r === 1) await hostAct("start_game");
    await hostAct("start_countdown");
    await hostAct("start_round");
    await db.admin.query("update public.game_rounds set opened_at = clock_timestamp() - interval '3 seconds' where game_id=$1 and status='open'", [gameId]);
    const round = (await db.admin.query("select current_round_id r from public.games where id=$1", [gameId])).rows[0].r;
    const live = players.filter((p) => !p.stopped);
    await Promise.all(live.map(async (p, i) => {
      await sleep(Math.random() * 6000);
      const a = crypto.randomUUID();
      await q(db.svc, "select public.begin_submission($1,$2,$3,$4,'{\"syncRttMs\":30,\"syncAgeMs\":500}')", [p.hash, round, a, 3000 + i], "begin"); st.begin();
      await sleep(300 + Math.random() * 1700); st.upload();
      await complete(p, round, a);
      const pid = (await db.admin.query("select id from public.players where token_hash=$1", [p.hash])).rows[0].id;
      pendingPhoto.set(pid, performance.now()); photosOk++;
    }));
    await quiet();
    if (r === 1) {
      const victim = players.at(-1);
      const id = (await db.admin.query("select id from public.players where token_hash=$1", [victim.hash])).rows[0].id;
      await q(db.hostPool, "update public.players set kicked_at = now() where id=$1", [id], "actions"); await quiet(); victim.stopped = true;
    }
    await hostAct("close_submissions");
    await hostAct("move_to_review");
    if (idleReviewMs) await sleep(idleReviewMs);   // the host looks at the photos before deciding
    const subs = (await db.admin.query("select s.id from public.submissions s join public.players p on p.id=s.player_id where s.round_id=$1 and p.kicked_at is null order by s.rank_ms", [round])).rows;
    for (const s of subs) {
      const res = (await q(db.hostPool, "select public.review_submission($1,'approve') s", [s.id], "actions"))[0].s;
      consoleCl.core.applyIfNewer(res);
      if (!after) track(consolePhotos.loader.load());   // legacy host-console: explicit reload after every decision
      await sleep(40);
    }
    await quiet();
    const winner = (await db.admin.query("select s.player_id from public.submissions s join public.players p on p.id=s.player_id where s.round_id=$1 and p.kicked_at is null order by s.rank_ms limit 1", [round])).rows[0].player_id;
    await hostAct("announce_winner", winner);
    const urls = await Promise.all(players.filter((p) => !p.stopped).map((p) => winnerPhoto(p)));
    winnersShown += urls.filter(Boolean).length;
    await sleep(200); await quiet();
    await hostAct(r < ROUNDS ? "next_round" : "end_game");
  }
  await results(); await results();   // the host's results page and the presenter's final screen
  await sleep(300); await quiet();
  polling = false; sampling = false; await poller; await sampler;
  consolePhotos.update(false); presenterPhotos.update(false);

  const finalV = await ver();
  const active = players.filter((p) => !p.stopped);
  const rounds = (await db.admin.query("select id from public.game_rounds where game_id=$1 and status <> 'pending' order by round_no", [gameId])).rows.map((x) => x.id);
  let missed = 0;
  for (const p of active) { for (const rid of rounds) for (const ph of ["countdown", "active", "reviewing", "winner_announced"]) if (!p.seen.has(`${ph}:${rid}`)) missed++; if (!p.seen.has("finished:-")) missed++; }
  for (const cl of clients) cl.core.stop();
  const storageTotal = Object.values(st.S.requests).reduce((a, b) => a + b, 0);
  return {
    mode, n, label, ttl, rangeHonoured: RANGE_HONOURED, photos: photosOk,
    storage: { ...st.S.requests, total: storageTotal, signedPaths: st.S.signed },
    memory: { bufferedTotal: st.S.buffered, maxPerCompletion: st.S.maxBufferedPerCompletion },
    db: DBC, photoDb: DBC.begin + DBC.complete + DBC.listing + DBC.winnerPhoto + DBC.results, invocations: VER,
    hostPhotoMs: { p50: pct(lat.hostPhoto, 50), p95: pct(lat.hostPhoto, 95), max: pct(lat.hostPhoto, 100), samples: lat.hostPhoto.length },
    display: { samples: displaySamples, expired: expiredShownSamples, missing: missingShownSamples },
    winnersShown, missed, staleAtEnd: active.filter((p) => p.lastV !== finalV).length,
  };
}

const results = [];
for (const n of SIZES) {
  for (const mode of ["before", "after"]) {
    const db = await makeDb(`bm_${mode}_${n}`);
    const r = await runGame(db, n, mode);
    results.push(r);
    console.log(`N=${n} ${mode.padEnd(6)} signedPaths=${r.storage.signedPaths} storageReq=${r.storage.total} (sign batches ${r.storage.signBatch}, single ${r.storage.signOne}, info ${r.storage.info}, download ${r.storage.download}, ranged ${r.storage.rangedGet}) buffered=${(r.memory.bufferedTotal / 1048576).toFixed(1)}MiB maxPerCompletion=${r.memory.maxPerCompletion}B photoDB=${r.photoDb} hostPhoto p95=${Math.round(r.hostPhotoMs.p95 ?? 0)}ms expiredShown=${r.display.expired} missing=${r.display.missing} winners=${r.winnersShown} missed=${r.missed} stale=${r.staleAtEnd}`);
    await db.svc.end(); await db.hostPool.end(); await db.admin.end(); await db.ep.stop();
  }
}
if (process.env.BENCH_EXPIRY !== "0") {   // expiry recovery: 10 s URLs, the host studies the photos for 25 s before deciding
  for (const mode of ["before", "after"]) {
    const db = await makeDb(`bm_exp_${mode}`);
    const r = await runGame(db, 30, mode, { ttl: 10, idleReviewMs: 25_000, label: "expiry" });
    results.push(r);
    console.log(`EXPIRY N=30 ${mode.padEnd(6)} ttl=10s idle=25s: signedPaths=${r.storage.signedPaths} sign batches=${r.storage.signBatch} shown samples=${r.display.samples} expired=${r.display.expired} missing=${r.display.missing} missed=${r.missed}`);
    await db.svc.end(); await db.hostPool.end(); await db.admin.end(); await db.ep.stop();
  }
}
if (process.env.BENCH_OUT) fs.writeFileSync(process.env.BENCH_OUT, JSON.stringify(results, null, 2));
