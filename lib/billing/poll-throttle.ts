/**
 * Reuses a provider answer per key for `ttlMs` (QA fix, Phase 9): host polling of the checkout
 * status endpoint must not become unbounded calls to Polar with our organization token.
 * Per server instance; stores data only (never clients or secrets). Unit-tested.
 */
export function createPollThrottle<T>(ttlMs: number, now: () => number = Date.now, maxEntries = 5_000) {
  const seen = new Map<string, { at: number; value: T }>();
  return async (key: string, load: () => Promise<T>): Promise<T> => {
    const hit = seen.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const value = await load();
    if (seen.size >= maxEntries) seen.clear();
    seen.set(key, { at: now(), value });
    return value;
  };
}
