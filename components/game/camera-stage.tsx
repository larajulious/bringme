"use client";

import { Camera, Hourglass, RefreshCw, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CameraGate } from "@/components/game/camera-gate";
import { Confetti } from "@/components/game/confetti";
import { FullscreenButton } from "@/components/game/fullscreen-button";
import { WaitingDots } from "@/components/game/waiting-dots";
import { useCamera } from "@/components/game/camera-context";
import { ITEM_WRAP, itemSize } from "@/components/game/item-text";
import { useNow } from "@/components/game/use-game-sync";
import { Button } from "@/components/ui/button";
import type { ClockSync } from "@/lib/game/clock";
import type { PlayerSnapshot } from "@/lib/game/types";
import { encodeJpeg, grabFrame } from "@/lib/game/photo";
import { SubmissionFlow, SubmitError, type FlowState, type SubmitDeps } from "@/lib/game/submit-flow";
import { formatElapsed } from "@/lib/game/timing";
import { uploadWithProgress } from "@/lib/game/upload";
import { cn } from "@/lib/utils";

const RETRYABLE_SERVER_CODES = new Set(["upload_unavailable", "upload_missing", "internal_error", "request_failed"]);

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  if (!res) throw new SubmitError("network", true);
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const code = typeof data.error === "string" ? data.error : "request_failed";
    throw new SubmitError(code, res.status >= 500 || RETRYABLE_SERVER_CODES.has(code));
  }
  return data;
}

function CameraPreview({ onVideo, onFrames }: { onVideo: (v: HTMLVideoElement | null) => void; onFrames: (ready: boolean) => void }) {
  const { stream } = useCamera();
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    onVideo(v);
    if (!v) return;
    const ready = () => onFrames(v.readyState >= 2 && v.videoWidth > 0);
    onFrames(false);
    v.addEventListener("loadeddata", ready);
    v.addEventListener("playing", ready);
    v.srcObject = stream;
    void v.play().catch(() => undefined);
    ready();
    return () => { v.removeEventListener("loadeddata", ready); v.removeEventListener("playing", ready); onVideo(null); };
  }, [stream, onVideo, onFrames]);
  return <video ref={ref} playsInline muted autoPlay aria-label="Live camera preview" className="h-full w-full bg-black object-cover" />;
}

/** Corner brackets + rule-of-thirds guides: tells the player "this is what gets photographed". */
function Viewfinder() {
  const corner = "absolute size-9 border-white/90";
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-3">
      <span className={`${corner} left-0 top-0 rounded-tl-2xl border-l-4 border-t-4`} />
      <span className={`${corner} right-0 top-0 rounded-tr-2xl border-r-4 border-t-4`} />
      <span className={`${corner} bottom-0 left-0 rounded-bl-2xl border-b-4 border-l-4`} />
      <span className={`${corner} bottom-0 right-0 rounded-br-2xl border-b-4 border-r-4`} />
      <span className="absolute inset-x-0 top-1/3 border-t border-white/15" />
      <span className="absolute inset-x-0 top-2/3 border-t border-white/15" />
      <span className="absolute inset-y-0 left-1/3 border-l border-white/15" />
      <span className="absolute inset-y-0 left-2/3 border-l border-white/15" />
    </div>
  );
}

