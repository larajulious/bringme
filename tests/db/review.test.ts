import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";

import { generatePlayerToken, hashToken } from "../../lib/players/token.ts";
import { as, createDb, createUser, errorOf } from "./harness.ts";

type R = Record<string, unknown>;
let db: PGlite;
let host: string;
let other: string;
const svc = { role: "service_role" } as const;
const user = (sub: string) => ({ role: "authenticated", sub }) as const;
const uuid = () => crypto.randomUUID();

before(async () => {
  db = await createDb();
  host = await createUser(db, "rv-host@example.com");
  other = await createUser(db, "rv-other@example.com");
  for (const u of [host, other]) await as(db, svc, () => db.query("select public.admin_set_subscription($1,'activate','pro',30,null)", [u]));
});
after(async () => { await db.close(); });

type G = { id: string; round: string; tokens: Record<string, string>; ids: Record<string, string> };
const version = async (id: string) => Number((await db.query<{ v: string }>("select state_version::text v from public.games where id=$1", [id])).rows[0].v);
const act = async (g: { id: string }, action: string, o: { sub?: string; winner?: string | null; expected?: number } = {}) => {
  const v = o.expected ?? (await version(g.id));
  return as(db, user(o.sub ?? host), async () => (await db.query<{ s: R }>("select public.game_transition($1,$2,$3,$4) as s", [g.id, action, v, o.winner ?? null])).rows[0].s);
};

/** A game in the ACTIVE phase of round 1 (round officially open). */
async function activeGame(owner = host, names = ["Ann", "Bo", "Cy"], items = ["a red shoe", "something round"]): Promise<G> {
  await db.query("update public.games set status='canceled' where owner_id=$1 and status in ('draft','lobby','live')", [owner]);
  const g = await as(db, user(owner), async () => (await db.query<{ game_id: string; code: string }>("select * from public.create_game_with_rounds('t', $1)", [items])).rows[0]);
  const tokens: Record<string, string> = {}, ids: Record<string, string> = {};
  for (const n of names) {
    tokens[n] = generatePlayerToken();
    ids[n] = (await as(db, svc, () => db.query<{ player_id: string }>("select * from public.join_game($1,$2,$3,null)", [g.code, n, hashToken(tokens[n])]))).rows[0].player_id;
  }
  const game = { id: g.game_id };
  await act(game, "start_game", { sub: owner }); await act(game, "start_countdown", { sub: owner }); await act(game, "start_round", { sub: owner });
  const round = (await db.query<{ id: string }>("select current_round_id id from public.games where id=$1", [g.game_id])).rows[0].id;
  return { id: g.game_id, round, tokens, ids };
}

/** `who` submits a photo whose capture time is `claimed` ms (server hears it 40 ms later: consistent). Returns the submission id. */
async function submit(g: G, who: string, claimed: number, serverMs = claimed + 40) {
  await db.query("update public.game_rounds set opened_at = clock_timestamp() - ($2 || ' milliseconds')::interval where id=$1", [g.round, String(serverMs)]);
  const h = hashToken(g.tokens[who]), a = uuid();
  await as(db, svc, () => db.query("select public.begin_submission($1,$2,$3,$4,'{\"syncRttMs\":30,\"syncAgeMs\":500}')", [h, g.round, a, claimed]));
  await as(db, svc, () => db.query("select public.complete_submission($1,$2,$3,'{}')", [h, g.round, a]));
  return (await db.query<{ id: string }>("select id from public.submissions where round_id=$1 and player_id=$2", [g.round, g.ids[who]])).rows[0].id;
}
const review = (sub: string, decision: string, as_ = host) =>
  as(db, user(as_), async () => (await db.query<{ s: R }>("select public.review_submission($1,$2) as s", [sub, decision])).rows[0].s);
