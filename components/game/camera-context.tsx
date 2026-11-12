"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { openCamera, type CameraFailure } from "@/lib/game/camera";

export type CameraStatus = "idle" | "requesting" | "ready" | "interrupted" | CameraFailure;

type CameraCtx = {
  status: CameraStatus;
  facing: "environment" | "user" | "unknown";
  stream: MediaStream | null;
  /** Must be called from a tap/click (iOS Safari requires a user gesture). */
  enable: () => Promise<void>;
  /** Pause/resume frame delivery without releasing the permission. */
  setActive: (on: boolean) => void;
  stop: () => void;
};

const Ctx = createContext<CameraCtx | null>(null);

export function useCamera(): CameraCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useCamera must be used inside <CameraProvider>");
  return c;
}

/**
 * Owns the camera stream for the whole game so it is ready (permission granted,
 * stream open) BEFORE the first round, and survives screen changes. Handles
 * interruptions (calls, other apps, tab backgrounding) by flipping to
 * "interrupted" and re-opening when the tab is visible again.
 */
export function CameraProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<CameraStatus>("idle");
  const [facing, setFacing] = useState<CameraCtx["facing"]>("unknown");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const opening = useRef(false);

  const release = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => { t.onended = null; t.onmute = null; t.onunmute = null; t.stop(); });
    streamRef.current = null;
    setStream(null);
  }, []);

  const enable = useCallback(async () => {
    if (opening.current) return;
    opening.current = true;
    setStatus("requesting");
    release();
    const r = await openCamera(navigator.mediaDevices, window.isSecureContext);
    opening.current = false;
    if (!r.ok) return setStatus(r.reason);
    for (const t of r.stream.getVideoTracks()) {
      t.onended = () => setStatus((cur) => (cur === "ready" ? "interrupted" : cur));
      t.onmute = () => setStatus((cur) => (cur === "ready" ? "interrupted" : cur));
      t.onunmute = () => setStatus((cur) => (cur === "interrupted" && t.readyState === "live" ? "ready" : cur));
    }
    streamRef.current = r.stream;
    setStream(r.stream);
    setFacing(r.facing);
    setStatus("ready");
  }, [release]);

  // Already allowed on this device? Open it without waiting for a tap (not supported everywhere: optional).
  useEffect(() => {
    let live = true;
    navigator.permissions?.query({ name: "camera" as PermissionName })
      .then((p) => { if (live && p.state === "granted") void enable(); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [enable]);

  // Back from the background: re-check, and silently re-open if the stream died.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible" || !streamRef.current) return;
      const alive = streamRef.current.getVideoTracks().some((t) => t.readyState === "live");
      if (!alive) void enable();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [enable]);

  useEffect(() => release, [release]);

  const setActive = useCallback((on: boolean) => {
    streamRef.current?.getVideoTracks().forEach((t) => { t.enabled = on; });
  }, []);
  const stop = useCallback(() => { release(); setStatus("idle"); }, [release]);

  return <Ctx.Provider value={{ status, facing, stream, enable, setActive, stop }}>{children}</Ctx.Provider>;
}
