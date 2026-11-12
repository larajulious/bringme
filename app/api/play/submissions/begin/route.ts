import type { NextRequest } from "next/server";

import { HttpError, handle, isUuid, json, readJson } from "@/lib/api/http";
import { parseElapsedMs, sanitizeClientMeta } from "@/lib/game/timing";
import { toHttpError } from "@/lib/host/errors";
import { requireTokenHash } from "@/lib/players/session";
import { SUBMISSION_BUCKET, submissionPath } from "@/lib/players/submission";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Step 1, called AT TAP TIME (in parallel with photo compression).
 * The database records the server-side intent timestamp, enforces one capture
 * per player per round, and checks session / game / round state. Only then does
 * the server hand out a single-use signed upload URL for ONE server-derived path.
 * Idempotent: the same attemptId may call again (retry) and keeps its timing.
 */
export async function POST(request: NextRequest) {
  return handle(async () => {
    const tokenHash = requireTokenHash(request);
    const body = await readJson(request);
    if (!isUuid(body.roundId) || !isUuid(body.attemptId)) throw new HttpError(400, "invalid_request");
    const elapsed = parseElapsedMs(body.elapsedMs);
    if (elapsed === null) throw new HttpError(400, "invalid_timing");

    const admin = createAdminClient();
    const { data, error } = await admin.rpc("begin_submission", {
      p_token_hash: tokenHash,
      p_round: body.roundId,
      p_attempt: body.attemptId,
      p_elapsed_ms: elapsed,
      p_meta: sanitizeClientMeta(body.meta),
    });
    if (error) throw toHttpError(error.message);

    const r = data as { status: string; gameId?: string; playerId?: string; elapsedMs?: number | null; rankMs?: number | null; timing?: string };
    if (r.status === "already_submitted") {
      return json({ status: "already_submitted", elapsedMs: r.elapsedMs ?? null, timing: r.timing ?? null });
    }

    // The path comes ONLY from ids the database verified for this session.
    const path = submissionPath({ gameId: r.gameId!, roundId: body.roundId, playerId: r.playerId!, contentType: "image/jpeg" });
    const bucket = admin.storage.from(SUBMISSION_BUCKET);
    await bucket.remove([path]); // clear a half-uploaded earlier try of THIS capture
    const { data: signed, error: signErr } = await bucket.createSignedUploadUrl(path); // upsert=false
    if (signErr || !signed) throw new HttpError(503, "upload_unavailable");
    return json({ status: r.status, uploadUrl: signed.signedUrl });
  });
}
