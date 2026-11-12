/** Camera access helpers (pure; browser objects are injected so they can be tested). */

export type CameraFailure = "denied" | "no_camera" | "busy" | "insecure" | "unsupported" | "interrupted" | "unknown";

export function classifyCameraError(e: unknown): CameraFailure {
  const name = (e as { name?: string } | null)?.name ?? "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return "denied";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "no_camera";
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return "busy";
    case "SecurityError":
      return "insecure";
    case "TypeError":
    case "NotSupportedError":
      return "unsupported";
    default:
      return "unknown";
  }
}

export const cameraHelp: Record<CameraFailure, { title: string; text: string }> = {
  denied: {
    title: "Camera access is blocked",
    text: "Allow the camera for this site: tap the lock or aA icon in the address bar → Site settings / Website settings → Camera → Allow, then try again.",
  },
  no_camera: { title: "No camera found", text: "This device doesn't seem to have a camera we can use. Try another phone or tablet." },
  busy: { title: "Camera is in use", text: "Another app or tab is using the camera. Close it, then try again." },
  insecure: { title: "Camera needs a secure page", text: "Open this game from its https:// link so the browser will allow the camera." },
  unsupported: { title: "Camera not supported", text: "This browser can't open the camera. Try Safari, Chrome or Firefox." },
  interrupted: { title: "Camera paused", text: "The camera was interrupted, maybe by a call or another app. Tap to turn it back on." },
  unknown: { title: "Couldn't start the camera", text: "Something went wrong opening the camera. Try again." },
};

export type OpenCameraResult =
  | { ok: true; stream: MediaStream; facing: "environment" | "user" | "unknown" }
  | { ok: false; reason: CameraFailure };

type MediaDevicesLike = { getUserMedia?: (c: MediaStreamConstraints) => Promise<MediaStream> };

/**
 * Prefer the rear camera at a high-ish resolution; if the device can't satisfy
 * that, retry with any camera. Permission errors are NOT retried.
 * Must be called from a user gesture on iOS Safari.
 */
export async function openCamera(
  mediaDevices: MediaDevicesLike | undefined,
  isSecureContext: boolean,
): Promise<OpenCameraResult> {
  if (!isSecureContext) return { ok: false, reason: "insecure" };
  if (!mediaDevices?.getUserMedia) return { ok: false, reason: "unsupported" };
  const attempts: MediaStreamConstraints[] = [
    { audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } } },
    { audio: false, video: true },
  ];
  let last: unknown;
  for (const c of attempts) {
    try {
      const stream = await mediaDevices.getUserMedia(c);
      const f = stream.getVideoTracks()[0]?.getSettings?.().facingMode;
      return { ok: true, stream, facing: f === "environment" || f === "user" ? f : "unknown" };
    } catch (e) {
      last = e;
      const kind = classifyCameraError(e);
      if (kind === "denied" || kind === "insecure" || kind === "busy") break;
    }
  }
  return { ok: false, reason: classifyCameraError(last) };
}

/** Scale to fit `maxEdge` on the long side (never upscale), integer sizes. */
export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: 0, height: 0 };
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Descending JPEG quality steps used until the file fits the byte budget. */
export const QUALITY_LADDER = [0.82, 0.7, 0.58, 0.45] as const;
export const TARGET_MAX_BYTES = 1_500_000;
export const MAX_EDGE_PX = 1600;
