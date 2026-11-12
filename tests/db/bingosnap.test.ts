import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";

import { generatePlayerToken, hashToken } from "../../lib/players/token.ts";
import { as, createDb, createUser, endCurrentPass, errorOf, subscribe } from "./harness.ts";

type Cell = { pos: number; row: number; col: number; cellId: string; challenge: string | null; isFree: boolean };
type Sub = { id: string; attempt: number; status: string; pattern: string; cellIds: string[]; rejectionReason: string | null };
type State = {
  version: number; status: string; lifecycle: string; phase: string; gameType: string; playerCount: number; maxPlayers: number;
  board: { size: number; winMode: string; winnerRule: string; freeSpace: boolean; huntOver: boolean; huntEndsAt: string | null; resultsAt: string | null };
  counts: { pending: number; verified: number; rejected: number };
  results: null | { winnerRule: string; entries: { rank: number; nickname: string; pattern: string }[] };
  cells?: { id: string; challenge: string | null; isFree: boolean }[] | null;
  players?: { id: string; nickname: string; state: string }[];
  submissions?: { id: string; nickname: string; status: string; rank: number | null; rejectionReason: string | null; cells: unknown }[];
  me?: { id: string; state: string; layout: Cell[] | null; submissions: Sub[]; attemptsLeft: number; canClaim: boolean };
};

let db: PGlite;
let host: string;
let other: string;
const svc = { role: "service_role" } as const;
const user = (sub: string) => ({ role: "authenticated", sub }) as const;

