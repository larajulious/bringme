import type { NextRequest } from "next/server";

import { HttpError, handle, isUuid, json, readJson } from "@/lib/api/http";
import { requireUser } from "@/lib/auth/guards";
import { HOST_ACTIONS, type HostAction } from "@/lib/game/types";
import { toHttpError } from "@/lib/host/errors";

/**
 * The single endpoint for every Game Master control (start game, countdown,
 * round, close, review, winner, next round, end, cancel).
 *
 * It does NOT decide anything itself: it validates the shape of the request and
 * calls game_transition() as the signed-in host. Ownership, the allowed
 * transition table, subscription checks, row locking and the optimistic
 * version check all live in PostgreSQL, so they hold no matter how the request
 * is made. `expectedVersion` makes duplicate/replayed/concurrent requests fail
 * with 409 stale_state instead of acting twice.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) throw new HttpError(400, "invalid_game");

    const body = await readJson(request);
    if (typeof body.action !== "string" || !(HOST_ACTIONS as readonly string[]).includes(body.action)) {
      throw new HttpError(400, "invalid_action");
    }
    if (!Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number) < 0) {
      throw new HttpError(400, "invalid_version");
    }
    let winner: string | undefined;
    if (body.winnerPlayerId !== undefined && body.winnerPlayerId !== null) {
      if (!isUuid(body.winnerPlayerId)) throw new HttpError(400, "invalid_winner");
      winner = body.winnerPlayerId;
    }

    const { data, error } = await supabase.rpc("game_transition", {
      p_game: id,
      p_action: body.action as HostAction,
      p_expected_version: body.expectedVersion as number,
      p_winner: winner,
    });
    if (error) throw toHttpError(error.message);
    return json({ state: data });
  });
}
