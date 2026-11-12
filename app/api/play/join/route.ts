import type { NextRequest } from "next/server";

import { HttpError, handle, json, readJson } from "@/lib/api/http";
import { createAdminClient } from "@/lib/supabase/admin";
import { PLAYER_COOKIE, setPlayerCookie } from "@/lib/players/session";
import { generatePlayerToken, hashToken, isWellFormedToken } from "@/lib/players/token";
import { parsePlayerName } from "@/lib/players/validation";
import { ROOM_CODE } from "@/lib/site/url";

/**
 * Guest join (public). Atomic in the database (`join_game`):
 *  - new visitor  -> player row (token HASH only), httpOnly cookie with the raw token
 *  - same browser -> existing player is restored, no duplicate, cookie unchanged
 * Max players, game status and name uniqueness are enforced by the database.
 */
export async function POST(request: NextRequest) {
  return handle(async () => {
    const body = await readJson(request);

    const joinCode = typeof body.joinCode === "string" ? body.joinCode.trim().toUpperCase() : "";
    if (!ROOM_CODE.test(joinCode)) throw new HttpError(400, "invalid_join_code");
    const name = parsePlayerName(body.nickname);
    if (!name.ok) throw new HttpError(400, name.error);

    const existing = request.cookies.get(PLAYER_COOKIE)?.value;
    const token = generatePlayerToken();

    const { data, error } = await createAdminClient().rpc("join_game", {
      p_code: joinCode,
      p_nickname: name.value,
      p_token_hash: hashToken(token),
      p_existing_hash: isWellFormedToken(existing) ? hashToken(existing) : undefined,
    });

    if (error) {
      if (error.code === "23505") throw new HttpError(409, "nickname_taken");
      const known: [string, number][] = [
        ["game_not_found", 404], ["game_not_joinable", 409], ["game_full", 409], ["player_removed", 403],
      ];
      const hit = known.find(([m]) => error.message.includes(m));
      if (hit) throw new HttpError(hit[1], hit[0]);
      throw new HttpError(500, "join_failed");
    }
    const player = data?.[0];
    if (!player) throw new HttpError(500, "join_failed");

    const res = json(
      { player: { id: player.player_id, nickname: player.nickname }, gameId: player.game_id, restored: player.restored },
      player.restored ? 200 : 201,
    );
    if (!player.restored) setPlayerCookie(res, token);
    return res;
  });
}