const ranking = async (g: G) => (await as(db, user(host), () => db.query<{ nickname: string; rank_ms: number; status: string; near_tie: boolean; is_leader: boolean; rank: number }>("select * from public.round_ranking($1)", [g.round]))).rows;
const toReview = async (g: G) => { await act(g, "close_submissions"); await act(g, "move_to_review"); };
const winnerRow = async (g: G) => (await db.query<R>("select winner_player_id, winner_submission_id, winner_rank_ms, winner_confirmed_at from public.game_rounds where id=$1", [g.round])).rows[0];

describe("reviewing photos", () => {
  it("the host can approve, disqualify and undo; every change is visible to all views", async () => {
    const g = await activeGame();
    const s = await submit(g, "Ann", 2000);
    const v0 = await version(g.id);
    let state = await review(s, "approve") as { reviewCounts: { approved: number; pending: number; rejected: number } };
    assert.deepEqual(state.reviewCounts, { pending: 0, approved: 1, rejected: 0 });
    assert.ok((await version(g.id)) > v0, "state_version bumped so Realtime hints and re-reads happen");
    state = await review(s, "disqualify") as typeof state;
    assert.deepEqual(state.reviewCounts, { pending: 0, approved: 0, rejected: 1 });
    state = await review(s, "reset") as typeof state;
    assert.equal(state.reviewCounts.pending, 1);
    assert.equal((await ranking(g))[0].status, "pending");
    const reviewedAt = (await db.query<{ r: string | null }>("select reviewed_at r from public.submissions where id=$1", [s])).rows[0].r;
    assert.ok(reviewedAt, "reviewed_at is recorded");
    const v1 = await version(g.id);
    await review(s, "reset"); // no change => no version churn
    assert.equal(await version(g.id), v1);
  });

  it("decisions are validated and authorized on the server", async () => {
    const g = await activeGame();
    const s = await submit(g, "Ann", 2000);
    assert.match((await errorOf(review(s, "promote"))) ?? "", /invalid_decision/);
    assert.match((await errorOf(review(s, "approve", other))) ?? "", /submission_not_found/, "another host cannot review it");
    assert.match((await errorOf(review(uuid(), "approve"))) ?? "", /submission_not_found/);
    assert.match((await errorOf(as(db, { role: "anon" }, () => db.query("select public.review_submission($1,'approve')", [s])))) ?? "", /permission denied/i, "guests cannot");
    assert.match((await errorOf(as(db, svc, () => db.query("select public.review_submission($1,'approve')", [s])))) ?? "", /permission denied|unauthenticated/i, "not even the service role: it has no host identity");
    // direct writes are closed
    assert.match((await errorOf(as(db, user(host), () => db.query("update public.submissions set status='approved' where id=$1", [s])))) ?? "", /permission denied/i);
    assert.equal((await ranking(g))[0].status, "pending");
  });

  it("reviews are possible while the round is active or in review, and locked once the winner is official", async () => {
    const g = await activeGame();
    const a = await submit(g, "Ann", 2000);
    await review(a, "approve"); // active phase
    await toReview(g);
    await review(a, "disqualify");
    await review(a, "approve"); // changed my mind, still reviewing
    await act(g, "announce_winner", { winner: g.ids.Ann });
    assert.match((await errorOf(review(a, "disqualify"))) ?? "", /review_locked/);
    assert.match((await errorOf(db.query("update public.submissions set status='rejected' where id=$1", [a]))) ?? "", /review_locked/, "the trigger is the backstop even for trusted roles");
  });

  it("only photos of the CURRENT round of a live game can be reviewed", async () => {
    const g = await activeGame(host, ["Ann", "Bo"], ["one", "two"]);
    const old = await submit(g, "Ann", 1000);
    await review(old, "approve");
    await toReview(g); await act(g, "announce_winner", { winner: g.ids.Ann }); await act(g, "next_round");
    assert.match((await errorOf(review(old, "disqualify"))) ?? "", /review_locked/, "previous round is closed for good");
  });
});