/** Satisfying "photo accepted" moment: a drawn check, a confetti burst, the time in a pill, then a calm waiting state. */
function SubmittedCard({ timeMs }: { timeMs: number }) {
  return (
    <div className="absolute inset-0 grid place-items-center overflow-hidden bg-brand-night/75 p-6 text-center short:p-3" role="status">
      <Confetti pieces={18} once />
      <div className="relative z-10 grid justify-items-center gap-3 short:gap-2 tiny:gap-1">
        <span className="relative grid size-24 place-items-center short:size-16 tiny:size-12">
          <span aria-hidden="true" className="absolute inset-0 animate-ping-soft rounded-full bg-emerald-400/50 motion-reduce:hidden" />
          <svg viewBox="0 0 72 72" className="relative size-24 short:size-16 tiny:size-12" aria-hidden="true">
            <circle cx="36" cy="36" r="30" fill="hsl(var(--brand-success))" opacity=".25" />
            <circle cx="36" cy="36" r="30" fill="none" stroke="#6ee7b7" strokeWidth="5" strokeLinecap="round" strokeDasharray="189" strokeDashoffset="189" className="animate-draw" />
            <path d="M22 37l10 10 18-21" fill="none" stroke="#fff" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="48" strokeDashoffset="48" className="animate-draw [animation-delay:0.5s]" />
          </svg>
        </span>
        <p className="animate-drop-in font-display text-5xl font-bold text-brand-yellow [text-shadow:0_4px_0_hsl(var(--brand-yellow-deep))] motion-reduce:animate-none short:text-4xl tiny:text-3xl">Locked in!</p>
        <p className="animate-rise rounded-2xl bg-white px-5 py-2 text-primary [animation-delay:0.3s] tiny:py-1">
          <span className="block text-xs font-bold uppercase tracking-widest text-muted-foreground">Your time</span>
          <span className="font-mono text-4xl font-bold tabular-nums tiny:text-2xl">{formatElapsed(timeMs)}</span>
        </p>
        <div className="mt-1 grid justify-items-center gap-2 text-white/85 tiny:mt-0 tiny:gap-1 tiny:text-sm">
          <WaitingDots className="bg-white/80 tiny:hidden" />
          <p>Photo sent. Waiting for the others…</p>
        </div>
      </div>
    </div>
  );
}

/**
 * The immersive round screen: the item, a live SS.mmm timer, a big live camera
 * preview and ONE coral capture button. Tapping captures instantly (on
 * pointer-down), fixes the timing at that moment, and uploads automatically.
 */
