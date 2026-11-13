import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { probePhoto, type Lookup, type PhotoVerdict } from "./photo-probe";
import { SUBMISSION_BUCKET } from "./submission";

export type { PhotoVerdict } from "./photo-probe";

/** 4xx from Storage = no such object; 5xx / network / unknown = Storage trouble (retry, don't blame the photo). */
function lookupFailure(error: unknown): "unavailable" | null {
  const status = Number((error as { status?: unknown; statusCode?: unknown } | null)?.status ?? (error as { statusCode?: unknown } | null)?.statusCode);
  return Number.isFinite(status) && status >= 400 && status < 500 ? null : "unavailable";
}

/**
 * Verify the stored object before a submission can be created: it exists, is an image/jpeg of a sane
 * size (within the platform limit) and really starts with the JPEG signature (FF D8 FF), not just a
 * trusted Content-Type header. Phase 3: the signature is read from a bounded stream (Range 0-2, then
 * cancelled) instead of downloading the whole photo into the function. Service role, server only.
 */
export async function verifyStoredPhoto(path: string): Promise<PhotoVerdict> {
  const admin = createAdminClient();
  return probePhoto({
    info: async (): Promise<Lookup<{ size: number; contentType: string | null }>> => {
      const { data, error } = await admin.storage.from(SUBMISSION_BUCKET).info(path);
      if (error || !data) return error ? lookupFailure(error) : null;
      const d = data as { size?: number; contentType?: string };
      return { size: Number(d.size ?? 0), contentType: d.contentType ?? null };
    },
    maxBytes: async () => {
      const { data: settings } = await admin.from("platform_settings").select("max_photo_size_mb").eq("id", true).maybeSingle();
      return (settings?.max_photo_size_mb ?? 5) * 1024 * 1024;
    },
    stream: async (firstBytes) => {
      const abort = new AbortController();
      const { data: body, error } = await admin.storage.from(SUBMISSION_BUCKET)
        .setHeader("Range", `bytes=0-${firstBytes - 1}`)
        .download(path, {}, { signal: abort.signal })
        .asStream();
      if (error || !body) { abort.abort(); return error ? lookupFailure(error) : null; }
      return { body: body as ReadableStream<Uint8Array>, abort: () => abort.abort() };
    },
  });
}

export async function discardStoredPhoto(path: string): Promise<void> {
  await createAdminClient().storage.from(SUBMISSION_BUCKET).remove([path]);
}
