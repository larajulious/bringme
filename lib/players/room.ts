import "server-only";

import { HttpError } from "@/lib/api/http";
import { createAdminClient } from "@/lib/supabase/admin";
import type { GameStatus } from "@/lib/supabase/database.types";

export type RoomInfo = { title: string; status: GameStatus; playerCount: number; maxPlayers: number };

/** Public facts about a room (title, state, headcount) for the join page. */
export async function getRoomInfo(code: string): Promise<RoomInfo | null> {
  const { data, error } = await createAdminClient().rpc("public_room_info", { p_code: code });
  if (error) throw new HttpError(500, "room_lookup_failed");
  const r = data?.[0];
  return r ? { title: r.title, status: r.status, playerCount: Number(r.player_count), maxPlayers: r.max_players } : null;
}
