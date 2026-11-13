import type { NextRequest } from "next/server";

import { HttpError, handle, isUuid, json, readJson } from "@/lib/api/http";
import { sanitizeClientMeta } from "@/lib/game/timing";
import { toHttpError } from "@/lib/host/errors";
import { discardStoredPhoto, verifyStoredPhoto } from "@/lib/players/photo-check";
import { PLAYER_COOKIE, getPlayerState, requireTokenHash } from "@/lib/players/session";
import { submissionPath } from "@/lib/players/submission";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Step 2, after the browser finished uploading. The server re-derives the path
 * from the verified session, checks the stored photo (type, size, JPEG
 * signature) and only then asks the database to create THE submission, which
 * computes the timing flags/rank and refuses duplicates. Safe to retry: a
 * second call for an accepted capture returns the same accepted result.
 */
export async function POST(request: NextRequest) {
  return handle(async () => {
    const tokenHash = requireTokenHash(request);
    const body = await readJson(request);
    if (!isUuid(body.roundId) || !isUuid(body.attemptId)) throw new HttpError(400, "invalid_request");

    const me = await getPlayerState(request.cookies.get(PLAYER_COOKIE)?.value);
    if (!me) throw new HttpError(401, "invalid_session");
    const path = submissionPath({ gameId: me.gameId, roundId: body.roundId, playerId: me.me.id, contentType: "image/jpeg" });
    const admin = createAdminClient();

    // Already accepted? Answer without re-validating a photo that may since have been reviewed.
    if (me.me.hasSubmitted && me.round?.id === body.roundId && me.me.submission) {
      return json({ status: "duplicate", elapsedMs: me.me.submission.elapsedMs, timing: me.me.submission.timing });
    }

    const verdict = await verifyStoredPhoto(path);
    if (!verdict.ok) {
      if (verdict.reason === "invalid") {
        await discardStoredPhoto(path);
        await admin.rpc("discard_submission_intent", { p_token_hash: tokenHash, p_round: body.roundId, p_attempt: body.attemptId });
        throw new HttpError(422, "invalid_image");
      }
      throw new HttpError(409, "upload_missing"); // the browser may simply retry the upload
    }

    const { data, error } = await admin.rpc("complete_submission", {
      p_token_hash: tokenHash,
      p_round: body.roundId,
      p_attempt: body.attemptId,
      p_meta: { ...sanitizeClientMeta(body.meta), bytes: verdict.bytes },
    });
    if (error) throw toHttpError(error.message, error.code);
    const r = data as { status: string; elapsedMs: number; timing: string };
    return json({ status: r.status, elapsedMs: r.elapsedMs, timing: r.timing }, r.status === "accepted" ? 201 : 200);
  });
}
