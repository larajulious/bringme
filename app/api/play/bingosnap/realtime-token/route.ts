import type { NextRequest } from "next/server";

import { HttpError, handle, json } from "@/lib/api/http";
import { mintGuestChannelToken } from "@/lib/game/guest-token";
import { getBingoPlayerState } from "@/lib/bingosnap/server";
import { PLAYER_COOKIE } from "@/lib/players/session";

/**
 * Short-lived token to LISTEN to the participant's own game channel (the same guest token
 * as Bring Me: role anon, bound to one game, cannot publish). Authorized by the HttpOnly
 * session cookie; removed participants get none.
 */
export async function GET(request: NextRequest) {
  return handle(async () => {
    const state = await getBingoPlayerState(request.cookies.get(PLAYER_COOKIE)?.value);
    if (!state) throw new HttpError(401, "invalid_session");
    if (state.me.state === "removed") throw new HttpError(403, "player_removed");

    const minted = mintGuestChannelToken({ playerId: state.me.id, gameId: state.gameId });
    if (!minted) throw new HttpError(503, "realtime_unavailable");
    return json({ ...minted, topic: `game:${state.gameId}` });
  });
}
