/**
 * Short-lived reuse of ONE signed URL for many authorized requesters (Phase 3): the winner's photo,
 * which every player of that game may see during the announcement. Pure (inject `now`), unit-tested.
 *
 * Safety: the cache is consulted only AFTER the database authorized this request for exactly this
 * object (player_winner_photo returns the path only for a non-removed player of that game, only
 * during the announcement). Keys are `bucket/path`, and a path names one game's object, so an entry
 * can only ever be handed to someone the database already allowed to see that object.
 *  - An entry is reused only while at least `minRemainingMs` of its validity is left.
 *  - Concurrent misses for the same key share ONE signing call.
 *  - Failures are not cached. Size is bounded; expired entries are dropped first.
 */
type Entry = { url: string; expiresAt: number };

export class SharedSignedUrlCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<string | null>>();
  private readonly ttlMs: number;
  private readonly minRemainingMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  /** Counters for tests and the benchmark. */
  readonly stats = { hits: 0, signs: 0, shared: 0 };

  constructor(opts: { ttlSeconds: number; minRemainingMs: number; maxEntries?: number; now?: () => number }) {
    this.ttlMs = opts.ttlSeconds * 1000;
    this.minRemainingMs = opts.minRemainingMs;
    this.maxEntries = opts.maxEntries ?? 256;
    this.now = opts.now ?? Date.now;
  }

  get ttlSeconds(): number { return this.ttlMs / 1000; }

  async get(key: string, sign: () => Promise<string | null>): Promise<string | null> {
    const e = this.entries.get(key);
    if (e && e.expiresAt - this.now() >= this.minRemainingMs) { this.stats.hits++; return e.url; }
    const pending = this.inflight.get(key);
    if (pending) { this.stats.shared++; return pending; }
    const started = this.now();
    const p = (async () => {
      this.stats.signs++;
      const url = await sign().catch(() => null);
      if (url) this.put(key, { url, expiresAt: started + this.ttlMs });
      return url;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private put(key: string, entry: Entry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    if (this.entries.size <= this.maxEntries) return;
    const now = this.now();
    for (const [k, v] of this.entries) if (v.expiresAt <= now) this.entries.delete(k);
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value as string);
  }
}

/**
 * The winner-photo flow (pure): the database decides first; the cache is touched ONLY for a path the
 * database returned for this requester. No path (not announcing, removed player, other game) = no URL.
 */
export async function resolveWinnerPhoto(
  lookupPath: () => Promise<string | null>,
  cache: SharedSignedUrlCache,
  sign: (path: string, ttlSeconds: number) => Promise<string | null>,
  bucket: string,
): Promise<string | null> {
  const path = await lookupPath();
  if (!path) return null;
  return cache.get(`${bucket}/${path}`, () => sign(path, cache.ttlSeconds));
}
