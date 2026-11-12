"use client";

/**
 * On-device photo processing for local-only photos (BingoSnap). Everything happens in the
 * browser: frames are drawn onto a canvas and re-encoded as JPEG, which drops EXIF/GPS and any
 * other metadata, and the large original is never kept. Nothing here talks to the network.
 */
import { fitWithin } from "@/lib/game/camera";
import { encodeJpeg, grabFrame } from "@/lib/game/photo";

/** Long edge of the kept photo: clear enough for the host to inspect on the phone. */
export const PHOTO_MAX_EDGE = 1280;
/** Byte budget per photo (JPEG quality steps down until it fits). 25 cells ≈ 20 MB at most. */
export const PHOTO_MAX_BYTES = 800_000;
/** Long edge of the board thumbnail (a 5×5 cell on a 3× screen). */
export const THUMB_MAX_EDGE = 360;
const THUMB_QUALITY = 0.72;
/** Refuse absurd files from the picker before decoding them. */
export const MAX_PICKED_FILE_BYTES = 40_000_000;

export type PhotoSource = "camera" | "file";

export type CapturedPhoto = {
  /** The re-encoded JPEG (metadata-free). */
  image: Blob;
  /** A small JPEG for the board. */
  thumb: Blob;
  width: number;
  height: number;
  source: PhotoSource;
  /** Local capture time (ms since epoch, device clock). */
  takenAt: number;
};

export type PhotoProcessErrorKind = "not_an_image" | "too_large" | "unreadable" | "encode_failed";
export class PhotoProcessError extends Error {
  readonly kind: PhotoProcessErrorKind;
  constructor(kind: PhotoProcessErrorKind) {
    super(kind);
    this.kind = kind;
    this.name = "PhotoProcessError";
  }
}

/** Free a canvas' pixel buffer straight away (iOS Safari keeps them until GC otherwise). */
function release(canvas: HTMLCanvasElement) {
  canvas.width = 0;
  canvas.height = 0;
}

async function finish(canvas: HTMLCanvasElement, source: PhotoSource, takenAt: number): Promise<CapturedPhoto> {
  const { width, height } = canvas;
  try {
    const image = await encodeJpeg(canvas, PHOTO_MAX_BYTES);
    const t = fitWithin(width, height, THUMB_MAX_EDGE);
    const small = document.createElement("canvas");
    small.width = t.width;
    small.height = t.height;
    const ctx = small.getContext("2d");
    if (!ctx) throw new PhotoProcessError("encode_failed");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(canvas, 0, 0, t.width, t.height);
    const thumb = await new Promise<Blob | null>((r) => small.toBlob(r, "image/jpeg", THUMB_QUALITY));
    release(small);
    if (!thumb) throw new PhotoProcessError("encode_failed");
    return { image, thumb, width, height, source, takenAt };
  } catch (e) {
    throw e instanceof PhotoProcessError ? e : new PhotoProcessError("encode_failed");
  } finally {
    release(canvas);
  }
}

/** Grab the current frame of a live camera preview (synchronously), then encode it. */
export function captureFromVideo(video: HTMLVideoElement): Promise<CapturedPhoto> {
  const takenAt = Date.now();
  const { canvas } = grabFrame(video, PHOTO_MAX_EDGE);
  return finish(canvas, "camera", takenAt);
}

/**
 * Decode a photo chosen with the file picker / the phone's camera app, scale it down and
 * re-encode it. An <img> honours the EXIF orientation when drawn, so the result is upright;
 * the EXIF block itself is not carried over. The original File is not kept.
 */
export async function captureFromFile(file: File): Promise<CapturedPhoto> {
  if (file.type && !file.type.startsWith("image/")) throw new PhotoProcessError("not_an_image");
  if (file.size > MAX_PICKED_FILE_BYTES) throw new PhotoProcessError("too_large");
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.decoding = "async";
  try {
    img.src = url;
    await img.decode().catch(() => { throw new PhotoProcessError("unreadable"); });
    const { width, height } = fitWithin(img.naturalWidth, img.naturalHeight, PHOTO_MAX_EDGE);
    if (!width || !height) throw new PhotoProcessError("unreadable");
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new PhotoProcessError("encode_failed");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, width, height);
    return await finish(canvas, "file", Date.now());
  } finally {
    img.removeAttribute("src");
    URL.revokeObjectURL(url);
  }
}

export const processHelp: Record<PhotoProcessErrorKind, string> = {
  not_an_image: "That file isn't a photo. Pick or take a photo instead.",
  too_large: "That file is too big. Take a new photo instead.",
  unreadable: "This browser couldn't open that photo. Try taking it again.",
  encode_failed: "We couldn't prepare that photo. Try taking it again.",
};
