import type { NextRequest } from "next/server";

import { HttpError, handle, json } from "@/lib/api/http";
import { getBingoPlayerState } from "@/lib/bingosnap/server";
import { PLAYER_COOKIE } from "@/lib/players/session";

/**
 * The participant's own BingoSnap snapshot (cookie-authorized, the same guest
 * session as Bring Me). Their own board order appears only once the hunt has
 * started; other participants' claims only as announced results.
 */
export async function GET(request: NextRequest) {
  return handle(async () => {
    const state = await getBingoPlayerState(request.cookies.get(PLAYER_COOKIE)?.value);
    if (!state) throw new HttpError(401, "invalid_session");
    return json(state);
  });
}
