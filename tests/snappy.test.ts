/** Homepage boop counter: request validation and the in-memory per-client buckets (lib/snappy/limits.ts). */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { MAX_BATCH, createBucket, parseTaps } from "../lib/snappy/limits.ts";

describe("parseTaps", () => {
  it("accepts whole numbers from 1 to MAX_BATCH only", () => {
    assert.equal(MAX_BATCH, 500);
    assert.equal(parseTaps({ taps: 1 }), 1);
    assert.equal(parseTaps({ taps: MAX_BATCH }), MAX_BATCH);
    for (const bad of [0, -1, MAX_BATCH + 1, 1.5, "3", null, NaN, Infinity]) assert.equal(parseTaps({ taps: bad }), null, String(bad));
    assert.equal(parseTaps(null), null);
    assert.equal(parseTaps({}), null);
  });
});

describe("createBucket", () => {
  it("request bucket: allows a burst, then refuses until it refills", () => {
    const take = createBucket({ ratePerSec: 0.5, burst: 3 });
    const t = 1_000_000;
    assert.deepEqual([take("a", 1, t), take("a", 1, t), take("a", 1, t), take("a", 1, t)], [1, 1, 1, 0]);
    assert.equal(take("a", 1, t + 1_000), 0); // 0.5 token
    assert.equal(take("a", 1, t + 2_100), 1); // ~1 token after 2 s
  });
  it("tap bucket: grants part of a batch when the budget is short (the excess just isn't counted)", () => {
    const take = createBucket({ ratePerSec: 25, burst: 1_000 });
    assert.equal(take("a", 500, 0), 500);
    assert.equal(take("a", 500, 0), 500);
    assert.equal(take("a", 500, 0), 0);
    assert.equal(take("a", 500, 4_000), 100, "4 s × 25/s refill");
  });
  it("keeps clients independent and bounds memory (least recently seen evicted)", () => {
    const take = createBucket({ ratePerSec: 0, burst: 1, maxKeys: 2 });
    assert.equal(take("a", 1, 0), 1);
    assert.equal(take("a", 1, 0), 0);
    assert.equal(take("b", 1, 0), 1);
    take("c", 1, 0); // evicts "a"
    assert.equal(take("a", 1, 0), 1, "evicted client starts fresh");
    assert.equal(take("c", 1, 0), 0, "recent client still tracked");
  });
});
