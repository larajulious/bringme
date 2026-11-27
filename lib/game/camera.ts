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

export type CameraFacing = "environment" | "user";
export type ResolvedCameraFacing = CameraFacing | "unknown";

export type OpenCameraOptions = {
  /** Desired camera lens: rear ("environment", default) or selfie ("user"). */
  facing?: CameraFacing;
  /** Require the requested facing first before falling back to any camera (used when flipping). */
  exact?: boolean;
};

export type OpenCameraResult =
  | { ok: true; stream: MediaStream; facing: ResolvedCameraFacing }
  | { ok: false; reason: CameraFailure };

type MediaDevicesLike = { getUserMedia?: (c: MediaStreamConstraints) => Promise<MediaStream> };

/**
 * Open the requested camera (rear by default) at a high-ish resolution; if the
 * device can't satisfy that, retry with looser constraints down to any camera.
 * Permission/security/busy errors are NOT retried.
 * Must be called from a user gesture on iOS Safari.
 */
export async function openCamera(
  mediaDevices: MediaDevicesLike | undefined,
  isSecureContext: boolean,
  options: OpenCameraOptions = {},
): Promise<OpenCameraResult> {
  if (!isSecureContext) return { ok: false, reason: "insecure" };
  if (!mediaDevices?.getUserMedia) return { ok: false, reason: "unsupported" };
  const wanted: CameraFacing = options.facing ?? "environment";
  const attempts: { constraints: MediaStreamConstraints; exact: boolean }[] = options.exact
    ? [
        { constraints: { audio: false, video: { facingMode: { exact: wanted }, width: { ideal: 1920 }, height: { ideal: 1080 } } }, exact: true },
        { constraints: { audio: false, video: { facingMode: { exact: wanted } } }, exact: true },
        { constraints: { audio: false, video: { facingMode: { ideal: wanted }, width: { ideal: 1920 }, height: { ideal: 1080 } } }, exact: false },
        { constraints: { audio: false, video: true }, exact: false },
      ]
    : [
        { constraints: { audio: false, video: { facingMode: { ideal: wanted }, width: { ideal: 1920 }, height: { ideal: 1080 } } }, exact: false },
        { constraints: { audio: false, video: true }, exact: false },
      ];
  let last: unknown;
  for (const { constraints, exact } of attempts) {
    try {
      const stream = await mediaDevices.getUserMedia(constraints);
      const f = stream.getVideoTracks()[0]?.getSettings?.().facingMode;
      const facing: ResolvedCameraFacing = f === "environment" || f === "user" ? f : exact ? wanted : "unknown";
      return { ok: true, stream, facing };
    } catch (e) {
      last = e;
      const kind = classifyCameraError(e);
      if (kind === "denied" || kind === "insecure" || kind === "busy") break;
    }
  }
  return { ok: false, reason: classifyCameraError(last) };
}

/** The opposite lens to switch to when the player flips the camera. */
export function flipFacing(actual: ResolvedCameraFacing, preferred: CameraFacing): CameraFacing {
  const current = actual === "environment" || actual === "user" ? actual : preferred;
  return current === "environment" ? "user" : "environment";
}

/** Whether the active preview and capture should be mirrored like a selfie camera. */
export function isSelfieFacing(actual: ResolvedCameraFacing, preferred: CameraFacing): boolean {
  return actual === "user" || (actual === "unknown" && preferred === "user");
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
