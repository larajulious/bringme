/**
 * Client ↔ server clock estimation using ONLY monotonic time (performance.now()).
 *
 * Each sample brackets one request: the server stamped its clock somewhere
 * between t0 and t1, so the best guess is the midpoint (error ≤ RTT/2, worse
 * if the path is asymmetric). We keep the lowest-RTT recent sample and project
 * forward with monotonic deltas, so wall-clock changes (NTP step, user editing
 * the clock, DST) after the sample can't move the result.
 *
 * This is an ESTIMATE. See TIMING.md for what it can and can't guarantee.
 */
export type ClockSample = { serverMs: number; mono: number; rttMs: number };

const MAX_SAMPLES = 16;
const FRESH_MS = 120_000;
/** Generous allowance for crystal drift between samples (50 ppm). */
const DRIFT_PER_MS = 0.00005;

export class ClockSync {
  private samples: ClockSample[] = [];

  /** `serverNowMs` is the server clock reading returned by a request that began at t0 and ended at t1 (monotonic ms). */
  addSample(serverNowMs: number, t0Mono: number, t1Mono: number): ClockSample | null {
    if (!Number.isFinite(serverNowMs) || !Number.isFinite(t0Mono) || !Number.isFinite(t1Mono) || t1Mono < t0Mono) return null;
    const s = { serverMs: serverNowMs, mono: (t0Mono + t1Mono) / 2, rttMs: t1Mono - t0Mono };
    this.samples.push(s);
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
    return s;
  }

  /** Lowest-RTT sample that is still fresh; otherwise the most recent one. */
  best(nowMono: number): ClockSample | null {
    if (this.samples.length === 0) return null;
    const fresh = this.samples.filter((s) => nowMono - s.mono <= FRESH_MS);
    const pool = fresh.length ? fresh : [this.samples[this.samples.length - 1]];
    return pool.reduce((a, b) => (b.rttMs < a.rttMs ? b : a));
  }

  /** Estimated server clock (epoch ms) at monotonic time `nowMono`, or null if never synced. */
  serverNow(nowMono: number): number | null {
    const s = this.best(nowMono);
    return s ? s.serverMs + (nowMono - s.mono) : null;
  }

  /** Estimated milliseconds since the server's official start time. */
  elapsedSince(startedAtServerMs: number, nowMono: number): number | null {
    const now = this.serverNow(nowMono);
    return now === null ? null : now - startedAtServerMs;
  }

  /** What to record next to a measurement so the server can judge its quality. */
  quality(nowMono: number): { syncRttMs: number; syncAgeMs: number; syncUncertaintyMs: number } | null {
    const s = this.best(nowMono);
    if (!s) return null;
    const age = Math.max(0, nowMono - s.mono);
    return {
      syncRttMs: Math.round(s.rttMs),
      syncAgeMs: Math.round(age),
      syncUncertaintyMs: Math.round(s.rttMs / 2 + age * DRIFT_PER_MS),
    };
  }
}
