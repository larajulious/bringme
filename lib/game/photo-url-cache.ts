/**
 * Signed photo URLs the host console / presenter already hold (Phase 3). One instance per open
 * screen and game, in memory only: never stored, never shared between tabs, users or games.
 * Pure (inject `now`), unit-tested.
 *
 *  - Key = `bucket/path`: a submission's object never changes once accepted (one per player and
 *    round, uploads can't overwrite it), so a URL stays correct for its whole lifetime.
 *  - Expiry is tracked on THIS device's clock from when the request was sent (conservative:
 *    the server signed after that), so server clock skew can't make us keep a dead URL.
 *  - A URL is reused while more than `marginMs` of it is left (at most half its lifetime); inside the
 *    margin the next listing asks for a fresh one (the old one is still shown until it arrives).
 *  - Photos that leave the list (a removed player, another round) are forgotten at once.
 *  - A picture that fails to load is dropped and re-signed, at most once per `retryMs`.
 */
export const REFRESH_MARGIN_MS = 30_000;
export const PHOTO_ERROR_RETRY_MS = 10_000;

type Entry = { url: string; expiresAt: number; refreshAt: number };
type PhotoRow = { submissionId: string; photoKey: string | null; photoUrl: string | null };

export class PhotoUrlCache {
  private readonly entries = new Map<string, Entry>();
  private readonly failedAt = new Map<string, number>();
  private readonly marginMs: number;
  private readonly retryMs: number;
  private readonly now: () => number;

  constructor(opts: { marginMs?: number; retryMs?: number; now?: () => number } = {}) {
    this.marginMs = opts.marginMs ?? REFRESH_MARGIN_MS;
    this.retryMs = opts.retryMs ?? PHOTO_ERROR_RETRY_MS;
    this.now = opts.now ?? Date.now;
  }

  get size(): number { return this.entries.size; }

  /** Comfortably valid (outside the refresh margin)? */
  private fresh(key: string): boolean {
    const e = this.entries.get(key);
    return Boolean(e && e.refreshAt > this.now());
  }

  /** Submission ids (of the rows on screen) whose photo we hold comfortably: no need to sign them again. */
  haveIds(rows: readonly PhotoRow[] | null): string[] {
    return (rows ?? []).filter((r) => r.photoKey && this.fresh(r.photoKey)).map((r) => r.submissionId);
  }

  /**
   * Apply a listing: keep new URLs (valid for `ttlSeconds` from `requestedAt`), fill the rest from the
   * cache while still valid, forget everything no longer listed. `missing` = rows that should show a
   * photo but have no usable URL (signing failed): the caller retries soon.
   */
  apply<R extends PhotoRow>(rows: readonly R[], ttlSeconds: number, requestedAt: number): { rows: R[]; missing: number } {
    const listed = new Set<string>();
    let missing = 0;
    const out = rows.map((r) => {
      if (!r.photoKey) return { ...r, photoUrl: null };
      listed.add(r.photoKey);
      if (r.photoUrl) {
        const life = ttlSeconds * 1000;
        this.entries.set(r.photoKey, { url: r.photoUrl, expiresAt: requestedAt + life, refreshAt: requestedAt + life - Math.min(this.marginMs, life / 2) });
        this.failedAt.delete(r.photoKey);
        return r;
      }
      const e = this.entries.get(r.photoKey);
      if (e && e.expiresAt > this.now()) return { ...r, photoUrl: e.url };
      this.entries.delete(r.photoKey);
      missing++;
      return { ...r, photoUrl: null };
    });
    for (const k of [...this.entries.keys()]) if (!listed.has(k)) this.entries.delete(k);
    for (const k of [...this.failedAt.keys()]) if (!listed.has(k)) this.failedAt.delete(k);
    return { rows: out, missing };
  }

  /** A picture failed to load (expired early, revoked, network): drop it so the next listing re-signs it. */
  invalidate(key: string): boolean {
    const last = this.failedAt.get(key);
    if (last !== undefined && this.now() - last < this.retryMs) return false;
    this.failedAt.set(key, this.now());
    this.entries.delete(key);
    return true;
  }

