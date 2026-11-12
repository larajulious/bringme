import type { NextRequest } from "next/server";

import { HttpError, handle, isUuid, json, readJson } from "@/lib/api/http";
import { requireUser } from "@/lib/auth/guards";
import { toHttpError } from "@/lib/host/errors";

const DECISIONS = ["approve", "disqualify", "reset"] as const;

/**
 * Approve / disqualify / undo one photo. Validated in SQL as the signed-in host
 * (ownership, current round, review not yet locked by a confirmed winner); this
 * handler only checks the shape of the request.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; submissionId: string }> }) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const { submissionId } = await params;
    if (!isUuid(submissionId)) throw new HttpError(400, "invalid_submission");
    const body = await readJson(request);
    const decision = DECISIONS.find((d) => d === body.decision);
    if (!decision) throw new HttpError(400, "invalid_decision");

    const { data, error } = await supabase.rpc("review_submission", { p_submission: submissionId, p_decision: decision });
    if (error) throw toHttpError(error.message);
    return json({ state: data });
  });
}
