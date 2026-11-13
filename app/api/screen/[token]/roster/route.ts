import type { NextRequest } from "next/server";

import { HttpError, handle, json } from "@/lib/api/http";
import { resolveScreen } from "@/lib/screen/server";
import { createAdminClient } from "@/lib/supabase/admin";

/** Lobby wall for a TV link: nicknames of the players in the game (nothing else). */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  return handle(async () => {
    const screen = await resolveScreen((await params).token);
    if (!screen) throw new HttpError(404, "screen_not_found");
    const { data, error } = await createAdminClient().from("players").select("id, nickname")
      .eq("game_id", screen.gameId).is("kicked_at", null).order("joined_at", { ascending: true });
    if (error) throw new HttpError(500, "roster_failed");
    return json({ players: data ?? [] });
  });
}
