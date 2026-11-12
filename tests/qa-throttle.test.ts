import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createPollThrottle } from "../lib/billing/poll-throttle.ts";

describe("checkout status polling throttle (Phase 9 fix)", () => {
  it("100 polls of one checkout within 10 s reach Polar once; after 10 s once more", async () => {
    let t = 0;
    let calls = 0;
    const throttle = createPollThrottle<string>(10_000, () => t);
    for (let i = 0; i < 100; i++) assert.equal(await throttle("co_1", async () => { calls++; return "open"; }), "open");
    assert.equal(calls, 1);
    t = 10_001;
    await throttle("co_1", async () => { calls++; return "succeeded"; });
    assert.equal(calls, 2);
  });
  it("different checkouts are independent and the cache is bounded", async () => {
    let calls = 0;
    const throttle = createPollThrottle<number>(10_000, () => 0, 3);
    for (const k of ["a", "b", "c", "d", "a"]) await throttle(k, async () => ++calls);
    assert.equal(calls, 5, "bounded: the map was cleared at 3 entries, so 'a' is fetched again");
  });
});
