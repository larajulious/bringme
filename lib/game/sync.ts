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
 */
export type Versioned = { version: number };

export type FetchResult<S> = { status: "ok"; state: S } | { status: "unauthorized" } | { status: "error" };

export class GameSyncCore<S extends Versioned> {
  private current: S | null;
  private inflight: Promise<void> | null = null;
  private queued = false;
  private stopped = false;

  private readonly opts: {
    initial: S | null;
    fetch: () => Promise<FetchResult<S>>;
    onState: (state: S) => void;
    onUnauthorized: () => void;
    onFetchError?: () => void;
    onFetchOk?: () => void;
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
    this.opts.onState(next);
    return true;
  }

  /**
   * A freshly fetched snapshot may carry the SAME version when only time moved
   * (e.g. the round item becomes visible at its official start). Equal is
   * accepted, older is not.
   */
  private applyFetched(next: S): void {
    if (this.stopped || (this.current && next.version < this.current.version)) return;
    this.current = next;
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

  /** A broadcast arrived: only a newer version is worth a round trip. */
  handleSignal(payload: unknown): void {
    const v = (payload as { version?: unknown } | null)?.version;
    if (typeof v === "number" && v <= this.version) return;
    void this.resync();
  }

  stop(): void {
    this.stopped = true;
  }
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
