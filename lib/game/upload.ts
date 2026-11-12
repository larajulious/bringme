"use client";

import { SubmitError } from "./submit-flow";

const TIMEOUT_MS = 40_000;

/**
 * PUT the JPEG to the single-use signed upload URL with progress events (XHR:
 * fetch can't report upload progress). Network trouble => retryable error.
 */
export function uploadWithProgress(blob: Blob, uploadUrl: string, onProgress: (fraction: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    xhr.timeout = TIMEOUT_MS;
    xhr.setRequestHeader("content-type", "image/jpeg");
    xhr.setRequestHeader("cache-control", "max-age=3600");
    xhr.setRequestHeader("x-upsert", "false");
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (key) {
      xhr.setRequestHeader("apikey", key);
      xhr.setRequestHeader("authorization", `Bearer ${key}`);
    }
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      // too big / wrong type: this photo can never be accepted
      if (xhr.status === 413 || xhr.status === 415) return reject(new SubmitError("invalid_image", false));
      // expired/invalid token, 5xx, throttling…: ask for a fresh URL and try again
      reject(new SubmitError("network", true));
    };
    xhr.onerror = () => reject(new SubmitError("network", true));
    xhr.ontimeout = () => reject(new SubmitError("network", true));
    xhr.onabort = () => reject(new SubmitError("network", true));
    xhr.send(blob);
  });
}
