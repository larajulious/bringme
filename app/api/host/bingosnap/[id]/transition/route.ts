import type { NextRequest } from "next/server";

import { HttpError, handle, isUuid, json, readJson } from "@/lib/api/http";
import { requireUser } from "@/lib/auth/guards";
import { toBingoHttpError } from "@/lib/bingosnap/errors";
import { parseTransitionInput } from "@/lib/bingosnap/validation";

/**
 * Every BingoSnap lifecycle control (start, countdown, hunt, close, results,
 * end, cancel, archive). Ownership, the transition table, the Game Pass check
 * at start, row locking and the expected-version check live in
 * bingo_transition(); this handler validates only the request shape.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) throw new HttpError(400, "invalid_game");
    const parsed = parseTransitionInput(await readJson(request));
    if (!parsed.ok) throw new HttpError(400, parsed.error);

    const { data, error } = await supabase.rpc("bingo_transition", {
      p_game: id,
      p_action: parsed.value.action,
      p_expected_version: parsed.value.expectedVersion,
      p_winner_submission: parsed.value.winnerSubmissionId ?? undefined,
    });
    if (error) throw toBingoHttpError(error.message);
    return json({ state: data });
  });
}