  /** When the next listing must run so no shown URL reaches its refresh margin unnoticed. */
  nextRefreshAt(): number | null {
    let next: number | null = null;
    for (const e of this.entries.values()) if (next === null || e.refreshAt < next) next = e.refreshAt;
    return next;
  }

  clear(): void { this.entries.clear(); this.failedAt.clear(); }
}

// ------------------------------------------------------------------------------ loader ----

export type ListingResult<R> = { status: "ok"; rows: R[]; ttlSeconds: number } | { status: "error" } | { status: "fatal" };

const RETRY_STEPS_MS = [3_000, 6_000, 12_000, 30_000];
const MIN_REFRESH_DELAY_MS = 1_000;

/**
 * Loads the current round's photo list for one screen (framework-free; used by the React hook and the
 * benchmark). One request at a time (later triggers coalesce into one follow-up), tells the server
 * which photos it already holds, refreshes before any shown URL expires, retries with backoff when
 * the list or a photo couldn't be loaded, and stops for good on "not your game / signed out".
 */
export class SubmissionPhotoLoader<R extends PhotoRow> {
  readonly cache: PhotoUrlCache;
  private rows: R[] | null = null;
  private inflight: Promise<void> | null = null;
  private queued = false;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retryStep = 0;
  /** Counters for tests and the benchmark. */
  readonly stats = { requests: 0, errors: 0 };

  private readonly opts: {
    fetchListing: (have: string[]) => Promise<ListingResult<R>>;
    onRows: (rows: R[]) => void;
    onError?: () => void;
    cache?: PhotoUrlCache;
    now?: () => number;
    /** Back-off between retries after a failed list or missing photos (default 3 s, 6 s, 12 s, then 30 s). */
    retryStepsMs?: readonly number[];
    /** Never refresh sooner than this after a listing (default 1 s). */
    minRefreshDelayMs?: number;
  };

  constructor(opts: SubmissionPhotoLoader<R>["opts"]) {
    this.opts = opts;
    this.cache = opts.cache ?? new PhotoUrlCache({ now: opts.now });
  }

  private now(): number { return (this.opts.now ?? Date.now)(); }

  load(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inflight) { this.queued = true; return this.inflight; }
    this.inflight = (async () => {
      do {
        this.queued = false;
        const requestedAt = this.now();
        this.stats.requests++;
        const res = await this.opts.fetchListing(this.cache.haveIds(this.rows)).catch((): ListingResult<R> => ({ status: "error" }));
        if (this.stopped) return;
        if (res.status === "fatal") { this.stop(); this.opts.onError?.(); return; }
        if (res.status === "error") { this.stats.errors++; this.opts.onError?.(); this.retryLater(); continue; }
        const { rows, missing } = this.cache.apply(res.rows, res.ttlSeconds, requestedAt);
        this.rows = rows;
        this.opts.onRows(rows);
        if (missing > 0) this.retryLater();
        else { this.retryStep = 0; this.refreshBeforeExpiry(); }
      } while (this.queued && !this.stopped);
    })().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  /** A shown picture failed to load: forget it and fetch a fresh one (throttled per photo). */
  photoFailed(row: { photoKey?: string | null }): void {
    if (row.photoKey && this.cache.invalidate(row.photoKey)) void this.load();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.cache.clear();
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.load(); }, Math.max(0, delayMs));
  }

  private retryLater(): void {
    const steps = this.opts.retryStepsMs ?? RETRY_STEPS_MS;
    this.schedule(steps[Math.min(this.retryStep, steps.length - 1)]);
    this.retryStep++;
  }

  private refreshBeforeExpiry(): void {
    const at = this.cache.nextRefreshAt();
    if (at === null) { if (this.timer) clearTimeout(this.timer); this.timer = null; return; }
    this.schedule(Math.max(this.opts.minRefreshDelayMs ?? MIN_REFRESH_DELAY_MS, at - this.now()));
  }
}
