"use client";

import { Camera, CameraOff, Download, ImageUp, Lock, RefreshCw, RotateCcw, Save, TriangleAlert, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { WaitingDots } from "@/components/game/waiting-dots";
import { Button } from "@/components/ui/button";
import { cameraHelp, classifyCameraError, openCamera, type CameraFailure } from "@/lib/game/camera";
import { PhotoProcessError, captureFromFile, captureFromVideo, processHelp, type CapturedPhoto } from "@/lib/photos/process";
import { PhotoStoreError, classifyStorageError, storeHelp } from "@/lib/photos/store";
import { cn } from "@/lib/utils";

type Cam = "starting" | "live" | CameraFailure;
type Mode =
  | { kind: "existing" }
  | { kind: "camera" }
  | { kind: "processing" }
  | { kind: "review"; photo: CapturedPhoto }
  | { kind: "saving"; photo: CapturedPhoto };

export type ExistingPhoto = {
  /** Reads the full photo (from local storage) when the viewer opens. */
  load: () => Promise<Blob | null>;
  takenAt: number;
  /** Shown instead of Retake when the photo can no longer be replaced. */
  lockedText?: string | null;
  /** The saved copy is missing or unreadable. */
  broken?: boolean;
};

export type PhotoCaptureProps = {
  open: boolean;
  /** What to photograph. */
  title: string;
  eyebrow?: string;
  /** Review this saved photo first; Retake replaces it. */
  existing?: ExistingPhoto | null;
  /** No new photos (e.g. time's up): review only. */
  readOnly?: boolean;
  readOnlyText?: string;
  saveLabel?: string;
  /** Persist the photo. Throw (e.g. a PhotoStoreError) to show an error and keep the photo for a retry. */
  onSave: (photo: CapturedPhoto) => Promise<void>;
  /** Optional "Save a copy" for the saved photo (an explicit download/share, never automatic). */
  onSaveCopy?: (image: Blob) => void;
  onClose: () => void;
};

const timeText = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** Object URL for a Blob, revoked when the Blob changes or the component unmounts. */
function useObjectUrl(blob: Blob | null) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) { setUrl(null); return; }
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}

/**
 * Full-screen camera for ONE photo: live preview (rear camera preferred) → shutter → review
 * (Retake / Save) → saved. When the live camera can't be used (permission denied, no camera,
 * unsupported or insecure page) or its preview never starts, the device's own camera app /
 * file picker is offered instead (`capture="environment"` opens the camera where supported).
 * The stream runs only while the preview is showing. Photos are re-encoded on the device
 * (no EXIF) and handed to `onSave`; this component never sends anything anywhere.
 */