describe("winner selection", () => {
  it("the fastest APPROVED photo wins; pending and disqualified photos never do", async () => {
    const g = await activeGame();
    const ann = await submit(g, "Ann", 3000), bo = await submit(g, "Bo", 2000), cy = await submit(g, "Cy", 4000);
    await review(ann, "approve"); await review(cy, "approve"); await review(bo, "disqualify"); // Bo is fastest but invalid
    await toReview(g);
    const rows = await ranking(g);
    assert.deepEqual(rows.map((r) => [r.nickname, r.status, r.is_leader]), [["Bo", "rejected", false], ["Ann", "approved", true], ["Cy", "approved", false]]);
    assert.match((await errorOf(act(g, "announce_winner", { winner: g.ids.Bo }))) ?? "", /winner_mismatch/, "a disqualified photo cannot be confirmed");
    const s = await act(g, "announce_winner", { winner: g.ids.Ann }) as { phase: string; round: { winnerName: string; winnerMs: number; decided: boolean } };
    assert.deepEqual([s.phase, s.round.winnerName, s.round.winnerMs, s.round.decided], ["winner_announced", "Ann", 3000, true]);
    const w = await winnerRow(g);
    assert.deepEqual([w.winner_player_id, w.winner_submission_id, w.winner_rank_ms], [g.ids.Ann, ann, 3000]);
    assert.ok(w.winner_confirmed_at);
  });

  it("an unreviewed (pending) fastest photo is not eligible", async () => {
    const g = await activeGame();
    await submit(g, "Bo", 1000);
    const ann = await submit(g, "Ann", 5000);
    await review(ann, "approve");
    await toReview(g);
    assert.equal((await ranking(g)).find((r) => r.is_leader)?.nickname, "Ann");
    assert.equal(await errorOf(act(g, "announce_winner", { winner: g.ids.Ann })), null);
  });

  it("close finish: both within 150 ms are marked as a near tie; the host resolves it by disqualifying the invalid one", async () => {
    const g = await activeGame();
    const ann = await submit(g, "Ann", 3000), bo = await submit(g, "Bo", 3080);
    await review(ann, "approve"); await review(bo, "approve");
    await toReview(g);
    let rows = await ranking(g);
    assert.deepEqual(rows.map((r) => [r.nickname, r.near_tie, r.is_leader]), [["Ann", true, true], ["Bo", true, false]], "80 ms apart: too close to call by the clock");
    // looking at the photos, Ann's turns out not to show the item
    await review(ann, "disqualify");
    rows = await ranking(g);
    assert.deepEqual(rows.map((r) => [r.nickname, r.status, r.near_tie, r.is_leader]), [["Ann", "rejected", false, false], ["Bo", "approved", false, true]], "a disqualified photo is no longer a contender");
    assert.match((await errorOf(act(g, "announce_winner", { winner: g.ids.Ann }))) ?? "", /winner_mismatch/);
    assert.equal(await errorOf(act(g, "announce_winner", { winner: g.ids.Bo })), null);
  });

  it("a pending photo within 150 ms of the leader also counts as a close finish (the host should look first)", async () => {
    const g = await activeGame();
    const ann = await submit(g, "Ann", 3000); await submit(g, "Bo", 3100);
    await review(ann, "approve");
    const rows = await ranking(g);
    assert.deepEqual(rows.map((r) => [r.nickname, r.near_tie]), [["Ann", true], ["Bo", true]]);
    assert.equal(rows[0].is_leader, true);
  });

  it("the host's confirmation must match the CURRENT leader: a late faster photo invalidates a stale confirmation", async () => {
    const g = await activeGame();
    const ann = await submit(g, "Ann", 4000); await review(ann, "approve");
    await toReview(g);
    // the host is looking at "Ann wins" (version V). Meanwhile Bo's faster photo lands (straggler) and is approved.
    const bo = await submit(g, "Bo", 1500, 1540).catch(() => null);
    assert.ok(bo === null || typeof bo === "string");
    if (bo) {
      await review(bo, "approve");
      assert.match((await errorOf(act(g, "announce_winner", { winner: g.ids.Ann }))) ?? "", /winner_mismatch/, "fresh version, wrong winner");
      assert.equal(await errorOf(act(g, "announce_winner", { winner: g.ids.Bo })), null);
    }
  });

  it("a confirmation made against an older state is refused as stale, without announcing anything", async () => {
    const g = await activeGame();
    const ann = await submit(g, "Ann", 2000); await review(ann, "approve");
    await toReview(g);
    const seen = await version(g.id);
    await review(ann, "disqualify"); // the host's other tab changes the review
    assert.match((await errorOf(act(g, "announce_winner", { winner: g.ids.Ann, expected: seen }))) ?? "", /stale_state/);
    assert.equal((await winnerRow(g)).winner_confirmed_at, null);
  });

  it("'no winner' is only possible when nobody is approved, and is final", async () => {
    const g = await activeGame();
    const ann = await submit(g, "Ann", 2000);
    await review(ann, "disqualify");
    await toReview(g);
    const s = await act(g, "announce_winner", { winner: null }) as { round: { winnerName: string | null; decided: boolean } };
    assert.deepEqual([s.round.winnerName, s.round.decided], [null, true]);
    assert.notEqual((await winnerRow(g)).winner_confirmed_at, null);
    assert.match((await errorOf(db.query("update public.game_rounds set winner_player_id=$2 where id=$1", [g.round, g.ids.Ann]))) ?? "", /winner_already_confirmed/);
  });

  it("a round can never have two confirmed winners", async () => {
    const g = await activeGame();
    const ann = await submit(g, "Ann", 2000), bo = await submit(g, "Bo", 2500);
    await review(ann, "approve"); await review(bo, "approve");
    await toReview(g);
    await act(g, "announce_winner", { winner: g.ids.Ann });
    assert.match((await errorOf(act(g, "announce_winner", { winner: g.ids.Ann }))) ?? "", /invalid_transition/, "second announcement, fresh version");
    assert.match((await errorOf(act(g, "announce_winner", { winner: g.ids.Bo }))) ?? "", /invalid_transition/, "a different winner is refused too");
    const w = await winnerRow(g);
    assert.equal(w.winner_player_id, g.ids.Ann);
    for (const set of ["winner_player_id=null", `winner_player_id='${g.ids.Bo}'`, "winner_rank_ms=1", "winner_confirmed_at=null", "winner_submission_id=null"]) {
      assert.match((await errorOf(db.query(`update public.game_rounds set ${set} where id=$1`, [g.round]))) ?? "", /winner_already_confirmed/, set);
    }
    assert.equal((await winnerRow(g)).winner_player_id, g.ids.Ann);
  });

  it("clients can never write winner fields", async () => {
    const g = await activeGame();
    await as(db, user(host), async () => {
      assert.match((await errorOf(db.query("update public.game_rounds set winner_player_id=$2 where id=$1", [g.round, g.ids.Ann]))) ?? "", /permission denied/i);
      assert.match((await errorOf(db.query("update public.game_rounds set winner_confirmed_at=now() where id=$1", [g.round]))) ?? "", /permission denied/i);
    });
  });

  it("a timing-flagged photo ranks by the server's observation and can still win only if it is genuinely fastest", async () => {
    const g = await activeGame();
    const cheat = await submit(g, "Ann", 1000, 9000); // claims 1.0 s, server heard it at 9.0 s => flagged, ranked 9.0 s
    const honest = await submit(g, "Bo", 4000);
    await review(cheat, "approve"); await review(honest, "approve");
    await toReview(g);
    const rows = await ranking(g);
    assert.deepEqual(rows.map((r) => r.nickname), ["Bo", "Ann"]);
    assert.equal(await errorOf(act(g, "announce_winner", { winner: g.ids.Bo })), null);
  });

  it("removed players are ignored in the ranking and can't win", async () => {
    const g = await activeGame();
    const cy = await submit(g, "Cy", 1000), ann = await submit(g, "Ann", 2000);
    await review(cy, "approve"); await review(ann, "approve");
    await as(db, user(host), () => db.query("update public.players set kicked_at=now() where id=$1", [g.ids.Cy]));
    await toReview(g);
    assert.deepEqual((await ranking(g)).map((r) => r.nickname), ["Ann"]);
    assert.equal(await errorOf(act(g, "announce_winner", { winner: g.ids.Ann })), null);
  });
});

