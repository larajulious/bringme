import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";

import { generatePlayerToken, hashToken } from "../../lib/players/token.ts";
import { as, createDb, createUser, errorOf, subscribe } from "./harness.ts";

// Phase 8: reliable claims (migration 21): idempotent retries, arrival-time deadline, history.
type Layout = { pos: number; cellId: string; isFree: boolean }[];
type Snap = {
  version: number; status: string; phase: string;
  board: { huntEndsAt: string | null; huntOver: boolean };
  me: { id: string; layout: Layout | null; submissions: { id: string; attempt: number; status: string; pattern: string; submittedAt: string }[]; attemptsLeft: number; canClaim: boolean };
};

let db: PGlite;
let host: string;
const svc = { role: "service_role" } as const;
const user = (sub: string) => ({ role: "authenticated", sub }) as const;
const cells = (n: number) => Array.from({ length: n }, (_, i) => `thing ${i + 1}`);
const uuid = () => crypto.randomUUID();

const engine = async (sql: string, params: unknown[] = []) => {
  await db.query("select set_config('bingosnap.engine','on',false)");
  try { await db.query(sql, params); } finally { await db.query("select set_config('bingosnap.engine','off',false)"); }
};
const ver = async (id: string) => Number((await db.query<{ v: string }>("select state_version::text v from public.games where id=$1", [id])).rows[0].v);
const rows = async (player: string) => (await db.query<{ attempt_no: number; status: string; request_id: string | null; submitted_at: Date }>(
  "select attempt_no, status, request_id, submitted_at from public.bingo_submissions where player_id=$1 order by attempt_no", [player])).rows;

/** Put the NATURAL deadline `secs` from now (start = deadline - duration, as start_hunt would have set it). */
async function endsIn(id: string, secs: number) {
  await engine("update public.bingo_games set hunt_ends_at = now() + make_interval(secs => $2), hunt_started_at = now() + make_interval(secs => $2) - make_interval(secs => duration_seconds) where game_id=$1", [id, secs]);
}
// The real start opens the hunt 3 s later; tests open it now with 5 of its 10 minutes left.
const startNow = (id: string) => endsIn(id, 300);
const state = (token: string) => as(db, svc, async () => (await db.query<{ s: Snap }>("select public.bingo_player_state($1) s", [hashToken(token)])).rows[0].s);
const claim = (token: string, ids: string[], req: string | null = uuid()) =>
  as(db, svc, async () => (await db.query<{ s: Snap }>("select public.bingo_submit_claim($1,$2::uuid[],$3::uuid) s", [hashToken(token), ids, req])).rows[0].s);
const claim2 = (token: string, ids: string[]) =>
  as(db, svc, async () => (await db.query<{ s: Snap }>("select public.bingo_submit_claim($1,$2::uuid[]) s", [hashToken(token), ids])).rows[0].s);
const review = (sub: string, decision: string, reason: string | null = null) =>
  as(db, user(host), () => db.query("select public.bingo_review_submission($1,$2,$3)", [sub, decision, reason]));
const transition = async (id: string, action: string) =>
  as(db, user(host), async () => db.query("select public.bingo_transition($1,$2,$3)", [id, action, await ver(id)]));
const row0 = (s: Snap) => s.me.layout!.filter((c) => c.pos < 3).map((c) => c.cellId);
const row1 = (s: Snap) => s.me.layout!.filter((c) => c.pos >= 3 && c.pos < 6).map((c) => c.cellId);

before(async () => {
  db = await createDb();
  host = await createUser(db, "claims-host@example.com");
  await subscribe(db, host, { plan: "pro" });
});
after(async () => { await db.close(); });

async function setup(players = ["Ann"]) {
  const { id } = await (async () => {
    await engine("update public.games set status='canceled' where owner_id=$1 and status in ('draft','lobby','live')", [host]);
    const s = await as(db, user(host), async () => (await db.query<{ s: { gameId: string } }>(
      "select public.bingo_save_board(null,0,'Claims',3,'traditional',false,600,'ranked',$1,true) s", [cells(9)])).rows[0].s);
    return { id: s.gameId };
  })();
  const code = (await db.query<{ c: string }>("select join_code c from public.games where id=$1", [id])).rows[0].c;
  const tokens: string[] = [];
  for (const n of players) {
    const t = generatePlayerToken();
    await as(db, svc, () => db.query("select * from public.join_game($1,$2,$3,null)", [code, n, hashToken(t)]));
    tokens.push(t);
  }
  await as(db, user(host), async () => db.query("select public.bingo_start($1,$2)", [id, await ver(id)]));
  await startNow(id);
  const s = await state(tokens[0]);
  return { id, tokens, s, me: s.me.id };
}

