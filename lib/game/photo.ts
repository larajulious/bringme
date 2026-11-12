"use client";

import { MAX_EDGE_PX, QUALITY_LADDER, TARGET_MAX_BYTES, fitWithin } from "./camera";

/**
 * Grab the current video frame SYNCHRONOUSLY. This is the capture itself; call
 * it first thing in the tap handler. The frame is scaled down while drawing, so
 * "compression" starts here at no extra cost.
 */
export function grabFrame(video: HTMLVideoElement, maxEdge: number = MAX_EDGE_PX): { canvas: HTMLCanvasElement; width: number; height: number } {
  const { width, height } = fitWithin(video.videoWidth, video.videoHeight, maxEdge);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")?.drawImage(video, 0, 0, width, height);
  return { canvas, width, height };
}

/** JPEG-encode, stepping quality down until the file fits the budget. */
export async function encodeJpeg(canvas: HTMLCanvasElement, maxBytes = TARGET_MAX_BYTES): Promise<Blob> {
  let last: Blob | null = null;
  for (const q of QUALITY_LADDER) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", q));
    if (!blob) throw new Error("encode_failed");
    last = blob;
    if (blob.size <= maxBytes) return blob;
  }
  return last!;
}
