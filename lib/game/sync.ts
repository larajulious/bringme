/**
 * Client-side synchronisation core (framework-free, unit-tested).
 *
 * Rules that keep every device consistent:
 *  1. The database snapshot is authoritative. Broadcasts are only a "go and
 *     look" hint; their payload is never rendered.
 *  2. Snapshots carry a monotonically increasing `version`. A snapshot older
 *     than what we already show is dropped, so a delayed event or a slow
 *     response can never roll the screen back.
 *  3. Fetches are serialised (one in flight, at most one queued), so responses
 *     can't arrive out of order relative to each other.
 *  4. Hints carry an audience `scope` (Phase 2). A client may skip or delay the
 *     re-read for a scope that can't change what it shows, but it never
 *     "consumes" that version: the next relevant hint is newer still, and any
 *     snapshot read is the latest one (it includes every skipped change).
 */
export type Versioned = { version: number };

export type FetchResult<S> = { status: "ok"; state: S } | { status: "unauthorized" } | { status: "error" };

/**
 * Who a hint is for (set by the database, see migration 20261113000002):
 *  - all:    everyone re-reads now (phase changes, removals, rounds, results, capacity)
 *  - roster: a player joined (only the headcount changes for players)
 *  - claims: a BingoSnap claim was reviewed (only players holding a claim are affected)
 *  - host:   host-only news (photos, review decisions, claims); arrives on the host-only topic
 */
export type SyncScope = "all" | "roster" | "claims" | "host";
const SCOPES: ReadonlySet<string> = new Set(["all", "roster", "claims", "host"]);

/** A hint from the host-only topic is always 'host'; on the shared topic a missing/unknown scope (older database) means 'all'. */
export function scopeOf(payload: unknown, channel: "game" | "host" = "game"): SyncScope {
  if (channel === "host") return "host";
  const s = (payload as { scope?: unknown } | null)?.scope;
  return typeof s === "string" && SCOPES.has(s) ? (s as SyncScope) : "all";
}

export type Route = "now" | "debounce" | "skip";
export type RoutePolicy<S> = (scope: SyncScope, state: S | null) => Route;

/** Host, presenter and every legacy caller: re-read on every newer hint. */
export const routeEverything: RoutePolicy<unknown> = () => "now";

/**
 * Guests (players): phase changes at once; join headcounts debounced; host-only news skipped;
 * review decisions only when `claimsRelevant` says this player holds a claim (BingoSnap).
 */
export function guestRoute<S>(claimsRelevant?: (state: S) => boolean): RoutePolicy<S> {
  return (scope, state) => {
    if (scope === "all") return "now";
    if (scope === "roster") return "debounce";
    if (scope === "claims") return state && claimsRelevant?.(state) ? "now" : "skip";
    return "skip";
  };
}

export type SyncStats = { signals: number; stale: number; skipped: number; debounced: number; immediate: number; fetches: number };

export class GameSyncCore<S extends Versioned> {
  private current: S | null;
  private inflight: Promise<void> | null = null;
  private queued = false;
  private stopped = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceTarget = -1;
  /** Counters for tests, the benchmark and debugging. Never used for decisions. */
  readonly stats: SyncStats = { signals: 0, stale: 0, skipped: 0, debounced: 0, immediate: 0, fetches: 0 };

  private readonly opts: {
    initial: S | null;
    fetch: () => Promise<FetchResult<S>>;
    onState: (state: S) => void;
    onUnauthorized: () => void;
    onFetchError?: () => void;
    onFetchOk?: () => void;
    /** Default: re-read on every newer hint (pre-Phase-2 behaviour). */
    route?: RoutePolicy<S>;
    /** Delay for 'debounce' routes: base + random × jitter (spreads players' re-reads). */
    debounce?: { baseMs: number; jitterMs: number };
    random?: () => number;
  };

  constructor(opts: GameSyncCore<S>["opts"]) {
    this.opts = opts;
    this.current = opts.initial;
  }

  get version(): number {
    return this.current?.version ?? -1;
  }
  get state(): S | null {
    return this.current;
  }

  /** Strictly newer only (events, action responses). */
  applyIfNewer(next: S): boolean {
    if (this.stopped || (this.current && next.version <= this.current.version)) return false;
    this.current = next;
    this.settleDebounce();
    this.opts.onState(next);
    return true;
  }

