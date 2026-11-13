/**
 * Validation of an uploaded photo without downloading it (Phase 3, audit G8). Pure: Storage access
 * is injected, so the rules are unit-tested with honoured AND ignored Range requests.
 *
 * Same checks as before, in the same order:
 *  1. the object exists (Storage metadata),
 *  2. its stored type is image/jpeg and its size is within [1 KiB, platform limit],
 *  3. its first bytes really are a JPEG (FF D8 FF), not just a trusted Content-Type.
 * Step 3 reads only the beginning of the object. We ask Storage for `Range: bytes=0-2`, but never
 * rely on it: the stream is read only until enough bytes arrived and then cancelled, so even a
 * server that ignores the Range header and sends the whole file costs at most one network chunk.
 */
export const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const;
export const MIN_PHOTO_BYTES = 1024; // anything smaller is not a real camera frame
/** Safety cap on what a prefix read may buffer, whatever the server sends. */
export const PREFIX_BUFFER_CAP = 256 * 1024;

export type PhotoVerdict =
  | { ok: true; bytes: number; bytesBuffered: number }
  | { ok: false; reason: "missing" | "invalid" | "unavailable"; bytesBuffered: number };

/** `unavailable` = Storage didn't answer properly (5xx, network): retry, don't blame the photo. */
export type Lookup<T> = T | null | "unavailable";

export type ProbeDeps = {
  info(): Promise<Lookup<{ size: number; contentType: string | null }>>;
  maxBytes(): Promise<number>;
  /** The object's byte stream from offset 0 (a Range may or may not be honoured), or null if absent. */
  stream(firstBytes: number): Promise<Lookup<{ body: ReadableStream<Uint8Array>; abort: () => void }>>;
};

/**
 * Read the first `n` bytes of a stream, then stop: the reader is cancelled (and the request aborted
 * by the caller), so the rest of the object is never buffered. `bytesBuffered` = what actually arrived.
 */
export async function readPrefix(body: ReadableStream<Uint8Array>, n: number, cap = PREFIX_BUFFER_CAP): Promise<{ head: Uint8Array; bytesBuffered: number }> {
  const reader = body.getReader();
  const head = new Uint8Array(n);
  let have = 0;
  let buffered = 0;
  try {
    while (have < n && buffered < cap) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      buffered += value.byteLength;
      const take = Math.min(n - have, value.byteLength);
      head.set(value.subarray(0, take), have);
      have += take;
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  return { head: head.subarray(0, have), bytesBuffered: buffered };
}

export const isJpegSignature = (head: Uint8Array) =>
  head.length >= JPEG_SIGNATURE.length && JPEG_SIGNATURE.every((b, i) => head[i] === b);

export async function probePhoto(deps: ProbeDeps): Promise<PhotoVerdict> {
  const [info, maxBytes] = await Promise.all([deps.info(), deps.maxBytes()]);
  if (info === "unavailable") return { ok: false, reason: "unavailable", bytesBuffered: 0 };
  if (!info) return { ok: false, reason: "missing", bytesBuffered: 0 };
  const type = (info.contentType ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "image/jpeg" || !(info.size >= MIN_PHOTO_BYTES) || info.size > maxBytes) {
    return { ok: false, reason: "invalid", bytesBuffered: 0 };
  }
  const s = await deps.stream(JPEG_SIGNATURE.length);
  if (s === "unavailable") return { ok: false, reason: "unavailable", bytesBuffered: 0 };
  if (!s) return { ok: false, reason: "missing", bytesBuffered: 0 };
  let prefix: { head: Uint8Array; bytesBuffered: number };
  try {
    prefix = await readPrefix(s.body, JPEG_SIGNATURE.length);
  } catch {
    return { ok: false, reason: "unavailable", bytesBuffered: 0 };
  } finally {
    s.abort();
  }
  if (!isJpegSignature(prefix.head)) return { ok: false, reason: "invalid", bytesBuffered: prefix.bytesBuffered };
  return { ok: true, bytes: info.size, bytesBuffered: prefix.bytesBuffered };
}
