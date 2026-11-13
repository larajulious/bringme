import type { NextRequest } from "next/server";

import { HttpError, handle, json } from "@/lib/api/http";
import { mintScreenChannelToken, resolveScreen } from "@/lib/screen/server";

/**
 * Short-lived token that lets a TV LISTEN to its game's private Realtime topics. No database privileges (role anon),
 * cannot publish, and the channel policy re-checks that the TV link is still current (a reset cuts it off).
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  return handle(async () => {
    const screen = await resolveScreen((await params).token);
    if (!screen) throw new HttpError(401, "screen_not_found");
    const minted = mintScreenChannelToken({ gameId: screen.gameId, screenToken: screen.token });
    if (!minted) throw new HttpError(503, "realtime_unavailable");
    return json({ ...minted, topic: `game:${screen.gameId}` });
  });
}