export function PhotoCapture({
  open, title, eyebrow = "Snap", existing, readOnly = false, readOnlyText = "Time's up: no new photos.",
  saveLabel = "Save photo", onSave, onSaveCopy, onClose,
}: PhotoCaptureProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const lock = useRef(false);
  const titleId = useId();
  const statusId = useId();

  const [mode, setMode] = useState<Mode>({ kind: existing ? "existing" : "camera" });
  const [cam, setCam] = useState<Cam>("starting");
  const [frames, setFrames] = useState(false);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState(0);
  const [existingBlob, setExistingBlob] = useState<Blob | null>(null);
  const [existingState, setExistingState] = useState<"loading" | "ready" | "missing">("loading");

  const reviewPhoto = open && (mode.kind === "review" || mode.kind === "saving") ? mode.photo.image : null;
  const reviewUrl = useObjectUrl(reviewPhoto);
  const existingUrl = useObjectUrl(existingBlob);
  const busy = mode.kind === "saving" || mode.kind === "processing";

  // ---------------------------------------------------------- dialog ----
  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  // Every opening starts fresh; closing drops the captured photo (and its object URL) at once.
  useEffect(() => {
    if (!open) { setMode({ kind: "camera" }); return; }
    setMode({ kind: existing ? "existing" : "camera" });
    setError(null);
    lock.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset per opening only
  }, [open]);

  // ------------------------------------------------------- saved photo ----
  useEffect(() => {
    if (!open || !existing) { setExistingBlob(null); return; }
    let live = true;
    setExistingState("loading");
    existing.load()
      .then((b) => { if (!live) return; setExistingBlob(b); setExistingState(b && !existing.broken ? "ready" : "missing"); })
      .catch(() => { if (live) setExistingState("missing"); });
    return () => { live = false; setExistingBlob(null); };
  }, [open, existing]);

  // ------------------------------------------------------------ camera ----
  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setFrames(false);
  }, []);

  const startStream = useCallback(async () => {
    stopStream();
    setCam("starting");
    const r = await openCamera(navigator.mediaDevices, window.isSecureContext).catch((e) => ({ ok: false as const, reason: classifyCameraError(e) }));
    if (!r.ok) return setCam(r.reason);
    streamRef.current = r.stream;
    for (const t of r.stream.getVideoTracks()) t.onended = () => setCam("interrupted");
    setCam("live");
  }, [stopStream]);

  const wantCamera = open && mode.kind === "camera" && !readOnly;
  useEffect(() => {
    if (!wantCamera) { stopStream(); return; }
    let cancelled = false;
    void startStream().then(() => { if (cancelled) stopStream(); });
    return () => { cancelled = true; stopStream(); };
  }, [wantCamera, startStream, stopStream]);

  // Attach the stream once the <video> exists.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || cam !== "live" || !streamRef.current) return;
    const ready = () => setFrames(v.readyState >= 2 && v.videoWidth > 0);
    v.addEventListener("loadeddata", ready);
    v.addEventListener("playing", ready);
    v.srcObject = streamRef.current;
    void v.play().catch(() => undefined);
    return () => { v.removeEventListener("loadeddata", ready); v.removeEventListener("playing", ready); };
  }, [cam, mode.kind]);

  // A preview that never shows frames (some in-app browsers): offer the camera app after a few seconds.
  useEffect(() => {
    setSlow(false);
    if (!wantCamera || frames) return;
    const t = setTimeout(() => setSlow(true), 4000);
    return () => clearTimeout(t);
  }, [wantCamera, frames, cam]);

  // Back from another app: a dead stream is reopened.
  useEffect(() => {
    if (!wantCamera) return;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const alive = streamRef.current?.getVideoTracks().some((t) => t.readyState === "live");
      if (!alive) void startStream();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [wantCamera, startStream]);

  // -------------------------------------------------------- capturing ----
  const shoot = () => {
    const v = videoRef.current;
    if (lock.current || !v || v.readyState < 2 || !v.videoWidth) return;
    lock.current = true;
    setFlash((n) => n + 1);
    const pending = captureFromVideo(v); // the frame is grabbed synchronously, right now
    v.pause();
    setMode({ kind: "processing" });
    pending
      .then((photo) => { stopStream(); setMode({ kind: "review", photo }); })
      .catch((e) => { setError(e instanceof PhotoProcessError ? processHelp[e.kind] : processHelp.encode_failed); setMode({ kind: "camera" }); })
      .finally(() => { lock.current = false; });
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // don't keep the original around
    if (!file) return;
    setError(null);
    setMode({ kind: "processing" });
    captureFromFile(file)
      .then((photo) => { stopStream(); setMode({ kind: "review", photo }); })
      .catch((err) => { setError(err instanceof PhotoProcessError ? processHelp[err.kind] : processHelp.unreadable); setMode({ kind: "camera" }); });
  };

  const save = async () => {
    if (mode.kind !== "review") return;
    const photo = mode.photo;
    setError(null);
    setMode({ kind: "saving", photo });
    try {
      await onSave(photo);
      onClose();
    } catch (e) {
      const kind = e instanceof PhotoStoreError ? e.kind : classifyStorageError(e);
      setError(storeHelp[kind]);
      setMode({ kind: "review", photo });
    }
  };

  const retake = () => { setError(null); setMode({ kind: "camera" }); };
  const close = () => { if (!busy) onClose(); };

  // ------------------------------------------------------------- view ----
  const camHelp = cam !== "starting" && cam !== "live" ? cameraHelp[cam] : null;
  const fallbackLabel = camHelp ? "Use the camera app instead" : "Camera not showing? Use the camera app";

  let stage: React.ReactNode;
  if (mode.kind === "existing") {
    stage = existingState === "ready" && existingUrl ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={existingUrl} alt={`Your photo for: ${title}`} className="h-full w-full object-contain" />
    ) : existingState === "loading" ? (
      <div className="grid h-full place-items-center" role="status"><WaitingDots /><span className="sr-only">Loading your photo…</span></div>
    ) : (
      <div className="grid h-full place-items-center p-6 text-center" role="alert">
        <div className="grid max-w-xs justify-items-center gap-2">
          <TriangleAlert aria-hidden="true" className="size-10 text-brand-coral" />
          <p className="font-display text-xl font-semibold">This photo is no longer on this phone</p>
          <p className="text-white/80">The browser may have cleared its storage.{readOnly ? "" : " Take it again."}</p>
        </div>
      </div>
    );
  } else if (mode.kind === "review" || mode.kind === "saving") {
    // eslint-disable-next-line @next/next/no-img-element
    stage = reviewUrl ? <img src={reviewUrl} alt={`Photo to save for: ${title}`} className="h-full w-full object-contain" /> : null;
  } else if (mode.kind === "processing") {
    stage = <div className="grid h-full place-items-center" role="status"><div className="grid justify-items-center gap-2"><WaitingDots /><p>Getting your photo ready…</p></div></div>;
  } else if (readOnly) {
    stage = <div className="grid h-full place-items-center p-6 text-center" role="status"><p className="font-display text-2xl font-semibold">{readOnlyText}</p></div>;
  } else if (camHelp) {
    stage = (
      <div className="grid h-full place-items-center overflow-y-auto p-6 text-center" role="alert">
        <div className="grid max-w-sm justify-items-center gap-3">
          <CameraOff aria-hidden="true" className="size-10 text-brand-coral" />
          <p className="font-display text-xl font-semibold">{camHelp.title}</p>
          <p className="text-white/85">{camHelp.text}</p>
          <Button variant="outline-light" onClick={() => void startStream()}><RefreshCw aria-hidden="true" /> Try again</Button>
        </div>
      </div>
    );
  } else {
    stage = (
      <>
        <video ref={videoRef} playsInline muted autoPlay aria-label="Live camera preview" className="h-full w-full bg-black object-cover" />
        {cam === "starting" || !frames ? (
          <div className="absolute inset-0 grid place-items-center bg-black/60" role="status">
            <div className="grid justify-items-center gap-2"><WaitingDots /><p>{cam === "starting" ? "Opening the camera…" : "Starting the preview…"}</p></div>
          </div>
        ) : null}
        <div aria-hidden="true" className="pointer-events-none absolute inset-3">
          {["left-0 top-0 rounded-tl-2xl border-l-4 border-t-4", "right-0 top-0 rounded-tr-2xl border-r-4 border-t-4", "bottom-0 left-0 rounded-bl-2xl border-b-4 border-l-4", "bottom-0 right-0 rounded-br-2xl border-b-4 border-r-4"].map((c) => (
            <span key={c} className={cn("absolute size-9 border-white/90", c)} />
          ))}
        </div>
      </>
    );
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={statusId}
      onCancel={(e) => { e.preventDefault(); close(); }}
      className="m-0 h-dvh max-h-none w-screen max-w-none bg-brand-night p-0 text-white backdrop:bg-black open:animate-pop-in motion-reduce:open:animate-none"
    >
      {open ? (
        <div className="grid h-full grid-rows-[auto_minmax(0,1fr)_auto] pb-safe pt-safe">
          <header className="flex items-start justify-between gap-3 px-4 pb-3 pt-3 short:pb-2 short:pt-2">
            <div className="min-w-0">
              <p className="inline-block rounded-full bg-white/12 px-3 py-0.5 text-xs font-bold uppercase tracking-widest text-white/85">{eyebrow}</p>
              <h2 id={titleId} className="mt-1 break-words font-display text-3xl font-bold leading-tight text-brand-yellow short:text-2xl">{title}</h2>
            </div>
            <button type="button" onClick={close} disabled={busy} aria-label="Close camera"
              className="grid size-11 shrink-0 place-items-center rounded-full bg-white/12 transition-colors hover:bg-white/20 disabled:opacity-40">
              <X aria-hidden="true" className="size-6" />
            </button>
          </header>

          <div className="relative mx-3 min-h-0 overflow-hidden rounded-3xl bg-neutral-900">
            {stage}
            {flash > 0 ? <span key={flash} aria-hidden="true" className="pointer-events-none absolute inset-0 animate-shutter-flash bg-white opacity-0 motion-reduce:hidden" /> : null}
          </div>

          <footer className="grid min-h-32 content-center justify-items-center gap-3 px-4 py-3 short:min-h-28 short:py-2">
            <p id={statusId} className={cn("max-w-md text-center text-sm", error ? "font-semibold text-brand-coral" : "text-white/75")} role={error ? "alert" : "status"}>
              {error ??
                (mode.kind === "existing"
                  ? existingState === "ready"
                    ? `Saved on this phone at ${timeText(existing!.takenAt)}.${existing?.lockedText ? "" : readOnly ? "" : " Retake it if it isn't clear."}`
                    : " "
                  : mode.kind === "review"
                    ? "Is the thing clearly in the photo?"
                    : mode.kind === "saving"
                      ? "Saving on this phone…"
                      : readOnly || camHelp
                        ? " "
                        : "Fit the thing in the frame, then tap the button.")}
            </p>

            {mode.kind === "existing" ? (
              <div className="flex flex-wrap justify-center gap-3">
                {existing?.lockedText ? (
                  <p className="inline-flex items-center gap-2 rounded-full bg-white/12 px-4 py-2 text-sm font-semibold"><Lock aria-hidden="true" className="size-4" />{existing.lockedText}</p>
                ) : !readOnly ? (
                  <Button variant="camera" size="lg" onClick={retake}><RotateCcw aria-hidden="true" /> {existingState === "missing" ? "Take photo" : "Retake"}</Button>
                ) : null}
                {onSaveCopy && existingBlob && existingState === "ready" ? (
                  <Button variant="outline-light" size="lg" onClick={() => onSaveCopy(existingBlob)}><Download aria-hidden="true" /> Save a copy</Button>
                ) : null}
                <Button variant="outline-light" size="lg" onClick={close}>Done</Button>
              </div>
            ) : mode.kind === "review" || mode.kind === "saving" ? (
              <div className="flex flex-wrap justify-center gap-3">
                <Button variant="outline-light" size="lg" onClick={retake} disabled={mode.kind === "saving"}><RotateCcw aria-hidden="true" /> Retake</Button>
                <Button variant="camera" size="lg" onClick={() => void save()} disabled={mode.kind === "saving"}>
                  <Save aria-hidden="true" /> {mode.kind === "saving" ? "Saving…" : saveLabel}
                </Button>
              </div>
            ) : readOnly ? (
              <Button variant="outline-light" size="lg" onClick={close}>Close</Button>
            ) : (
              <div className="grid justify-items-center gap-2">
                {!camHelp ? (
                  <button
                    type="button"
                    aria-label="Take photo"
                    disabled={cam !== "live" || !frames || busy}
                    onClick={shoot}
                    className="relative grid size-20 touch-manipulation select-none place-items-center rounded-full border-4 border-white p-1.5 transition-transform motion-safe:active:scale-95 disabled:opacity-40"
                  >
                    <span className="grid size-full place-items-center rounded-full bg-brand-coral text-white shadow-pop-coral"><Camera aria-hidden="true" className="size-8" /></span>
                  </button>
                ) : null}
                <input ref={fileRef} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={onFile} />
                {camHelp ? (
                  <Button variant="camera" size="lg" onClick={() => fileRef.current?.click()}><ImageUp aria-hidden="true" /> {fallbackLabel}</Button>
                ) : slow ? (
                  <button type="button" onClick={() => fileRef.current?.click()} className="text-sm font-semibold text-white/75 underline underline-offset-4 hover:text-white">
                    {fallbackLabel}
                  </button>
                ) : null}
              </div>
            )}
          </footer>
        </div>
      ) : null}
    </dialog>
  );
}