const challenges = (n: number, tag = "c") => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`);

before(async () => {
  db = await createDb();
  host = await createUser(db, "bingo-host@example.com");
  other = await createUser(db, "bingo-other@example.com");
  await subscribe(db, host, { plan: "pro" });
  await subscribe(db, other, { plan: "pro" });
});
after(async () => { await db.close(); });

type G = { id: string; code: string; tokens: Record<string, string>; ids: Record<string, string> };
type Opts = { size?: number; mode?: string; free?: boolean; rule?: string; duration?: number; items?: string[] };

/** Superuser: close the owner's open games so plan open-game limits don't leak between tests. */
async function freeSlots(owner: string) {
  await db.query("select set_config('bingosnap.engine','on',false)");
  await db.query("update public.games set status='canceled' where owner_id=$1 and status in ('draft','lobby','live')", [owner]);
  await db.query("select set_config('bingosnap.engine','off',false)");
}

const create = (owner: string, o: Opts = {}) => {
  const size = o.size ?? 3;
  const free = o.free ?? false;
  return as(db, user(owner), async () => (await db.query<{ game_id: string; code: string }>(
    "select * from public.create_bingosnap_game($1,$2,$3,$4,$5,$6,$7)",
    ["Bingo night", size, o.mode ?? "traditional", free, o.duration ?? 600, o.rule ?? "ranked",
      o.items ?? challenges(size * size - (free ? 1 : 0))])).rows[0]);
};

async function join(code: string, name: string) {
  const token = generatePlayerToken();
  const r = await as(db, svc, () => db.query<{ player_id: string }>("select * from public.join_game($1,$2,$3,null)", [code, name, hashToken(token)]));
  return { token, id: r.rows[0].player_id };
}

async function newBingo(o: Opts = {}, names = ["Ann", "Bo", "Cy"], owner = host): Promise<G> {
  await freeSlots(owner);
  const g = await create(owner, o);
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  for (const n of names) {
    const j = await join(g.code, n);
    tokens[n] = j.token; ids[n] = j.id;
  }
  return { id: g.game_id, code: g.code, tokens, ids };
}

const ver = async (id: string) => Number((await db.query<{ v: string }>("select state_version::text v from public.games where id=$1", [id])).rows[0].v);
const act = async (g: G, action: string, opts: { winner?: string | null; sub?: string; expected?: number } = {}) => {
  const v = opts.expected ?? (await ver(g.id));
  return as(db, user(opts.sub ?? host), async () =>
    (await db.query<{ s: State }>("select public.bingo_transition($1,$2,$3,$4) s", [g.id, action, v, opts.winner ?? null])).rows[0].s);
};
const playerView = async (g: G, who = "Ann") =>
  (await as(db, svc, () => db.query<{ s: State }>("select public.bingo_player_state($1) s", [hashToken(g.tokens[who])]))).rows[0].s;
const hostView = async (g: G, view = "host", sub = host) =>
  (await as(db, user(sub), () => db.query<{ s: State }>("select public.bingo_host_state($1,$2) s", [g.id, view]))).rows[0].s;
const claim = async (g: G, who: string, cellIds: string[]) =>
  (await as(db, svc, () => db.query<{ s: State }>("select public.bingo_submit_claim($1,$2) s", [hashToken(g.tokens[who]), cellIds]))).rows[0].s;
const review = async (submission: string, decision: string, reason: string | null = null, sub = host) =>
  (await as(db, user(sub), () => db.query<{ s: State }>("select public.bingo_review_submission($1,$2,$3) s", [submission, decision, reason]))).rows[0].s;

/** Lobby → live → countdown → hunt; the official start is moved to the past so claims are accepted now. */
async function toHunt(g: G, sub = host) {
  await act(g, "start_game", { sub });
  await act(g, "start_countdown", { sub });
  await act(g, "start_hunt", { sub });
  await db.query("update public.bingo_games set hunt_started_at = clock_timestamp() - interval '1 second' where game_id=$1", [g.id]);
}
/** Deadline `secondsAgo` in the past (2 s grace applies). */
const expireHunt = (g: G, secondsAgo: number) =>
  db.query("update public.bingo_games set hunt_started_at = clock_timestamp() - interval '1 hour', hunt_ends_at = clock_timestamp() - make_interval(secs => $2) where game_id=$1", [g.id, secondsAgo]);

const layout = async (g: G, who: string) => (await playerView(g, who)).me!.layout!;
const rowCells = (l: Cell[], r: number) => l.filter((c) => c.row === r && !c.isFree).map((c) => c.cellId);
const colCells = (l: Cell[], c: number) => l.filter((x) => x.col === c && !x.isFree).map((x) => x.cellId);
const lastSub = async (g: G, who: string) => { const s = (await playerView(g, who)).me!.submissions; return s[s.length - 1]; };

describe("schema & isolation from Bring Me", () => {
  it("existing and new Bring Me games are game_type bring_me; game_type is immutable and not client-writable", async () => {
    await freeSlots(host);
    const bm = await as(db, user(host), async () => (await db.query<{ game_id: string }>("select * from public.create_game_with_rounds('Classic', $1)", [["a hat"]])).rows[0]);
    assert.equal((await db.query<{ t: string }>("select game_type::text t from public.games where id=$1", [bm.game_id])).rows[0].t, "bring_me");
    assert.match((await errorOf(db.query("update public.games set game_type='bingosnap' where id=$1", [bm.game_id]))) ?? "", /immutable game column/);
    assert.match((await errorOf(as(db, user(host), () => db.query("insert into public.games (owner_id, title, game_type) values ($1,'x','bingosnap')", [host])))) ?? "", /permission denied/);
    assert.match((await errorOf(as(db, user(host), () => db.query("update public.games set game_type='bingosnap' where id=$1", [bm.game_id])))) ?? "", /permission denied/);
  });

  it("Bring Me code paths refuse BingoSnap games (game_transition, rounds, photo intents)", async () => {
    const g = await newBingo();
    // no rounds exist, and none can be added
    assert.match((await errorOf(as(db, user(host), () => db.query("insert into public.game_rounds (game_id, round_no, prompt) values ($1,1,'x')", [g.id])))) ?? "", /wrong_game_type/);
    assert.match((await errorOf(as(db, user(host), async () => db.query("select public.game_transition($1,'start_game',$2)", [g.id, await ver(g.id)])))) ?? "", /no_rounds_left|wrong_game_type/);
    assert.match((await errorOf(as(db, user(host), async () => db.query("select public.game_transition($1,'cancel',$2)", [g.id, await ver(g.id)])))) ?? "", /wrong_game_type/);
    // a direct status write (even by a trusted role) cannot bypass the BingoSnap engine
    assert.match((await errorOf(db.query("update public.games set status='live' where id=$1", [g.id]))) ?? "", /wrong_game_type/);
    // a Bring Me photo intent for a BingoSnap game is impossible (no round; and the insert guard)
    assert.ok(await errorOf(as(db, svc, () => db.query("select public.begin_submission($1,$2,$3,1000,'{}')", [hashToken(g.tokens.Ann), crypto.randomUUID(), crypto.randomUUID()]))));
    assert.match((await errorOf(db.query("insert into public.submission_intents (game_id, round_id, player_id, attempt_id, claimed_elapsed_ms) values ($1, gen_random_uuid(), $2, gen_random_uuid(), 1)", [g.id, g.ids.Ann]))) ?? "", /wrong_game_type|violates/);
    assert.equal((await act(g, "cancel")).status, "cancelled");
  });

  it("the BingoSnap engine refuses Bring Me games and other hosts' games (not found)", async () => {
    await freeSlots(host);
    const bm = await as(db, user(host), async () => (await db.query<{ game_id: string }>("select * from public.create_game_with_rounds('Classic', $1)", [["a hat"]])).rows[0]);
    assert.match((await errorOf(as(db, user(host), () => db.query("select public.bingo_transition($1,'start_game',0)", [bm.game_id])))) ?? "", /game_not_found/);
    assert.match((await errorOf(as(db, user(host), () => db.query("select public.bingo_host_state($1)", [bm.game_id])))) ?? "", /game_not_found/);
    const g = await newBingo();
    assert.match((await errorOf(act(g, "start_game", { sub: other }))) ?? "", /game_not_found/);
    assert.match((await errorOf(hostView(g, "host", other))) ?? "", /game_not_found/);
  });

  it("no BingoSnap table has a column that could hold photo data", async () => {
    const cols = (await db.query<{ c: string }>(
      "select table_name || '.' || column_name c from information_schema.columns where table_schema='public' and table_name like 'bingo_%'")).rows.map((r) => r.c);
    assert.ok(cols.length > 20);
    assert.deepEqual(cols.filter((c) => /photo|image|img|url|path|blob|thumb|exif|base64|bytes|storage|file|hash|mime/i.test(c)), []);
  });

  it("RLS: hosts read only their own BingoSnap rows; guests (anon) read nothing; nobody writes directly", async () => {
    const g = await newBingo();
    const mine = await as(db, user(host), () => db.query("select 1 from public.bingo_cells where game_id=$1", [g.id]));
    assert.equal(mine.rows.length, 9);
    const theirs = await as(db, user(other), () => db.query("select 1 from public.bingo_cells where game_id=$1", [g.id]));
    assert.equal(theirs.rows.length, 0);
    assert.match((await errorOf(as(db, { role: "anon" }, () => db.query("select 1 from public.bingo_games")))) ?? "", /permission denied/);
    for (const sql of [
      "update public.bingo_games set duration_seconds=7200 where game_id=$1",
      "update public.bingo_cells set challenge='x' where game_id=$1",
      "insert into public.bingo_submissions (game_id, player_id, attempt_no, cell_ids, pattern) select $1, id, 1, array[gen_random_uuid(), gen_random_uuid()], 'full' from public.players where game_id=$1 limit 1",
      "delete from public.bingo_cells where game_id=$1",
    ]) {
      assert.match((await errorOf(as(db, user(host), () => db.query(sql, [g.id])))) ?? "", /permission denied/, sql);
    }
  });
});

describe("creation & Game Pass entitlement (shared with Bring Me)", () => {
  it("validates the board server-side", async () => {
    await freeSlots(host);
    const cases: [Opts, RegExp][] = [
      [{ size: 6 }, /invalid_board_size/],
      [{ size: 4, free: true, items: challenges(15) }, /free_space_not_allowed/],
      [{ size: 3, mode: "full_card", free: true, items: challenges(8) }, /free_space_not_allowed/],
      [{ mode: "blackout" }, /invalid_win_mode/],
      [{ rule: "fastest" }, /invalid_winner_rule/],
      [{ duration: 60 }, /invalid_duration/],
      [{ duration: 7201 }, /invalid_duration/],
      [{ items: challenges(8) }, /wrong_challenge_count/],
      [{ free: true, items: challenges(9) }, /wrong_challenge_count/],
      [{ items: [...challenges(8), "C 1"] }, /duplicate_challenge/],
      [{ items: [...challenges(8), "   "] }, /invalid_challenge/],
      [{ items: [...challenges(8), "x".repeat(121)] }, /invalid_challenge/],
    ];
    for (const [o, re] of cases) assert.match((await errorOf(create(host, o))) ?? "", re, JSON.stringify(o));
    assert.equal((await db.query("select 1 from public.games where owner_id=$1 and game_type='bingosnap' and status in ('draft','lobby')", [host])).rows.length, 0, "failed creates leave nothing");
  });

  it("builds the board row-major with the free centre on odd Traditional boards", async () => {
    for (const [size, free, n] of [[3, true, 8], [4, false, 16], [5, true, 24], [5, false, 25]] as const) {
      await freeSlots(host);
      const g = await create(host, { size, free, items: challenges(n) });
      const cells = (await db.query<{ row_no: number; col_no: number; display_order: number; is_free: boolean; challenge: string | null }>(
        "select row_no, col_no, display_order, is_free, challenge from public.bingo_cells where game_id=$1 order by display_order", [g.game_id])).rows;
      assert.equal(cells.length, size * size);
      assert.ok(cells.every((c) => c.display_order === c.row_no * size + c.col_no));
      const freeCells = cells.filter((c) => c.is_free);
      assert.equal(freeCells.length, free ? 1 : 0);
      if (free) assert.equal(freeCells[0].display_order, (size * size - 1) / 2);
      assert.equal((await hostView({ id: g.game_id } as G)).status, "lobby");
    }
  });

  it("needs a Game Pass; the room cap is the pass cap (3 / 10 / 50 / 100)", async () => {
    const none = await createUser(db, "bingo-nopass@example.com");
    assert.match((await errorOf(create(none))) ?? "", /subscription_required/);
    for (const [plan, cap] of [["trial", 3], ["starter", 10], ["party", 50], ["pro", 100]] as const) {
      const u = await createUser(db, `bingo-${plan}@example.com`);
      await subscribe(db, u, { plan });
      const g = await create(u);
      assert.equal((await db.query<{ m: number }>("select max_players m from public.games where id=$1", [g.game_id])).rows[0].m, cap, plan);
    }
  });

  it("shares the plan's open-game limit with Bring Me (Starter: 1 open game)", async () => {
    const u = await createUser(db, "bingo-limit@example.com");
    await subscribe(db, u, { plan: "starter" });
    await as(db, user(u), () => db.query("select * from public.create_game_with_rounds('Classic', $1)", [["a hat"]]));
    assert.match((await errorOf(create(u))) ?? "", /game_limit_reached/);
  });

  it("joins are capacity-checked by the existing trigger; joining closes when the game starts", async () => {
    const u = await createUser(db, "bingo-trialcap@example.com");
    await subscribe(db, u, { plan: "trial" });
    const g = await newBingo({}, ["A", "B", "C"], u);
    assert.match((await errorOf(join(g.code, "D"))) ?? "", /game_full/);
    // reconnect: same cookie restores, no duplicate
    const r = await as(db, svc, () => db.query<{ restored: boolean }>("select * from public.join_game($1,'A',$2,$3)", [g.code, hashToken(generatePlayerToken()), hashToken(g.tokens.A)]));
    assert.equal(r.rows[0].restored, true);
    await act(g, "start_game", { sub: u });
    assert.match((await errorOf(join(g.code, "E"))) ?? "", /game_not_joinable/);
    assert.equal((await hostView(g, "host", u)).playerCount, 3);
  });
});

describe("lifecycle & timer", () => {
  it("draft → lobby → active → completed, with stale-version protection", async () => {
    const g = await newBingo();
    assert.match((await errorOf(act(g, "start_game", { expected: (await ver(g.id)) - 1 }))) ?? "", /stale_state/);
    assert.match((await errorOf(act(g, "start_hunt"))) ?? "", /invalid_transition/);
    const live = await act(g, "start_game");
    assert.deepEqual([live.status, live.lifecycle, live.phase], ["active", "live", "lobby"]);
    const cd = await act(g, "start_countdown");
    assert.equal(cd.phase, "countdown");
    const hunt = await act(g, "start_hunt");
    assert.equal(hunt.phase, "active");
    const b = (await db.query<{ s: Date; e: Date; c: Date }>("select b.hunt_started_at s, b.hunt_ends_at e, g.countdown_ends_at c from public.bingo_games b join public.games g on g.id=b.game_id where b.game_id=$1", [g.id])).rows[0];
    assert.ok(b.s.getTime() >= b.c.getTime(), "official start = end of countdown");
    assert.equal(b.e.getTime() - b.s.getTime(), 600_000);
    assert.equal((await act(g, "end_game")).status, "completed");
    assert.match((await errorOf(act(g, "start_game"))) ?? "", /invalid_transition/);
    const arch = await act(g, "archive");
    assert.ok((arch as unknown as { archivedAt: string }).archivedAt);
  });

  it("start needs ≥1 player and a pass covering everyone; joins/kicks bump the version and broadcast", async () => {
    const empty = await newBingo({}, []);
    assert.match((await errorOf(act(empty, "start_game"))) ?? "", /no_players/);
    const g = await newBingo({}, ["A"]);
    const before = (await db.query<{ n: string }>("select count(*)::text n from realtime.messages where topic=$1", [`game:${g.id}`])).rows[0].n;
    await join(g.code, "B");
    assert.ok(Number((await db.query<{ n: string }>("select count(*)::text n from realtime.messages where topic=$1", [`game:${g.id}`])).rows[0].n) > Number(before));
    const msg = (await db.query<{ p: { version: number } }>("select payload p from realtime.messages where topic=$1 order by id desc limit 1", [`game:${g.id}`])).rows[0].p;
    assert.equal(msg.version, await ver(g.id));
    assert.deepEqual(Object.keys(msg).sort(), ["phase", "version"], "broadcast carries no content");
  });

  it("an expired pass blocks starting, but a hunt already live can finish (D-10)", async () => {
    const u = await createUser(db, "bingo-expiry@example.com");
    await subscribe(db, u, { plan: "starter" });
    const g = await newBingo({}, ["A", "B"], u);
    await act(g, "start_game", { sub: u });
    await act(g, "start_countdown", { sub: u });
    await act(g, "start_hunt", { sub: u });
    await db.query("update public.bingo_games set hunt_started_at = clock_timestamp() - interval '1 second' where game_id=$1", [g.id]);
    await endCurrentPass(db, u);
    const l = await layout(g, "A");
    await claim(g, "A", rowCells(l, 0));
    await review((await lastSub(g, "A")).id, "verify", null, u);
    await act(g, "close_hunt", { sub: u });
    const s = await as(db, user(u), async () => (await db.query<{ s: State }>("select public.bingo_transition($1,'announce_results',$2,(select id from public.bingo_submissions where game_id=$1 and status='verified')) s", [g.id, await ver(g.id)])).rows[0].s);
    assert.equal(s.results!.entries[0].nickname, "A");
    // ...but no new game can be created or started
    assert.match((await errorOf(create(u))) ?? "", /subscription_required/);
  });

  it("the deadline is enforced on the database clock with a 2 s grace; expiry settles the phase", async () => {
    const g = await newBingo();
    await toHunt(g);
    const l = await layout(g, "Ann");
    await expireHunt(g, 1); // inside the grace window
    assert.equal((await claim(g, "Ann", rowCells(l, 0))).me!.submissions.length, 1);
    await expireHunt(g, 3);
    assert.match((await errorOf(claim(g, "Bo", rowCells(await layout(g, "Bo"), 0)))) ?? "", /hunt_over/);
    // a refused call rolls back entirely, but snapshots already report the deadline...
    assert.equal((await hostView(g)).board.huntOver, true);
    // ...and the next successful engine call settles the phase (no cron needed)
    const hs = await review((await lastSub(g, "Ann")).id, "verify");
    assert.equal(hs.phase, "reviewing");
  });

  it("closing early ends claims immediately; settings lock once the hunt starts", async () => {
    const g = await newBingo();
    const s1 = await as(db, user(host), async () => (await db.query<{ s: State }>("select public.bingo_update_settings($1,$2,'first') s", [g.id, await ver(g.id)])).rows[0].s);
    assert.equal(s1.board.winnerRule, "first");
    assert.match((await errorOf(as(db, user(host), () => db.query("select public.bingo_update_settings($1,0,'ranked')", [g.id])))) ?? "", /stale_state/);
    const v = await ver(g.id);
    assert.match((await errorOf(as(db, user(other), () => db.query("select public.bingo_update_settings($1,$2,'ranked')", [g.id, v])))) ?? "", /game_not_found/);
    await toHunt(g);
    assert.match((await errorOf(as(db, user(host), async () => db.query("select public.bingo_update_settings($1,$2,'ranked')", [g.id, await ver(g.id)])))) ?? "", /settings_locked/);
    await act(g, "close_hunt");
    assert.match((await errorOf(claim(g, "Ann", rowCells(await layout(g, "Ann"), 0)))) ?? "", /hunt_over/);
  });
});

describe("per-participant layout", () => {
  it("is stable, differs between participants, keeps every challenge once, fixes the free centre, and is withheld until the hunt starts", async () => {
    const g = await newBingo({ size: 5, free: true, items: challenges(24) });
    assert.equal((await playerView(g, "Ann")).me!.layout, null, "withheld in the lobby");
    assert.equal((await hostView(g, "presenter")).cells, null, "presenter sees challenges only once the hunt starts");
    await toHunt(g);
    const a1 = await layout(g, "Ann");
    const a2 = await layout(g, "Ann");
    const b = await layout(g, "Bo");
    assert.deepEqual(a1, a2);
    assert.equal(a1.length, 25);
    assert.notDeepEqual(a1.map((c) => c.cellId), b.map((c) => c.cellId));
    assert.deepEqual(a1.filter((c) => !c.isFree).map((c) => c.challenge).sort(), challenges(24).sort());
    assert.ok(a1[12].isFree && b[12].isFree && a1[12].challenge === null);
  });
});

describe("claims (participants submit only for themselves)", () => {
  it("accepts exactly one complete line; refuses everything else", async () => {
    const g = await newBingo({ size: 5, free: true, items: challenges(24) }, ["Ann", "Bo", "Cy", "Di", "Ed", "Fy"]);
    assert.match((await errorOf(claim(g, "Ann", ["00000000-0000-4000-8000-000000000000"]))) ?? "", /hunt_not_active/);
    await toHunt(g);
    const l = await layout(g, "Ann");
    const otherG = await newBingo({}, ["Zed"], other);
    await toHunt(otherG, other);
    const foreign = rowCells(await layout(otherG, "Zed"), 0);
    const free = l.find((c) => c.isFree)!.cellId;
    for (const [cells, re] of [
      [rowCells(l, 0).slice(0, 4), /invalid_pattern/],
      [[...rowCells(l, 0), ...rowCells(l, 1)], /invalid_pattern/],
      [[...rowCells(l, 0), rowCells(l, 0)[0]], /invalid_cells/],
      [[...rowCells(l, 2), free], /invalid_cells/],
      [foreign, /invalid_cells/],
      [[], /invalid_cells/],
    ] as [string[], RegExp][]) {
      assert.match((await errorOf(claim(g, "Ann", cells))) ?? "", re, JSON.stringify(cells.length));
    }
    assert.match((await errorOf(as(db, svc, () => db.query("select public.bingo_submit_claim($1,$2)", ["f".repeat(64), rowCells(l, 0)])))) ?? "", /invalid_session/);
    // the centre row/column/diagonals need only 4 cells with the free space
    const ok: [string, string[], string][] = [
      ["Ann", rowCells(l, 2), "row:2"],
      ["Bo", colCells(await layout(g, "Bo"), 2), "col:2"],
      ["Cy", (await layout(g, "Cy")).filter((c) => c.row === c.col && !c.isFree).map((c) => c.cellId), "diag:main"],
      ["Di", (await layout(g, "Di")).filter((c) => c.row + c.col === 4 && !c.isFree).map((c) => c.cellId), "diag:anti"],
      ["Ed", rowCells(await layout(g, "Ed"), 4), "row:4"],
    ];
    for (const [who, cells, pattern] of ok) {
      const s = await claim(g, who, cells);
      assert.deepEqual([s.me!.submissions[0].status, s.me!.submissions[0].pattern, s.me!.canClaim], ["pending", pattern, false], who);
    }
    const fyRow = rowCells(await layout(g, "Fy"), 0);
    assert.match((await errorOf(claim(g, "Ann", rowCells(l, 0)))) ?? "", /claim_pending/);
    // kicked participants can't claim
    await as(db, user(host), () => db.query("update public.players set kicked_at=now() where id=$1", [g.ids.Fy]));
    assert.match((await errorOf(claim(g, "Fy", fyRow))) ?? "", /player_removed/);
  });

  it("full card needs every cell", async () => {
    const g = await newBingo({ size: 3, mode: "full_card" });
    await toHunt(g);
    const l = await layout(g, "Ann");
    assert.match((await errorOf(claim(g, "Ann", rowCells(l, 0)))) ?? "", /invalid_pattern/);
    assert.equal((await claim(g, "Ann", l.map((c) => c.cellId))).me!.submissions[0].pattern, "full");
  });

  it("a rejected participant may claim again (history kept, max 5 attempts)", async () => {
    const g = await newBingo();
    await toHunt(g);
    const l = await layout(g, "Ann");
    for (let i = 0; i < 5; i++) {
      await claim(g, "Ann", rowCells(l, i % 3));
      await review((await lastSub(g, "Ann")).id, "reject", "photo missing");
    }
    const me = (await playerView(g, "Ann")).me!;
    assert.deepEqual(me.submissions.map((s) => [s.attempt, s.status]), [1, 2, 3, 4, 5].map((n) => [n, "rejected"]));
    assert.equal(me.attemptsLeft, 0);
    assert.match((await errorOf(claim(g, "Ann", rowCells(l, 0)))) ?? "", /attempts_exhausted/);
  });

  it("a Bring Me session cannot use the BingoSnap claim/state functions", async () => {
    await freeSlots(host);
    const bm = await as(db, user(host), async () => (await db.query<{ code: string }>("select * from public.create_game_with_rounds('Classic', $1)", [["a hat"]])).rows[0]);
    const j = await join(bm.code, "Kim");
    assert.match((await errorOf(as(db, svc, () => db.query("select public.bingo_player_state($1)", [hashToken(j.token)])))) ?? "", /wrong_game_type/);
    assert.match((await errorOf(as(db, svc, () => db.query("select public.bingo_submit_claim($1,$2)", [hashToken(j.token), [crypto.randomUUID()]])))) ?? "", /wrong_game_type/);
  });

  it("guests can't call claim/state functions directly (service role only)", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      const actor = role === "anon" ? { role } : { role, sub: host };
      assert.match((await errorOf(as(db, actor, () => db.query("select public.bingo_player_state($1)", ["a".repeat(64)])))) ?? "", /permission denied/);
      assert.match((await errorOf(as(db, actor, () => db.query("select public.bingo_submit_claim($1,$2)", ["a".repeat(64), []])))) ?? "", /permission denied/);
    }
  });
});

describe("host validation & results", () => {
  it("only the owner reviews; decisions are state-checked; reasons only on reject", async () => {
    const g = await newBingo();
    await toHunt(g);
    await claim(g, "Ann", rowCells(await layout(g, "Ann"), 0));
    const s = (await lastSub(g, "Ann")).id;
    assert.match((await errorOf(review(s, "verify", null, other))) ?? "", /submission_not_found/);
    assert.match((await errorOf(review(s, "approve"))) ?? "", /invalid_decision/);
    assert.match((await errorOf(review(s, "verify", "nice"))) ?? "", /invalid_reason/);
    assert.match((await errorOf(review(s, "reject", "x".repeat(121)))) ?? "", /invalid_reason/);
    const v = await review(s, "verify");
    assert.equal(v.counts.verified, 1);
    const row = (await db.query<{ validated_at: Date; validated_by: string }>("select validated_at, validated_by from public.bingo_submissions where id=$1", [s])).rows[0];
    assert.ok(row.validated_at);
    assert.equal(row.validated_by, host);
    assert.match((await errorOf(review(s, "verify"))) ?? "", /already_reviewed/);
    assert.match((await errorOf(claim(g, "Ann", rowCells(await layout(g, "Ann"), 1)))) ?? "", /already_verified/);
    assert.equal((await review(s, "reset")).counts.pending, 1, "undo before results");
  });

  it("reset is refused when the participant already has a newer live claim", async () => {
    const g = await newBingo();
    await toHunt(g);
    const l = await layout(g, "Ann");
    await claim(g, "Ann", rowCells(l, 0));
    const first = (await lastSub(g, "Ann")).id;
    await review(first, "reject", "doesn't match");
    await claim(g, "Ann", rowCells(l, 1));
    assert.match((await errorOf(review(first, "reset"))) ?? "", /claim_superseded/);
  });

  it("ranked results order verified claims by server receipt; first-wins shows one; results freeze reviews", async () => {
    const g = await newBingo({}, ["Ann", "Bo", "Cy", "Di"]);
    await toHunt(g);
    for (const who of ["Bo", "Ann", "Cy", "Di"]) await claim(g, who, rowCells(await layout(g, who), 0));
    const subs = (await hostView(g)).submissions!;
    assert.deepEqual(subs.map((s) => s.nickname), ["Bo", "Ann", "Cy", "Di"], "host queue in received order");
    const id = (n: string) => subs.find((s) => s.nickname === n)!.id;
    await review(id("Ann"), "verify");
    await review(id("Cy"), "verify");
    await act(g, "close_hunt");
    // Bo's claim arrived before the current leader (Ann) and is unreviewed → can't announce yet
    assert.match((await errorOf(act(g, "announce_results", { winner: id("Ann") }))) ?? "", /earlier_claim_pending/);
    await review(id("Bo"), "reject", "photo missing");
    assert.match((await errorOf(act(g, "announce_results", { winner: id("Cy") }))) ?? "", /winner_mismatch/);
    // players don't see other participants' claims before the results
    const pv = await playerView(g, "Di");
    assert.equal(pv.submissions, undefined);
    assert.equal(pv.results, null);
    const res = await act(g, "announce_results", { winner: id("Ann") });
    assert.deepEqual(res.results!.entries.map((e) => [e.rank, e.nickname]), [[1, "Ann"], [2, "Cy"]], "Di still pending: excluded");
    assert.equal(res.phase, "winner_announced");
    assert.deepEqual((await playerView(g, "Di")).results!.entries.map((e) => e.nickname), ["Ann", "Cy"]);
    assert.match((await errorOf(review(id("Di"), "verify"))) ?? "", /review_locked/);
    assert.equal((await act(g, "end_game")).status, "completed");
  });

  it("first-wins mode announces only #1; no winner is allowed when nothing is pending", async () => {
    const g = await newBingo({ rule: "first" }, ["Ann", "Bo"]);
    await toHunt(g);
    for (const who of ["Ann", "Bo"]) await claim(g, who, rowCells(await layout(g, who), 0));
    const subs = (await hostView(g)).submissions!;
    for (const s of subs) await review(s.id, "verify");
    await act(g, "close_hunt");
    const res = await act(g, "announce_results", { winner: subs[0].id });
    assert.deepEqual(res.results!.entries.map((e) => e.nickname), ["Ann"]);

    const empty = await newBingo({}, ["Ann"]);
    await toHunt(empty);
    await act(empty, "close_hunt");
    assert.deepEqual((await act(empty, "announce_results", { winner: null })).results!.entries, []);
  });

  it("presenter view hides rejection reasons, claimed challenges and removed players", async () => {
    const g = await newBingo({}, ["Ann", "Bo"]);
    await toHunt(g);
    await claim(g, "Ann", rowCells(await layout(g, "Ann"), 0));
    await review((await lastSub(g, "Ann")).id, "reject", "photo missing");
    await as(db, user(host), () => db.query("update public.players set kicked_at=now() where id=$1", [g.ids.Bo]));
    const p = await hostView(g, "presenter");
    assert.deepEqual(p.submissions!.map((s) => [s.rejectionReason, s.cells]), [[null, null]]);
    assert.deepEqual(p.players!.map((x) => x.nickname), ["Ann"]);
    const h = await hostView(g);
    assert.equal(h.submissions![0].rejectionReason, "photo missing");
    assert.deepEqual(h.players!.map((x) => [x.nickname, x.state]), [["Ann", "active"], ["Bo", "removed"]]);
    assert.match((await errorOf(hostView(g, "player"))) ?? "", /invalid_view/);
  });

  it("a full game never touches photo storage or Bring Me submission tables", async () => {
    const count = async () => (await db.query<{ n: string }>(
      "select ((select count(*) from storage.objects) + (select count(*) from public.submission_intents) + (select count(*) from public.submissions))::text n")).rows[0].n;
    const before = await count();
    const g = await newBingo();
    await toHunt(g);
    await claim(g, "Ann", rowCells(await layout(g, "Ann"), 0));
    await review((await lastSub(g, "Ann")).id, "verify");
    await act(g, "end_game");
    assert.equal(await count(), before);
  });
});
