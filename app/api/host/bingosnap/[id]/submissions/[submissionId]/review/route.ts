import type { NextRequest } from "next/server";

import { HttpError, handle, isUuid, json, readJson } from "@/lib/api/http";
import { requireUser } from "@/lib/auth/guards";
import { toBingoHttpError } from "@/lib/bingosnap/errors";
import { parseReviewInput } from "@/lib/bingosnap/validation";

/**
 * Verify / reject (optional reason) / reset one BingoSnap claim after checking
 * the participant's photos in person. Ownership, game status and the review
 * lock are enforced in bingo_review_submission(); a claim of another host's
 * game is reported as not found.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; submissionId: string }> }) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const { id, submissionId } = await params;
    if (!isUuid(id)) throw new HttpError(400, "invalid_game");
    if (!isUuid(submissionId)) throw new HttpError(400, "invalid_submission");
    const parsed = parseReviewInput(await readJson(request));
    if (!parsed.ok) throw new HttpError(400, parsed.error);

    // The URL's game must be the claim's game (RLS: only the owner can see the row).
    const { data: row, error: lookupErr } = await supabase.from("bingo_submissions").select("game_id").eq("id", submissionId).maybeSingle();
    if (lookupErr) throw new HttpError(500, "lookup_failed");
    if (!row || row.game_id !== id) throw new HttpError(404, "submission_not_found");

    const { data, error } = await supabase.rpc("bingo_review_submission", {
      p_submission: submissionId,
      p_decision: parsed.value.decision,
      p_reason: parsed.value.reason ?? undefined,
    });
    if (error) throw toBingoHttpError(error.message);
    return json({ state: data });
  });
}
