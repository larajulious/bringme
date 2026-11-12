"use client";

import { Camera, CameraOff, RefreshCw } from "lucide-react";

import { useCamera } from "@/components/game/camera-context";
import { Button } from "@/components/ui/button";
import { cameraHelp, type CameraFailure } from "@/lib/game/camera";

/** Permission step shown BEFORE the first round, plus clear guidance when something is wrong. */
export function CameraGate({ compact = false }: { compact?: boolean }) {
  const cam = useCamera();
  const s = cam.status;

  if (s === "ready") {
    return (
      <p className="inline-flex items-center gap-2 rounded-full bg-emerald-500/20 px-4 py-2 text-sm font-semibold" role="status">
        <Camera aria-hidden="true" className="size-4 text-emerald-300" /> Camera ready
      </p>
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
