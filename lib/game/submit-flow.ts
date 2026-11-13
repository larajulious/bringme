/**
 * The capture → upload → confirm state machine (framework-free, unit-tested
 * with injected network functions).
 *
 *  - Timing is fixed at the TAP: `start()` receives the already-measured
 *    elapsed time and fires `begin` immediately, in parallel with compression.
 *  - One capture per round: duplicate taps while busy/accepted are ignored.
 *  - Uploads retry automatically on network trouble (same attempt, original
 *    timing), then wait for a manual retry. No second confirmation is needed.
 *  - Nothing is ever resubmitted after acceptance.
 */
import { DB_BUSY } from "../api/db-errors.ts";

export class SubmitError extends Error {
  code: string;
  retryable: boolean;
  constructor(code: string, retryable: boolean) {
    super(code);
    this.code = code;
    this.retryable = retryable;
  }
}

export type BeginInput = { attemptId: string; elapsedMs: number; meta: Record<string, number | string> };
export type BeginResult =
  | { status: "ready" | "resumed"; uploadUrl: string }
  | { status: "already_submitted"; elapsedMs: number | null };
export type CompleteResult = { status: "accepted" | "duplicate"; elapsedMs: number; timing: string };

export type SubmitDeps = {
  begin(input: BeginInput): Promise<BeginResult>;
  upload(blob: Blob, uploadUrl: string, onProgress: (fraction: number) => void): Promise<void>;
  complete(input: { attemptId: string; meta: Record<string, number | string> }): Promise<CompleteResult>;
  sleep(ms: number): Promise<void>;
};

export type FlowState =
  | { kind: "idle" }
  | { kind: "preparing" }
  | { kind: "uploading"; progress: number; attempt: number }
  | { kind: "accepted"; elapsedMs: number | null; timing: string | null }
  | { kind: "failed"; code: string; retryable: boolean; canRecapture: boolean };

/** Failures where the capture can no longer be accepted but a NEW capture may still be allowed. */
const RECAPTURE = new Set(["attempt_expired", "attempt_superseded", "no_intent", "invalid_image"]);
/** Failures where nothing can be done this round. */
const FATAL = new Set(["round_not_open", "round_closed", "round_not_started", "player_removed", "invalid_session", "invalid_timing"]);

const AUTO_RETRY_DELAYS_MS = [500, 1500];

export class SubmissionFlow {
  private state: FlowState = { kind: "idle" };
  private busy = false;
  private pending: { input: BeginInput; blob: Promise<Blob>; blobValue?: Blob } | null = null;
  private deps: SubmitDeps;
  private onState: (s: FlowState) => void;

  constructor(deps: SubmitDeps, onState: (s: FlowState) => void) {
    this.deps = deps;
    this.onState = onState;
  }

  get current(): FlowState {
    return this.state;
  }

  private set(s: FlowState) {
    this.state = s;
    this.onState(s);
  }

  /** Returns false (and does nothing) if a capture is already in progress or accepted. */
  start(input: BeginInput, blob: Promise<Blob>): boolean {
    const failed = this.state.kind === "failed" ? this.state : null;
    const canStartNew = this.state.kind === "idle" || (failed?.canRecapture ?? false);
    if (this.busy || !canStartNew) return false;
    this.pending = { input, blob };
    void this.run(true);
    return true;
  }

  /** Manual retry of the SAME capture (original timing). Single-flight. */
  async retry(): Promise<void> {
    if (this.busy || this.state.kind !== "failed" || !this.state.retryable || !this.pending) return;
    await this.run(false);
  }

  private async run(first: boolean): Promise<void> {
    const p = this.pending;
    if (!p) return;
    this.busy = true;
    this.set({ kind: "preparing" });
    try {
      // `begin` for the first run starts NOW, in parallel with compression.
      let earlyBegin: Promise<BeginResult> | null = first ? this.deps.begin(p.input) : null;
      earlyBegin?.catch(() => undefined); // surfaced below; avoid an unhandled rejection while awaiting the blob
      const blob = p.blobValue ?? (p.blobValue = await p.blob);

      // Set once the photo is stored; a "database busy" answer to `complete` then retries only `complete`
      // (the stored photo is still valid). Any other failure starts over from `begin` as before.
      let uploads = 0;
      let stored = false;
      for (let attempt = 0; ; attempt++) {
        try {
          if (!stored) {
            const b = await (earlyBegin ?? this.deps.begin(p.input)); // resume => fresh upload URL, same timing
            earlyBegin = null;
            if (b.status === "already_submitted") {
              this.set({ kind: "accepted", elapsedMs: b.elapsedMs, timing: null });
              return;
            }
            uploads++;
            this.set({ kind: "uploading", progress: 0, attempt: attempt + 1 });
            await this.deps.upload(blob, b.uploadUrl, (f) => this.set({ kind: "uploading", progress: Math.min(1, Math.max(0, f)), attempt: attempt + 1 }));
            stored = true;
          }
          const done = await this.deps.complete({ attemptId: p.input.attemptId, meta: { uploadAttempts: uploads } });
          this.set({ kind: "accepted", elapsedMs: done.elapsedMs, timing: done.timing });
          return;
        } catch (e) {
          earlyBegin = null;
          const err = e instanceof SubmitError ? e : new SubmitError("network", true);
          if (!(stored && err.code === DB_BUSY)) stored = false;
          if (!err.retryable) throw err;
          if (attempt >= AUTO_RETRY_DELAYS_MS.length) throw err;
          await this.deps.sleep(AUTO_RETRY_DELAYS_MS[attempt]);
        }
      }
    } catch (e) {
      const err = e instanceof SubmitError ? e : new SubmitError("network", true);
      const fatal = FATAL.has(err.code);
      const recapture = RECAPTURE.has(err.code);
      if (recapture) this.pending = null;
      this.set({ kind: "failed", code: err.code, retryable: err.retryable && !fatal && !recapture, canRecapture: recapture });
    } finally {
      this.busy = false;
    }
  }
}