describe("claims: recording and the queue", () => {
  it("a winning line is recorded with the SERVER's time and joins the host's queue", async () => {
    const { id, tokens, s, me } = await setup();
    const v0 = await ver(id);
    const before = Date.now();
    const out = await claim(tokens[0], row0(s));
    assert.equal(out.me.submissions.length, 1);
    assert.deepEqual([out.me.submissions[0].status, out.me.submissions[0].pattern, out.me.canClaim], ["pending", "row:0", false]);
    const [r] = await rows(me);
    assert.ok(Math.abs(r.submitted_at.getTime() - before) < 5000, "server timestamp");
    assert.ok((await ver(id)) > v0, "version bumped (host and other tabs refresh)");
    const hostQueue = await as(db, user(host), async () => (await db.query<{ s: { submissions: { nickname: string; status: string }[] } }>("select public.bingo_host_state($1) s", [id])).rows[0].s);
    assert.deepEqual(hostQueue.submissions.map((x) => [x.nickname, x.status]), [["Ann", "pending"]]);
  });

  it("refuses a claim before the hunt opens", async () => {
    const { id, tokens, s } = await setup();
    await engine("update public.bingo_games set hunt_started_at = now() + interval '1 minute' where game_id=$1", [id]);
    assert.match(String(await errorOf(claim(tokens[0], row0(s)))), /hunt_not_active/);
  });
});

describe("duplicate prevention", () => {
  it("a replay of the same request returns the claim, creates nothing and bumps nothing", async () => {
    const { id, tokens, s, me } = await setup();
    const req = uuid();
    await claim(tokens[0], row0(s), req);
    const v1 = await ver(id);
    const again = await claim(tokens[0], row0(s), req);
    assert.equal(again.me.submissions.length, 1);
    assert.equal((await rows(me)).length, 1);
    assert.equal(await ver(id), v1);
  });

  it("a different request while one is pending is refused (two tabs, double tap without a key)", async () => {
    const { tokens, s, me } = await setup();
    await claim(tokens[0], row0(s));
    assert.match(String(await errorOf(claim(tokens[0], row0(s)))), /claim_pending/);
    assert.match(String(await errorOf(claim2(tokens[0], row1(s)))), /claim_pending/);
    assert.equal((await rows(me)).length, 1);
  });

  it("the database refuses a duplicate request id for the same player", async () => {
    const { id, tokens, s, me } = await setup();
    const req = uuid();
    await claim(tokens[0], row0(s), req);
    const e = await errorOf(as(db, svc, () => db.query(
      "insert into public.bingo_submissions (game_id, player_id, attempt_no, cell_ids, pattern, status, validated_at, request_id) values ($1,$2,2,$3::uuid[],'row:1','rejected',now(),$4)",
      [id, me, row1(s), req])));
    assert.match(String(e), /bingo_submissions_request|duplicate key/);
  });
});

describe("rejection, resubmission and history", () => {
  it("rejected → may resubmit (new attempt), history kept; verified → no more claims", async () => {
    const { tokens, s, me } = await setup();
    const first = await claim(tokens[0], row0(s));
    await review(first.me.submissions[0].id, "reject", "blurry");
    const after = await state(tokens[0]);
    assert.deepEqual([after.me.canClaim, after.me.attemptsLeft], [true, 4]);
    const second = await claim(tokens[0], row1(s));
    assert.deepEqual(second.me.submissions.map((x) => [x.attempt, x.status]), [[1, "rejected"], [2, "pending"]]);
    await review(second.me.submissions[1].id, "verify");
    assert.match(String(await errorOf(claim(tokens[0], row0(s)))), /already_verified/);
    assert.deepEqual((await rows(me)).map((r) => [r.attempt_no, r.status]), [[1, "rejected"], [2, "verified"]]);
  });

  it("at most 5 attempts", async () => {
    const { tokens, s } = await setup();
    for (let i = 0; i < 5; i++) {
      const out = await claim(tokens[0], i % 2 ? row1(s) : row0(s));
      await review(out.me.submissions.at(-1)!.id, "reject");
    }
    assert.match(String(await errorOf(claim(tokens[0], row0(s)))), /attempts_exhausted/);
  });
});

