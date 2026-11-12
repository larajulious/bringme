import type { NextRequest } from "next/server";

import { HttpError, handle, json } from "@/lib/api/http";
import { mintGuestChannelToken } from "@/lib/game/guest-token";
import { PLAYER_COOKIE, getPlayerState } from "@/lib/players/session";

/**
 * Short-lived token that lets a guest LISTEN to their own game's private
 * Realtime channel. Authorized by the HttpOnly session cookie; the token is
 * bound to this player's game, carries no database privileges (role anon) and
 * cannot publish (no INSERT policy on realtime.messages).
 */
export async function GET(request: NextRequest) {
  return handle(async () => {
    const state = await getPlayerState(request.cookies.get(PLAYER_COOKIE)?.value);
    if (!state) throw new HttpError(401, "invalid_session");
    if (state.me.kicked) throw new HttpError(403, "player_removed");

    const minted = mintGuestChannelToken({ playerId: state.me.id, gameId: state.gameId });
    if (!minted) throw new HttpError(503, "realtime_unavailable");
    return json({ ...minted, topic: `game:${state.gameId}` });
  });
}
