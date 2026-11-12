import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { bucketDaily, lastDays, niceTicks } from "../lib/admin/series.ts";

const now = new Date("2026-11-12T10:00:00Z");

describe("admin series", () => {
  it("lists the last N UTC days, oldest first", () => {
    assert.deepEqual(lastDays(3, now), ["2026-11-10", "2026-11-11", "2026-11-12"]);
  });
  it("buckets by day and key, ignoring rows outside the window or with bad data", () => {
    const pts = bucketDaily(
      [
        { at: "2026-11-12T01:00:00Z", key: "a", value: 1 },
        { at: "2026-11-12T23:59:00Z", key: "a", value: 2 },
        { at: "2026-11-11T05:00:00Z", key: "b", value: 5 },
        { at: "2026-11-01T05:00:00Z", key: "a", value: 9 },
        { at: null, key: "a", value: 9 },
        { at: "nope", key: "a", value: 9 },
        { at: "2026-11-12T05:00:00Z", key: "zzz", value: 9 },
      ],
      2, ["a", "b"], now,
    );
    assert.deepEqual(pts, [
      { day: "2026-11-11", values: { a: 0, b: 5 } },
      { day: "2026-11-12", values: { a: 3, b: 0 } },
    ]);
  });
  it("makes clean ticks", () => {
    assert.deepEqual(niceTicks(0), [0, 1, 2, 3, 4]);
    assert.deepEqual(niceTicks(7), [0, 2, 4, 6, 8]);
    assert.deepEqual(niceTicks(23), [0, 10, 20, 30]);
    assert.deepEqual(niceTicks(150, 100), [0, 100, 200, 300, 400]);
  });
});