describe("deadline (database clock)", () => {
  it("accepted within the 2 s grace, refused after it; device clocks play no part", async () => {
    const { id, tokens, s } = await setup(["Ann", "Bob"]);
    await endsIn(id, -1);
    const ok = await claim(tokens[0], row0(s));
    assert.equal(ok.me.submissions[0].status, "pending", "1 s late: inside the grace");
    const bob = await state(tokens[1]);
    await endsIn(id, -3);
    assert.match(String(await errorOf(claim(tokens[1], row0(bob)))), /hunt_over/);
    const after = await state(tokens[1]);
    assert.deepEqual([after.board.huntOver, after.me.canClaim], [true, false]);
  });

  it("after the deadline: accepted claims are kept and the host can still review them", async () => {
    const { id, tokens, s } = await setup();
    const out = await claim(tokens[0], row0(s));
    await endsIn(id, -5);
    assert.match(String(await errorOf(claim(tokens[0], row1(s)))), /claim_pending|hunt_over/);
    await review(out.me.submissions[0].id, "verify");
    const after = await state(tokens[0]);
    assert.deepEqual([after.phase, after.me.submissions[0].status], ["reviewing", "verified"]);
  });

  it("a replay of an accepted claim still succeeds after the deadline (lost response near the end)", async () => {
    const { id, tokens, s } = await setup();
    const req = uuid();
    await claim(tokens[0], row0(s), req);
    await endsIn(id, -5);
    const again = await claim(tokens[0], row0(s), req);
    assert.equal(again.me.submissions[0].status, "pending");
  });
});

describe("the host ends early", () => {
  it("End hunt (close_hunt) stops new claims at once (no grace) and keeps reviewing open", async () => {
    const { id, tokens, s } = await setup(["Ann", "Bob"]);
    const out = await claim(tokens[0], row0(s));
    await transition(id, "close_hunt");
    const bob = await state(tokens[1]);
    assert.deepEqual([bob.phase, bob.board.huntOver], ["reviewing", true]);
    assert.match(String(await errorOf(claim(tokens[1], row0(bob)))), /hunt_over/);
    await review(out.me.submissions[0].id, "verify");
  });

  it("End game refuses claims at once", async () => {
    const { id, tokens, s } = await setup();
    await transition(id, "end_game");
    assert.match(String(await errorOf(claim(tokens[0], row0(s)))), /hunt_over/);
  });
});

describe("membership", () => {
  it("unknown, malformed and removed sessions are refused; the old 2-argument call has the same rules", async () => {
    const { id, tokens, s, me } = await setup(["Ann", "Bob"]);
    assert.match(String(await errorOf(claim(generatePlayerToken(), row0(s)))), /invalid_session/);
    assert.match(String(await errorOf(as(db, svc, () => db.query("select public.bingo_submit_claim('nope', $1::uuid[], null)", [row0(s)])))), /invalid_session/);
    await as(db, user(host), () => db.query("update public.players set kicked_at = now() where id=$1 and game_id=$2", [me, id]));
    assert.match(String(await errorOf(claim(tokens[0], row0(s)))), /player_removed/);
    const bob = await state(tokens[1]);
    assert.equal((await claim2(tokens[1], row0(bob))).me.submissions[0].status, "pending");
    assert.match(String(await errorOf(claim2(tokens[1], row0(bob)))), /claim_pending/);
  });

  it("another player's cells (or the wrong pattern) are refused", async () => {
    const { tokens, s } = await setup(["Ann", "Bob"]);
    assert.match(String(await errorOf(claim(tokens[0], [row0(s)[0], row1(s)[1], row0(s)[2]]))), /invalid_pattern/);
    assert.match(String(await errorOf(claim(tokens[0], [...row0(s).slice(0, 2), uuid()]))), /invalid_cells/);
  });

  it("guests and hosts can't call the claim function directly", async () => {
    const { tokens, s } = await setup();
    for (const actor of [{ role: "anon" } as const, user(host)]) {
      assert.match(String(await errorOf(as(db, actor, () => db.query("select public.bingo_submit_claim($1,$2::uuid[],null)", [hashToken(tokens[0]), row0(s)])))), /permission denied/);
    }
  });
});
