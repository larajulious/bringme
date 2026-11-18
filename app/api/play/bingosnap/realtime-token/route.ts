import type { NextRequest } from "next/server";

import { HttpError, handle, json } from "@/lib/api/http";
import { toBingoHttpError } from "@/lib/bingosnap/errors";
import { mintGuestChannelToken } from "@/lib/game/guest-token";
import { PLAYER_COOKIE, findGuestIdentity } from "@/lib/players/session";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Short-lived token to LISTEN to the participant's own game channel (the same guest token
 * as Bring Me: role anon, bound to one game, cannot publish). Authorized by the HttpOnly
 * session cookie; removed participants get none.
 * Two primary-key lookups instead of the full BingoSnap snapshot (which also evaluates the
 * owner's Game Pass): same answers as before (401 no session, 409 not a BingoSnap game, 403 removed).
 */
export async function GET(request: NextRequest) {
  return handle(async () => {
    const me = await findGuestIdentity(request.cookies.get(PLAYER_COOKIE)?.value);
    if (!me) throw new HttpError(401, "invalid_session");
    const { data: game, error } = await createAdminClient().from("games").select("game_type").eq("id", me.gameId).maybeSingle();
    if (error) throw new HttpError(500, "state_lookup_failed");
    if (game?.game_type !== "bingosnap") throw toBingoHttpError("wrong_game_type", "P0001");
    if (me.kicked) throw new HttpError(403, "player_removed");

    const minted = mintGuestChannelToken({ playerId: me.id, gameId: me.gameId });
    if (!minted) throw new HttpError(503, "realtime_unavailable");
    return json({ ...minted, topic: `game:${me.gameId}` });
  });
}
