import type { NextRequest } from "next/server";

import { HttpError, handle, json } from "@/lib/api/http";
import { PLAYER_COOKIE, getPlayerState } from "@/lib/players/session";

/**
 * Authoritative game snapshot for the signed-in guest (cookie-authorized).
 * Used on first paint, after a reconnect, on tab focus and as a safety net;
 * live changes arrive via Realtime Broadcast hints. Players only ever see their
 * own game, and the round item only after its official start.
 */
export async function GET(request: NextRequest) {
  return handle(async () => {
    const state = await getPlayerState(request.cookies.get(PLAYER_COOKIE)?.value);
    if (!state) throw new HttpError(401, "invalid_session");
    return json(state);
  });
}
