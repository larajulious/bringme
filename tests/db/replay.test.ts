/**
 * Replay a round stopped too early (migration 26). Real SQL on PGlite, all migrations.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";

import { generatePlayerToken, hashToken } from "../../lib/players/token.ts";
import { as, createDb, createUser, errorOf } from "./harness.ts";

type State = {
  version: number; status: string; phase: string; totalRounds: number; roundsRemaining: number;
  round: null | { id: string; no: number; status: string; prompt: string | null; openedAt: string | null; decided: boolean };
  results: null | { no: number; prompt: string }[];
};

let db: PGlite;
let host: string;
let other: string;
const svc = { role: "service_role" } as const;
const user = (sub: string) => ({ role: "authenticated", sub }) as const;

before(async () => {
  db = await createDb();
  host = await createUser(db, "replay-host@example.com");
  other = await createUser(db, "replay-other@example.com");
  for (const u of [host, other]) await as(db, svc, () => db.query("select public.admin_set_subscription($1,'activate','pro',30,null)", [u]));
});
after(async () => { await db.close(); });

async function newGame(items = ["a red shoe", "something round", "a spoon"]) {
  await db.query("update public.games set status='canceled' where owner_id=$1 and status in ('draft','lobby','live')", [host]);
  const g = await as(db, user(host), async () =>
    (await db.query<{ game_id: string; code: string }>("select * from public.create_game_with_rounds('Replay test', $1)", [items])).rows[0]);
  const token = generatePlayerToken();
  await as(db, svc, () => db.query("select * from public.join_game($1,'Ann',$2,null)", [g.code, hashToken(token)]));
  return { id: g.game_id, token };
}
const ver = async (id: string) => Number((await db.query<{ v: string }>("select state_version::text v from public.games where id=$1", [id])).rows[0].v);
const act = async (id: string, action: string) => as(db, user(host), async () =>
  (await db.query<{ s: State }>("select public.game_transition($1,$2,$3,null) as s", [id, action, await ver(id)])).rows[0].s);
const replay = async (id: string, opts: { sub?: string; expected?: number } = {}) => {
  const v = opts.expected ?? (await ver(id)); // read as superuser: another host can't see the game at all
  return as(db, user(opts.sub ?? host), async () => (await db.query<{ s: State }>("select public.replay_round($1,$2) as s", [id, v])).rows[0].s);
};
const rounds = async (id: string) => (await db.query<{ round_no: number; prompt: string; status: string; replayed: boolean }>(
  "select round_no, prompt, status::text, replayed_at is not null replayed from public.game_rounds where game_id=$1 order by round_no", [id])).rows;

/** Start the game and play round 1 up to "photos stopped" (optionally into review). */
async function stoppedRound(id: string, review = true) {
  await act(id, "start_game");
  await act(id, "start_countdown");
  await act(id, "start_round");
  await db.query("update public.game_rounds set opened_at = clock_timestamp() - interval '2 seconds' where id=(select current_round_id from public.games where id=$1)", [id]);
  await act(id, "close_submissions");
  if (review) await act(id, "move_to_review");
}