export function CameraStage({ snapshot, clock, offsetMs, connection }: { snapshot: PlayerSnapshot; clock: ClockSync; offsetMs: number; connection: string }) {
  const cam = useCamera();
  const r = snapshot.round!;
  const openedMs = Date.parse(r.openedAt ?? "");
  const now = useNow(true, 500);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const setVideoEl = useCallback((v: HTMLVideoElement | null) => { videoRef.current = v; }, []);
  const timerRef = useRef<HTMLParagraphElement>(null);
  const lock = useRef(false); // synchronous guard against double taps
  const timing = useRef({ compressMs: 0, uploadMs: 0 });
  const [flowState, setFlowState] = useState<FlowState>({ kind: "idle" });
  const [frozenMs, setFrozenMs] = useState<number | null>(null);
  const [flash, setFlash] = useState(0); // bumps on every capture: re-triggers the white shutter flash
  const [hasFrames, setHasFrames] = useState(false); // the shutter stays disabled until the preview is really showing frames

  const flow = useMemo(() => {
    const deps: SubmitDeps = {
      begin: async (i) => {
        const d = await postJson("/api/play/submissions/begin", { roundId: r.id, attemptId: i.attemptId, elapsedMs: i.elapsedMs, meta: i.meta });
        return d.status === "already_submitted"
          ? { status: "already_submitted", elapsedMs: typeof d.elapsedMs === "number" ? d.elapsedMs : null }
          : { status: d.status as "ready" | "resumed", uploadUrl: String(d.uploadUrl) };
      },
      upload: async (blob, url, onProgress) => {
        const t = performance.now();
        await uploadWithProgress(blob, url, onProgress);
        timing.current.uploadMs = Math.round(performance.now() - t);
      },
      complete: async (i) => {
        const d = await postJson("/api/play/submissions/complete", { roundId: r.id, attemptId: i.attemptId, meta: { ...i.meta, ...timing.current } });
        return { status: d.status as "accepted" | "duplicate", elapsedMs: Number(d.elapsedMs), timing: String(d.timing) };
      },
      sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
    };
    return new SubmissionFlow(deps, setFlowState);
  }, [r.id]);

  // New round => fresh state
  useEffect(() => { lock.current = false; setFlowState({ kind: "idle" }); setFrozenMs(null); }, [r.id]);

  const accepted = flowState.kind === "accepted" ? flowState : null;
  const submittedBefore = snapshot.me.hasSubmitted ? snapshot.me.submission : null;
  const done = Boolean(accepted || submittedBefore);
  const finalMs = accepted?.elapsedMs ?? submittedBefore?.elapsedMs ?? frozenMs;

  const limitLeftMs = r.openedAt ? openedMs + r.timeLimitSeconds * 1000 - (now + offsetMs) : 0;
  const timeUp = r.status === "closed" || limitLeftMs <= 0;
  const busy = flowState.kind === "preparing" || flowState.kind === "uploading";
  const roundClosed = r.status === "closed"; // the Game Master pressed "Stop photos": the camera is released (see player-game)
  // When time is up with no photo, the timer stops at the moment photos stopped (or the limit, whichever came first).
  const limitMs = r.timeLimitSeconds * 1000;
  const closedAtMs = r.closedAt ? Date.parse(r.closedAt) - openedMs : limitMs;
  const stoppedMs = timeUp && !done && !busy && flowState.kind !== "failed" ? Math.max(0, Math.min(limitMs, closedAtMs)) : null;
  const canCapture = cam.status === "ready" && hasFrames && !done && !busy && !timeUp && flowState.kind === "idle";

  // Live SS.mmm timer drawn straight into the DOM (60 fps without re-rendering React); frozen after the tap.
  useEffect(() => {
    const el = timerRef.current;
    if (!el) return;
    if (finalMs !== null) { el.textContent = formatElapsed(finalMs); return; }
    if (stoppedMs !== null) { el.textContent = formatElapsed(stoppedMs); return; }
    let raf = 0;
    const tick = () => {
      const e = clock.elapsedSince(openedMs, performance.now()) ?? Date.now() + offsetMs - openedMs;
      el.textContent = formatElapsed(Math.max(0, e));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [finalMs, stoppedMs, clock, openedMs, offsetMs]);

  const capture = () => {
    // 1) the very first thing: take the monotonic timestamp of the tap
    const tap = performance.now();
    if (lock.current || !canCapture) return;
    const video = videoRef.current;
    if (!video || video.readyState < 2 || !video.videoWidth) return;
    lock.current = true;

    // 2) grab the frame synchronously: THIS is the photo
    const frame = grabFrame(video);
    video.pause(); // freezes what the player sees = what was captured
    setFlash((n) => n + 1);

    // 3) timing at capture initiation (monotonic), plus how good our clock estimate was
    const elapsed = Math.round(clock.elapsedSince(openedMs, tap) ?? Date.now() + offsetMs - openedMs);
    setFrozenMs(elapsed);
    const meta = {
      ...(clock.quality(tap) ?? {}),
      tapWallMs: Date.now(),
      camera: cam.facing,
      visibility: document.visibilityState,
      frameWidth: frame.width,
      frameHeight: frame.height,
      source: "live" as const,
    };

    // 4) compress while `begin` is already on its way
    const compressStart = performance.now();
    const blob = encodeJpeg(frame.canvas).then((b) => { timing.current.compressMs = Math.round(performance.now() - compressStart); return b; });
    const started = flow.start({ attemptId: crypto.randomUUID(), elapsedMs: elapsed, meta }, blob);
    if (!started) lock.current = false;
  };

  const recapture = () => {
    lock.current = false;
    setFrozenMs(null);
    void videoRef.current?.play().catch(() => undefined);
    setFlowState({ kind: "idle" });
  };

  const failed = flowState.kind === "failed" ? flowState : null;

  return (
    // Explicit minmax(0,1fr) column: an implicit `auto` column would grow to the item's longest word and push it off-screen.
    <div className="fixed inset-0 z-30 grid grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto] bg-brand-night pb-safe pt-safe text-white landscape:tiny:grid-cols-[minmax(0,1fr)_auto] landscape:tiny:grid-rows-[auto_minmax(0,1fr)]">
      {/* Label + timer on one row, the item below at full width: on a 320 px phone it no longer shares its line
          with the timer. The item area grows with the text but is capped, so the camera always keeps its space;
          an extreme item scrolls there instead of being clipped. */}
      <header className="grid min-w-0 gap-2 px-4 pb-3 pt-3 short:gap-1.5 short:pb-2 short:pt-2">
        <div className="flex items-start justify-between gap-3">
          <div className="grid min-w-0 justify-items-start gap-1">
            <p className="rounded-full bg-white/12 px-3 py-0.5 text-xs font-bold uppercase tracking-widest text-white/85">Bring me…</p>
            <p className="truncate text-xs text-white/60" role="status">{connection}</p>
          </div>
          <div className="flex shrink-0 items-start gap-2">
          {/* The round screen covers the page header, so it carries its own fullscreen toggle. */}
          <FullscreenButton compact className="mt-0.5" />
          <div className="text-right">
            <p className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-white/70">
              <span aria-hidden="true" className={cn("size-2 rounded-full bg-brand-coral", finalMs === null && stoppedMs === null && "animate-pulse motion-reduce:animate-none")} /> Elapsed
            </p>
            <p ref={timerRef} role="timer" aria-label="Elapsed time" className="rounded-2xl bg-white/10 px-3 py-1 font-mono text-2xl font-bold tabular-nums min-[375px]:text-3xl tiny:text-2xl">00.000</p>
          </div>
          </div>
        </div>
        <div className="max-h-[30dvh] overflow-y-auto overscroll-contain landscape:tiny:max-h-[24dvh]">
          <p className={cn("text-center font-display font-bold text-brand-yellow", ITEM_WRAP, itemSize("phone", r.prompt))}>{r.prompt ?? "…"}</p>
        </div>
      </header>

      <div className="relative mx-3 min-h-0 overflow-hidden rounded-3xl bg-neutral-900 landscape:tiny:mb-3 landscape:tiny:mr-0">
        {roundClosed ? (
          <div aria-hidden="true" className="h-full w-full bg-brand-night" />
        ) : cam.status === "ready" ? (
          <CameraPreview onVideo={setVideoEl} onFrames={setHasFrames} />
        ) : (
          <div className="grid h-full place-items-center overflow-y-auto p-4"><CameraGate compact /></div>
        )}

        {cam.status === "ready" && !roundClosed && !done && !failed && !busy ? <Viewfinder /> : null}
        {flash > 0 ? <span key={flash} aria-hidden="true" className="pointer-events-none absolute inset-0 animate-shutter-flash bg-white motion-reduce:hidden" /> : null}

        {busy ? (
          <div className="absolute inset-x-0 bottom-0 grid gap-2 bg-gradient-to-t from-black/85 to-transparent p-4" role="status">
            <p className="font-display text-lg font-semibold">
              {flowState.kind === "uploading" ? (flowState.attempt > 1 ? `Retrying upload… (${flowState.attempt})` : `Uploading… ${Math.round(flowState.progress * 100)}%`) : "Saving your photo…"}
            </p>
            <div className="h-2 overflow-hidden rounded-full bg-white/20" aria-hidden="true">
              <div className="h-full rounded-full bg-brand-coral transition-[width] duration-200" style={{ width: `${flowState.kind === "uploading" ? Math.max(6, flowState.progress * 100) : 6}%` }} />
            </div>
          </div>
        ) : null}

        {done ? <SubmittedCard timeMs={finalMs ?? 0} /> : null}

        {failed ? (
          <div className="absolute inset-0 grid place-items-center bg-black/75 p-6 text-center" role="alert">
            <div className="grid max-w-xs justify-items-center gap-3">
              <TriangleAlert aria-hidden="true" className="size-12 text-brand-coral" />
              {failed.canRecapture ? (
                <>
                  <p className="font-display text-2xl font-semibold">That photo didn&apos;t make it</p>
                  <p className="text-white/85">Your time can&apos;t be saved for it, but you can take a new photo.</p>
                  <Button variant="camera" size="lg" onClick={recapture}><Camera aria-hidden="true" /> Take photo again</Button>
                </>
              ) : failed.retryable ? (
                <>
                  <p className="font-display text-2xl font-semibold">Upload didn&apos;t go through</p>
                  <p className="text-white/85">Your photo and time are safe on this device. Check your connection and try again.</p>
                  <Button variant="camera" size="lg" onClick={() => void flow.retry()}><RefreshCw aria-hidden="true" /> Try again</Button>
                </>
              ) : ["round_closed", "round_not_open", "round_not_started"].includes(failed.code) ? (
                <>
                  <p className="font-display text-2xl font-semibold">Too late for this round</p>
                  <p className="text-white/85">The round ended before your photo could be accepted.</p>
                </>
              ) : ["player_removed", "invalid_session"].includes(failed.code) ? (
                <>
                  <p className="font-display text-2xl font-semibold">You&apos;re no longer in this game</p>
                  <p className="text-white/85">Rejoin from the room link to keep playing.</p>
                </>
              ) : (
                <>
                  <p className="font-display text-2xl font-semibold">We couldn&apos;t send your photo</p>
                  <p className="text-white/85">Something went wrong on our side. Let the Game Master know.</p>
                </>
              )}
            </div>
          </div>
        ) : null}

        {timeUp && !done && !busy && !failed ? (
          <div className="absolute inset-0 grid place-items-center bg-black/70 p-6 text-center" role="status">
            <div className="grid justify-items-center gap-2">
              <Hourglass aria-hidden="true" className="size-12 text-brand-yellow" />
              <p className="font-display text-4xl font-bold">Time&apos;s up!</p>
              <p className="text-white/85">Waiting for the Game Master…</p>
            </div>
          </div>
        ) : null}
      </div>

      <footer className={cn("grid place-items-center gap-1 px-4 py-3 landscape:tiny:col-start-2 landscape:tiny:row-span-2 landscape:tiny:row-start-1 landscape:tiny:min-h-0", done ? "min-h-0 short:py-2" : "min-h-36 short:min-h-32 short:py-2")}>
        {done ? (
          <p className="text-center text-white/80">One photo per round. You&apos;re all set.</p>
        ) : (
          <>
            <button
              type="button"
              aria-label="Take photo"
              disabled={!canCapture}
              onPointerDown={(e) => { if (e.isPrimary && (e.pointerType !== "mouse" || e.button === 0)) capture(); }}
              onClick={(e) => { if (e.detail === 0) capture(); /* keyboard activation; pointer taps were handled on press */ }}
              className="relative grid size-24 touch-manipulation select-none place-items-center rounded-full border-4 border-white p-1.5 transition-transform motion-safe:active:scale-95 disabled:opacity-40"
            >
              {canCapture ? <span aria-hidden="true" className="absolute -inset-2 animate-ping-soft rounded-full border-2 border-brand-coral/70 motion-reduce:hidden" /> : null}
              <span className="grid size-full place-items-center rounded-full bg-brand-coral text-white shadow-pop-coral">
                <Camera aria-hidden="true" className="size-10" />
              </span>
            </button>
            <p className="text-sm font-semibold text-white/70" aria-hidden="true">{canCapture ? "Tap to snap" : busy ? "Sending…" : " "}</p>
          </>
        )}
      </footer>
    </div>
  );
}