  /** A pending delayed re-read is pointless once we hold a snapshot at least as new as what it was for. */
  private settleDebounce(): void {
    if (this.debounceTimer && this.version >= this.debounceTarget) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /** Trailing, bounded: the first hint starts the timer, later ones only raise the target (no endless postponing). */
  private scheduleDebounced(target: number): void {
    this.debounceTarget = Math.max(this.debounceTarget, target);
    if (this.debounceTimer) return;
    const { baseMs, jitterMs } = this.opts.debounce ?? { baseMs: 0, jitterMs: 0 };
    const delay = baseMs + Math.floor((this.opts.random ?? Math.random)() * jitterMs);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (!this.stopped && this.version < this.debounceTarget) void this.resync();
    }, delay);
  }

  /**
   * A freshly fetched snapshot may carry the SAME version when only time moved
   * (e.g. the round item becomes visible at its official start). Equal is
   * accepted, older is not.
   */
  private applyFetched(next: S): void {
    if (this.stopped || (this.current && next.version < this.current.version)) return;
    this.current = next;
    this.settleDebounce();
    this.opts.onState(next);
  }

  /** Re-read the authoritative state. Concurrent calls are coalesced. */
  resync(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inflight) {
      this.queued = true;
      return this.inflight;
    }
    this.inflight = (async () => {
      do {
        this.queued = false;
        this.stats.fetches++;
        const r = await this.opts.fetch().catch((): FetchResult<S> => ({ status: "error" }));
        if (r.status === "ok") {
          this.opts.onFetchOk?.();
          this.applyFetched(r.state);
        } else if (r.status === "unauthorized") {
          this.stopped = true;
          this.opts.onUnauthorized();
        } else {
          this.opts.onFetchError?.();
        }
      } while (this.queued && !this.stopped);
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /**
   * A broadcast arrived: only a newer version is worth a round trip, and only if its audience
   * includes this client (`channel` = which topic it came in on).
   */
  handleSignal(payload: unknown, channel: "game" | "host" = "game"): void {
    if (this.stopped) return;
    this.stats.signals++;
    const v = (payload as { version?: unknown } | null)?.version;
    if (typeof v === "number" && v <= this.version) { this.stats.stale++; return; }
    const route = (this.opts.route ?? routeEverything)(scopeOf(payload, channel), this.current);
    if (route === "skip") { this.stats.skipped++; return; }
    if (route === "debounce") {
      this.stats.debounced++;
      this.scheduleDebounced(typeof v === "number" ? v : Number.MAX_SAFE_INTEGER);
      return;
    }
    this.stats.immediate++;
    void this.resync();
  }

  stop(): void {
    this.stopped = true;
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
  }
}

// --------------------------------------------------------- realtime health ----

export type RtStatus = "connecting" | "subscribed" | "down";

/** The weaker of two subscriptions decides (a host needs BOTH its topics to rely on hints). */
export function combineRealtime(main: RtStatus, host?: RtStatus): RtStatus {
  if (host === undefined) return main;
  if (main === "down" || host === "down") return "down";
  if (main === "connecting" || host === "connecting") return "connecting";
  return "subscribed";
}

export const SAFETY_RESYNC_MS = 30_000; // Broadcast is at-most-once: a slow consistency check, not polling
export const FALLBACK_POLL_MS = 4_000; // only while Realtime is unavailable
export const FALLBACK_GRACE_MS = 6_000;

/** How often to re-read on our own: a slow safety net while subscribed, otherwise poll (after a grace while connecting). */
export function fallbackPlan(rt: RtStatus): { everyMs: number; startAfterMs: number } {
  if (rt === "subscribed") return { everyMs: SAFETY_RESYNC_MS, startAfterMs: 0 };
  return { everyMs: FALLBACK_POLL_MS, startAfterMs: rt === "down" ? 0 : FALLBACK_GRACE_MS };
}

// ------------------------------------------------------------------ clocks ----

/** serverTime - clientTime, using the midpoint of the request as the client time. */
export function clockOffset(serverNowIso: string, requestStartedMs: number, responseReceivedMs: number): number {
  const server = Date.parse(serverNowIso);
  if (Number.isNaN(server)) return 0;
  return server - (requestStartedMs + responseReceivedMs) / 2;
}

/** Whole seconds left until `endIso` on the (offset-corrected) server clock; never below 0. */
export function secondsUntil(endIso: string | null, clientNowMs: number, offsetMs: number): number {
  if (!endIso) return 0;
  const end = Date.parse(endIso);
  if (Number.isNaN(end)) return 0;
  return Math.max(0, Math.ceil((end - (clientNowMs + offsetMs)) / 1000));
}

/** Milliseconds until `iso` on the server clock (negative = already passed). */
export function msUntil(iso: string | null, clientNowMs: number, offsetMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t - (clientNowMs + offsetMs);
}