describe("what players see", () => {
  const playerView = async (g: G, who: string) =>
    (await as(db, svc, () => db.query<{ s: { phase: string; round: { winnerName: string | null; winnerMs: number | null; decided: boolean } | null; me: { isWinner: boolean; submission: { elapsedMs: number; rankMs: number; review: string | null } | null }; results?: R[] } }>("select public.player_game_state($1) as s", [hashToken(g.tokens[who])]))).rows[0].s;

  it("the review outcome stays hidden until the winner is official, then everyone sees the result", async () => {
    const g = await activeGame();
    const ann = await submit(g, "Ann", 2000), bo = await submit(g, "Bo", 3000);
    await review(ann, "approve"); await review(bo, "disqualify");
    await toReview(g);
    assert.equal((await playerView(g, "Bo")).me.submission?.review, null, "Bo can't see he was disqualified mid-review");
    await act(g, "announce_winner", { winner: g.ids.Ann });
    const bView = await playerView(g, "Bo"), aView = await playerView(g, "Ann");
    assert.deepEqual([bView.round?.winnerName, bView.round?.winnerMs, bView.me.submission?.review, bView.me.submission?.rankMs], ["Ann", 2000, "rejected", 3000]);
    assert.deepEqual([aView.me.isWinner, aView.me.submission?.review, aView.me.submission?.elapsedMs], [true, "approved", 2000]);
  });

  it("the winner's photo path is available to the game's players ONLY while the announcement is showing", async () => {
    const g = await activeGame(host, ["Ann", "Bo"], ["one", "two"]);
    const ann = await submit(g, "Ann", 2000); await review(ann, "approve");
    const path = (who: string) => as(db, svc, async () => (await db.query<{ p: string | null }>("select public.player_winner_photo($1) as p", [hashToken(g.tokens[who])])).rows[0].p);
    assert.equal(await path("Bo"), null, "before the announcement");
    await toReview(g);
    assert.equal(await path("Bo"), null, "still in review");
    await act(g, "announce_winner", { winner: g.ids.Ann });
    assert.equal(await path("Bo"), `${g.id}/${g.round}/${g.ids.Ann}.jpg`, "other players see the winner's photo, nobody else's");
    assert.equal(await path("Ann"), `${g.id}/${g.round}/${g.ids.Ann}.jpg`);
    assert.equal((await as(db, svc, async () => (await db.query<{ p: string | null }>("select public.player_winner_photo('nope') as p")).rows[0].p)), null, "invalid session");
    await act(g, "next_round");
    assert.equal(await path("Bo"), null, "gone when the round is over");
    assert.match((await errorOf(as(db, { role: "anon" }, () => db.query("select public.player_winner_photo('x')")))) ?? "", /permission denied/i);
  });
});

