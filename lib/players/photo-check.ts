import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { SUBMISSION_BUCKET } from "./submission";

export type PhotoVerdict = { ok: true; bytes: number } | { ok: false; reason: "missing" | "invalid" };

const MIN_BYTES = 1024; // anything smaller is not a real camera frame

/**
 * Verify the stored object before a submission can be created: it exists, is
 * an image/jpeg of a sane size (within the platform limit) and really starts
 * with the JPEG signature (FF D8 FF), not just a trusted Content-Type header.
 */
export async function verifyStoredPhoto(path: string): Promise<PhotoVerdict> {
  const admin = createAdminClient();
  const bucket = admin.storage.from(SUBMISSION_BUCKET);

  const { data: info } = await bucket.info(path);
  if (!info) return { ok: false, reason: "missing" };

  const { data: settings } = await admin.from("platform_settings").select("max_photo_size_mb").eq("id", true).maybeSingle();
  const maxBytes = (settings?.max_photo_size_mb ?? 5) * 1024 * 1024;
  const size = Number((info as { size?: number }).size ?? 0);
  if ((info as { contentType?: string }).contentType !== "image/jpeg" || size < MIN_BYTES || size > maxBytes) {
    return { ok: false, reason: "invalid" };
  }

  const { data: blob } = await bucket.download(path);
  if (!blob) return { ok: false, reason: "missing" };
  const head = new Uint8Array(await blob.slice(0, 3).arrayBuffer());
  if (!(head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff)) return { ok: false, reason: "invalid" };
  return { ok: true, bytes: size };
}

export async function discardStoredPhoto(path: string): Promise<void> {
  await createAdminClient().storage.from(SUBMISSION_BUCKET).remove([path]);
}
