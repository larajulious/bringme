import { MAX_BATCH } from "./constants.ts";

export { MAX_BATCH };

/** Validate the POST body: a whole number of taps between 1 and MAX_BATCH. */
export function parseTaps(body: unknown): number | null {
  const t = (body as { taps?: unknown } | null)?.taps;
  return typeof t === "number" && Number.isInteger(t) && t >= 1 && t <= MAX_BATCH ? t : null;
}

/**
 * In-memory token bucket per client (never persisted; bounded, least-recently-seen evicted).
 * `take(key, want)` returns how many of `want` units are allowed right now (0..want).
 * Used twice by the API: requests per client (want = 1) and taps per client (want = batch size).
 */
export function createBucket({ ratePerSec, burst, maxKeys = 10_000 }: { ratePerSec: number; burst: number; maxKeys?: number }) {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return function take(key: string, want = 1, now = Date.now()): number {
    const b = buckets.get(key) ?? { tokens: burst, at: now };
    b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * ratePerSec);
    b.at = now;
    const got = Math.max(0, Math.min(want, Math.floor(b.tokens)));
    b.tokens -= got;
    buckets.delete(key);
    buckets.set(key, b); // re-insert = most recently used last
    if (buckets.size > maxKeys) buckets.delete(buckets.keys().next().value as string);
    return got;
  };
}
