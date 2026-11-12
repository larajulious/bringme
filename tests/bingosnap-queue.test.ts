import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildQueue, reviewErrorText } from "../lib/bingosnap/queue.ts";
import type { BingoHostSubmission } from "../lib/bingosnap/types.ts";

const T = (s: number) => new Date(Date.UTC(2026, 10, 12, 20, 0, s)).toISOString();
let n = 0;
function sub(o: Partial<BingoHostSubmission> & { nickname: string; at: number }): BingoHostSubmission {
  n++;
  return {
    id: o.id ?? `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    playerId: o.playerId ?? `p-${o.nickname}`,
    nickname: o.nickname, playerRemoved: false, attempt: o.attempt ?? 1, status: o.status ?? "pending",
    pattern: o.pattern ?? "row:0", submittedAt: T(o.at), validatedAt: o.validatedAt ?? null,
    rejectionReason: o.rejectionReason ?? null, cells: [], rank: o.rank ?? null,
  };
}

describe("buildQueue", () => {
  it("pending: earliest server time first; equal times broken by id (deterministic)", () => {
    const a = sub({ nickname: "Ann", at: 5, id: "00000000-0000-4000-8000-00000000000b" });
    const b = sub({ nickname: "Bob", at: 5, id: "00000000-0000-4000-8000-00000000000a" });
    const c = sub({ nickname: "Cy", at: 2 });
    for (const input of [[a, b, c], [c, b, a], [b, a, c]]) {
      assert.deepEqual(buildQueue(input, "ranked").pending.map((x) => x.nickname), ["Cy", "Bob", "Ann"]);
    }
  });

  it("numbers every claim by received order, across statuses and attempts", () => {
    const q = buildQueue([
      sub({ nickname: "Ann", at: 1, status: "rejected", validatedAt: T(3) }),
      sub({ nickname: "Bob", at: 2 }),
      sub({ nickname: "Ann", at: 4, attempt: 2 }),
    ], "ranked");
    assert.deepEqual(q.pending.map((x) => [x.nickname, x.order, x.attempt]), [["Bob", 2, 1], ["Ann", 3, 2]]);
    assert.deepEqual(q.history.map((x) => [x.nickname, x.order]), [["Ann", 1]]);
  });

  it("a repeated entry (duplicate event / re-read) never appears twice", () => {
    const a = sub({ nickname: "Ann", at: 1 });
    const q = buildQueue([a, { ...a }, a], "ranked");
    assert.equal(q.pending.length, 1);
  });

  it("verified by rank; history most recent decision first; verified players flagged", () => {
    const v1 = sub({ nickname: "Bob", at: 3, status: "verified", rank: 2, validatedAt: T(10) });
    const v0 = sub({ nickname: "Ann", at: 1, status: "verified", rank: 1, validatedAt: T(20) });
    const r = sub({ nickname: "Cy", at: 2, status: "rejected", validatedAt: T(15), rejectionReason: "blurry" });
    const q = buildQueue([v1, r, v0], "ranked");
    assert.deepEqual(q.verified.map((x) => x.nickname), ["Ann", "Bob"]);
    assert.deepEqual(q.history.map((x) => x.nickname), ["Ann", "Cy", "Bob"]);
    assert.deepEqual([...q.verifiedPlayers].sort(), ["p-Ann", "p-Bob"]);
    assert.equal(q.leader, null, "ranked mode has no single leader");
    assert.equal(q.pending.length, 0);
  });

  it("First wins: the earliest verified claim leads", () => {
    const q = buildQueue([sub({ nickname: "Bob", at: 3, status: "verified", rank: 2 }), sub({ nickname: "Ann", at: 1, status: "verified", rank: 1 })], "first");
    assert.equal(q.leader?.nickname, "Ann");
  });

  it("an empty game", () => {
    const q = buildQueue([], "first");
    assert.deepEqual([q.pending.length, q.verified.length, q.history.length, q.leader], [0, 0, 0, null]);
  });
});

describe("reviewErrorText", () => {
  it("explains every review refusal in plain words", () => {
    for (const code of ["already_reviewed", "already_pending", "claim_superseded", "player_removed", "review_locked", "submission_not_found", "invalid_reason"]) {
      assert.doesNotMatch(reviewErrorText(code, "Ann"), /try again\.$/, code);
    }
    assert.match(reviewErrorText("already_reviewed", "Ann"), /Ann's claim was already decided/);
    assert.match(reviewErrorText(undefined, "Ann"), /try again/);
  });
});
