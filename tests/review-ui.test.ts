import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { describeConfirmation, type ReviewRow } from "../lib/game/review.ts";

const row = (o: Partial<ReviewRow> & { nickname: string; rankMs: number }): ReviewRow => ({
  submissionId: o.nickname, playerId: o.nickname, status: "approved", nearTie: false, isLeader: false, timing: "consistent", ...o,
});

describe("describeConfirmation", () => {
  it("names the leader and counts what is still open", () => {
    const rows = [
      row({ nickname: "Bo", rankMs: 1000, status: "rejected" }),
      row({ nickname: "Ann", rankMs: 2000, isLeader: true }),
      row({ nickname: "Cy", rankMs: 4000, status: "pending" }),
    ];
    const c = describeConfirmation(rows);
    assert.equal(c.kind, "winner");
    if (c.kind === "winner") {
      assert.equal(c.leader.nickname, "Ann");
      assert.deepEqual([c.pending, c.disqualified, c.closeContenders.length, c.flagged], [1, 1, 0, false]);
    }
  });

  it("lists close finishers (pending or approved) but never disqualified ones", () => {
    const rows = [
      row({ nickname: "Ann", rankMs: 2000, isLeader: true, nearTie: true }),
      row({ nickname: "Bo", rankMs: 2090, status: "pending", nearTie: true }),
      row({ nickname: "Cy", rankMs: 2010, status: "rejected" }),
      row({ nickname: "Di", rankMs: 2500 }),
    ];
    const c = describeConfirmation(rows);
    assert.ok(c.kind === "winner");
    assert.deepEqual(c.kind === "winner" ? c.closeContenders.map((r) => r.nickname) : [], ["Bo"]);
  });

  it("with nobody approved the only honest option is 'no winner'", () => {
    const c = describeConfirmation([row({ nickname: "Ann", rankMs: 1, status: "pending" }), row({ nickname: "Bo", rankMs: 2, status: "rejected" })]);
    assert.deepEqual(c, { kind: "none", pending: 1, disqualified: 1 });
    assert.deepEqual(describeConfirmation([]), { kind: "none", pending: 0, disqualified: 0 });
  });

  it("warns when the leader's time came from the server because the claim was flagged", () => {
    const c = describeConfirmation([row({ nickname: "Ann", rankMs: 9000, isLeader: true, timing: "flagged" })]);
    assert.ok(c.kind === "winner" && c.flagged);
  });
});