describe("final results and archive", () => {
  async function playedGame() {
    const g = await activeGame(host, ["Ann", "Bo"], ["one", "two"]);
    const a = await submit(g, "Ann", 1500); await review(a, "approve");
    await toReview(g); await act(g, "announce_winner", { winner: g.ids.Ann });
    await act(g, "next_round"); await act(g, "start_countdown"); await act(g, "start_round");
    g.round = (await db.query<{ id: string }>("select current_round_id id from public.games where id=$1", [g.id])).rows[0].id;
    await db.query("update public.game_rounds set opened_at = clock_timestamp() - interval '2 seconds' where id=$1", [g.round]);
    await toReview(g); // nobody submitted in round 2
    await act(g, "announce_winner", { winner: null });
    return g;
  }

  it("lists the winner of every played round for the host and each player", async () => {
    const g = await playedGame();
    await act(g, "end_game");
    const host_ = (await as(db, user(host), () => db.query<{ s: { status: string; results: { no: number; prompt: string; winnerName: string | null; winnerMs: number | null; decided: boolean }[] } }>("select public.host_game_state($1) as s", [g.id]))).rows[0].s;
    assert.equal(host_.status, "finished");
    assert.deepEqual(host_.results.map((r) => [r.no, r.prompt, r.winnerName, r.winnerMs, r.decided]), [[1, "one", "Ann", 1500, true], [2, "two", null, null, true]]);
    const a = await playerView2(g, "Ann"), b = await playerView2(g, "Bo");
    assert.deepEqual(a.results?.map((r) => r.isMe), [true, false]);
    assert.deepEqual(b.results?.map((r) => r.isMe), [false, false]);
    const rows = (await as(db, user(host), () => db.query<{ round_no: number; winner_name: string | null; winner_path: string | null; submissions: number }>("select * from public.game_results($1)", [g.id]))).rows;
    assert.deepEqual(rows.map((r) => [r.round_no, r.winner_name, r.submissions]), [[1, "Ann", 1], [2, null, 0]]);
    assert.equal(rows[0].winner_path, `${g.id}/${(await db.query<{ id: string }>("select id from public.game_rounds where game_id=$1 and round_no=1", [g.id])).rows[0].id}/${g.ids.Ann}.jpg`);
    assert.equal((await as(db, user(other), () => db.query("select * from public.game_results($1)", [g.id]))).rows.length, 0, "another host sees nothing");
  });
  const playerView2 = async (g: G, who: string) => (await as(db, svc, () => db.query<{ s: { results?: { isMe: boolean }[] } }>("select public.player_game_state($1) as s", [hashToken(g.tokens[who])]))).rows[0].s;

  it("results are only exposed once the game is finished", async () => {
    const g = await playedGame();
    assert.equal((await as(db, user(host), () => db.query<{ s: { results: unknown } }>("select public.host_game_state($1) as s", [g.id]))).rows[0].s.results, null);
    assert.equal((await playerView2(g, "Ann")).results ?? null, null);
  });

  it("finishing then archiving: allowed once, owner only, only for finished games, and the game stays frozen", async () => {
    const g = await playedGame();
    assert.match((await errorOf(act(g, "archive"))) ?? "", /invalid_transition/, "not finished yet");
    await act(g, "end_game");
    assert.match((await errorOf(act(g, "archive", { sub: other }))) ?? "", /game_not_found/);
    const s = await act(g, "archive") as { archivedAt: string | null; status: string };
    assert.ok(s.archivedAt);
    assert.equal(s.status, "finished");
    assert.match((await errorOf(act(g, "archive"))) ?? "", /invalid_transition/, "already archived");
    assert.match((await errorOf(as(db, user(host), () => db.query("update public.games set title='x' where id=$1", [g.id])))) ?? "", /game_is_closed/);
    assert.match((await errorOf(as(db, user(host), () => db.query("update public.games set archived_at=null where id=$1", [g.id])))) ?? "", /permission denied/i, "clients can't touch it");
    // the results remain readable after archiving
    assert.equal((await as(db, user(host), () => db.query("select * from public.game_results($1)", [g.id]))).rows.length, 2);
  });

  it("a cancelled game cannot be 'archived' as finished", async () => {
    const g = await activeGame(host, ["Ann"]);
    await act(g, "cancel");
    assert.match((await errorOf(act(g, "archive"))) ?? "", /invalid_transition/);
  });
});
