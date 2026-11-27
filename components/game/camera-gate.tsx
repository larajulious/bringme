"use client";

import { Camera, CameraOff, RefreshCw, SwitchCamera } from "lucide-react";

import { useCamera } from "@/components/game/camera-context";
import { Button } from "@/components/ui/button";
import { cameraHelp, isSelfieFacing, type CameraFailure } from "@/lib/game/camera";
import { cn } from "@/lib/utils";

/** Permission step shown BEFORE the first round, plus clear guidance when something is wrong. */
export function CameraGate({ compact = false }: { compact?: boolean }) {
  const cam = useCamera();
  const s = cam.status;

  if (s === "ready") {
    const isSelfie = isSelfieFacing(cam.facing, cam.preferredFacing);
    return (
      <div className="inline-flex flex-wrap items-center justify-center gap-2">
        <p className="inline-flex items-center gap-2 rounded-full bg-emerald-500/20 px-4 py-2 text-sm font-semibold" role="status">
          <Camera aria-hidden="true" className="size-4 text-emerald-300" />
          {isSelfie ? "Selfie camera ready" : "Camera ready"}
        </p>
        {!compact ? (
          <button
            type="button"
            disabled={cam.switching}
            onClick={() => void cam.switchCamera()}
            aria-label={isSelfie ? "Switch to back camera" : "Switch to selfie camera"}
            aria-pressed={isSelfie}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-white/25 bg-white/10 px-3 py-1.5 text-xs font-semibold text-white/90 transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-yellow disabled:opacity-40"
          >
            <SwitchCamera aria-hidden="true" className={cn("size-3.5", cam.switching && "animate-spin motion-reduce:animate-none")} />
            {isSelfie ? "Use back" : "Use selfie"}
          </button>
        ) : null}
      </div>
    );
  }

  const failure = s !== "idle" && s !== "requesting" && s !== "interrupted" ? (s as CameraFailure) : s === "interrupted" ? "interrupted" : null;
  const help = failure ? cameraHelp[failure] : null;

  return (
    <div className={compact ? "grid gap-3 text-center" : "grid max-w-sm gap-3 rounded-4xl bg-white/10 p-5 text-center"} role="status">
      {help ? (
        <>
          <CameraOff aria-hidden="true" className="mx-auto size-8 text-brand-coral" />
          <p className="font-display text-xl font-semibold">{help.title}</p>
          <p className="text-white/85">{help.text}</p>
        </>
      ) : (
        <>
          <Camera aria-hidden="true" className="mx-auto size-8 text-brand-yellow" />
          <p className="font-display text-xl font-semibold">Get your camera ready</p>
          <p className="text-white/85">You&apos;ll snap photos to win rounds. Turn the camera on now so you don&apos;t miss the start.</p>
        </>
      )}
      <Button variant="camera" size="lg" disabled={s === "requesting"} onClick={() => void cam.enable()}>
        {help ? <RefreshCw aria-hidden="true" /> : <Camera aria-hidden="true" />}
        {s === "requesting" ? "Waiting for permission…" : help ? "Try again" : "Turn on camera"}
      </Button>
    </div>
  );
}
