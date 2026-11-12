import type { NextRequest } from "next/server";

import { HttpError, handle, isUuid, json } from "@/lib/api/http";
import { requireUser } from "@/lib/auth/guards";

/**
 * Remove (kick) a player. Runs as the host: RLS only lets the game's owner
 * update its players, and the query is also scoped to this game. A removed
 * player's token stops resolving (requireGuestPlayer rejects kicked players).
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string; playerId: string }> }) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const { id, playerId } = await params;
    if (!isUuid(id) || !isUuid(playerId)) throw new HttpError(400, "invalid_id");

    const { data, error } = await supabase
      .from("players")
      .update({ kicked_at: new Date().toISOString() })
      .eq("id", playerId)
      .eq("game_id", id)
      .is("kicked_at", null)
      .select("id")
      .maybeSingle();
    if (error) throw new HttpError(500, "request_failed");
    if (!data) throw new HttpError(404, "player_not_found");
    return json({ ok: true });
  });
}
