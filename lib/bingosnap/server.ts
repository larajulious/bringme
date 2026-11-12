import "server-only";

import { HttpError } from "@/lib/api/http";
import { createAdminClient } from "@/lib/supabase/admin";
import { hashToken, isWellFormedToken } from "@/lib/players/token";
import { toBingoHttpError } from "./errors";
import type { BingoPlayerSnapshot, BingoRoomInfo } from "./types";

/**
 * Guest-side data access. Identity is ONLY the session cookie's token hash,
 * resolved inside SQL; the request never names a player or a game, so a
 * participant can only read and claim for themselves.
 */

/** null = no session for this token. Throws 409 wrong_game_type for a Bring Me session. */
export async function getBingoPlayerState(token: string | undefined): Promise<BingoPlayerSnapshot | null> {
  if (!isWellFormedToken(token)) return null;
  const { data, error } = await createAdminClient().rpc("bingo_player_state", { p_token_hash: hashToken(token) });
  if (error) throw error.message.includes("wrong_game_type") ? toBingoHttpError(error.message) : new HttpError(500, "state_lookup_failed");
  return (data as unknown as BingoPlayerSnapshot | null) ?? null;
}

/**
 * The browser's BingoSnap session, if it belongs to the room `code`. A session for another
 * room (or a Bring Me game) is not an error here: the visitor is simply treated as new.
 */
export async function findBingoSession(token: string | undefined, code: string): Promise<BingoPlayerSnapshot | null> {
  try {
    const s = await getBingoPlayerState(token);
    return s && s.joinCode === code ? s : null;
  } catch (e) {
    if (e instanceof HttpError && e.code === "wrong_game_type") return null;
    throw e;
  }
}

/** Public facts behind a room code (type, title, status, headcount, board shape). null = no such room. */
export async function getBingoRoomInfo(code: string): Promise<BingoRoomInfo | null> {
  const { data, error } = await createAdminClient().rpc("bingo_room_info", { p_code: code });
  if (error) throw new HttpError(500, "room_lookup_failed");
  return (data as unknown as BingoRoomInfo | null) ?? null;
}

/** Records a claim (cell ids only) and returns the participant's new snapshot. */
export async function submitBingoClaim(tokenHash: string, cellIds: string[], requestId: string | null): Promise<BingoPlayerSnapshot> {
  const { data, error } = await createAdminClient().rpc("bingo_submit_claim", { p_token_hash: tokenHash, p_cell_ids: cellIds, p_request_id: requestId });
  if (error) throw toBingoHttpError(error.message);
  return data as unknown as BingoPlayerSnapshot;
}