describe("replay_round", () => {
  it("closes the stopped round as no winner and starts a copy right after it, keeping its number", async () => {
    const g = await newGame();
    await stoppedRound(g.id);
    const s = await replay(g.id);
    assert.equal(s.phase, "active");
    assert.equal(s.round?.status, "open");
    assert.equal(s.round?.no, 1, "the replay is still round 1 for everyone");
    assert.equal(s.round?.prompt, "a red shoe");
    assert.equal(s.totalRounds, 3, "replayed rounds are not counted");
    assert.equal(s.roundsRemaining, 2);
    assert.ok(Date.parse(s.round!.openedAt!) > Date.now(), "a new countdown runs before the round opens");
    assert.deepEqual((await rounds(g.id)).map((r) => [r.round_no, r.prompt, r.status, r.replayed]), [
      [1, "a red shoe", "closed", true], [2, "a red shoe", "open", false], [3, "something round", "pending", false], [4, "a spoon", "pending", false],
    ]);
    const old = (await db.query<{ w: string | null; c: string | null }>("select winner_player_id w, winner_confirmed_at c from public.game_rounds where game_id=$1 and round_no=1", [g.id])).rows[0];
    assert.equal(old.w, null);
    assert.ok(old.c, "the stopped round's result is final (no winner)");
    // players see the same number, and the item only once the round opens
    const p = (await as(db, svc, () => db.query<{ s: State }>("select public.player_game_state($1) as s", [hashToken(g.token)]))).rows[0].s;
    assert.equal(p.round?.no, 1);
    assert.equal(p.round?.prompt, null);
  });

  it("also works at Time's up (before the review), and the next rounds keep playing in order", async () => {
    const g = await newGame();
    await stoppedRound(g.id, false);
    await replay(g.id);
    await db.query("update public.game_rounds set opened_at = clock_timestamp() - interval '2 seconds' where id=(select current_round_id from public.games where id=$1)", [g.id]);
    await act(g.id, "close_submissions");
    await act(g.id, "move_to_review");
    await act(g.id, "announce_winner");
    await act(g.id, "next_round");
    await act(g.id, "start_countdown");
    const s = await act(g.id, "start_round");
    assert.equal(s.round?.no, 2);
    assert.equal(s.round?.prompt, "something round");
    const done = await act(g.id, "end_game");
    assert.deepEqual(done.results?.map((r) => [r.no, r.prompt]), [[1, "a red shoe"], [2, "something round"]], "results leave the replayed round out");
    const host_results = (await as(db, user(host), () => db.query<{ round_no: number }>("select round_no from public.game_results($1)", [g.id]))).rows;
    assert.deepEqual(host_results.map((r) => r.round_no), [1, 2]);
  });

  it("is refused while photos are open, after the winner is announced, on a stale version, and for others", async () => {
    const g = await newGame();
    await act(g.id, "start_game");
    await act(g.id, "start_countdown");
    await act(g.id, "start_round");
    const before = await ver(g.id);
    assert.match((await errorOf(replay(g.id))) ?? "", /invalid_transition/, "photos still open");
    assert.equal(await ver(g.id), before);
    await db.query("update public.game_rounds set opened_at = clock_timestamp() - interval '2 seconds' where id=(select current_round_id from public.games where id=$1)", [g.id]);
    await act(g.id, "close_submissions");
    await act(g.id, "move_to_review");
    assert.match((await errorOf(replay(g.id, { expected: before }))) ?? "", /stale_state/);
    assert.match((await errorOf(replay(g.id, { sub: other }))) ?? "", /game_not_found/);
    await act(g.id, "announce_winner");
    assert.match((await errorOf(replay(g.id))) ?? "", /invalid_transition/, "result already official");
    assert.equal((await rounds(g.id)).length, 3, "nothing was inserted by refused calls");
  });

  it("does not use up a round of the plan's limit", async () => {
    const g = await newGame(["one"]);
    // fill the game up to the plan's round limit
    for (let i = 0; i < 500; i++) {
      const e = await errorOf(as(db, user(host), () => db.query("select public.add_game_round($1,$2)", [g.id, `extra ${i}`])));
      if (e) { assert.match(e, /round_limit_reached/); break; }
    }
    await stoppedRound(g.id);
    const s = await replay(g.id);
    assert.equal(s.round?.prompt, "one");
    assert.match((await errorOf(as(db, user(host), () => db.query("select public.add_game_round($1,'more')", [g.id])))) ?? "", /round_limit_reached/, "the limit itself is unchanged");
  });

  it("clients can't set replayed_at directly", async () => {
    const g = await newGame();
    const e = await errorOf(as(db, user(host), () => db.query("update public.game_rounds set replayed_at = now() where game_id=$1", [g.id])));
    assert.match(e ?? "", /permission denied/);
  });
});
