import "server-only";

import type { NextRequest, NextResponse } from "next/server";

import { HttpError } from "@/lib/api/http";
import { createAdminClient } from "@/lib/supabase/admin";
import type { PlayerSnapshot } from "@/lib/game/types";
import { hashToken, isWellFormedToken } from "./token";

export const PLAYER_COOKIE = "bm_player";
const SESSION_SECONDS = 60 * 60 * 12;

export type GuestPlayer = { id: string; game_id: string; nickname: string };

/** httpOnly: page scripts (and XSS) cannot read the token. */
export function setPlayerCookie(res: NextResponse, token: string) {
  res.cookies.set(PLAYER_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_SECONDS,
  });
}

/**
 * Resolve the guest from the cookie. The player id is derived ONLY from the
 * token hash lookup; request bodies/URLs are never trusted for identity.
 * Throws 401 for missing/invalid/kicked sessions (single generic error).
 */
export async function requireGuestPlayer(request: NextRequest): Promise<GuestPlayer> {
  const token = request.cookies.get(PLAYER_COOKIE)?.value;
  if (!isWellFormedToken(token)) throw new HttpError(401, "invalid_session");

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("players")
    .select("id, game_id, nickname, kicked_at")
    .eq("token_hash", hashToken(token))
    .maybeSingle();
  if (error) throw new HttpError(500, "session_lookup_failed");
  if (!data || data.kicked_at) throw new HttpError(401, "invalid_session");
  return { id: data.id, game_id: data.game_id, nickname: data.nickname };
}

/**
 * Authoritative snapshot for the player owning `token` (null = no such session).
 * One SQL call: identity, game state, and the round item ONLY once its official
 * start time has passed.
 */
export async function getPlayerState(token: string | undefined): Promise<PlayerSnapshot | null> {
  if (!isWellFormedToken(token)) return null;
  const { data, error } = await createAdminClient().rpc("player_game_state", { p_token_hash: hashToken(token) });
  if (error) throw new HttpError(500, "state_lookup_failed");
  return (data as PlayerSnapshot | null) ?? null;
}

/** SHA-256 of the session token from the cookie (401 if missing/malformed). The raw token is never kept. */
export function requireTokenHash(request: NextRequest): string {
  const token = request.cookies.get(PLAYER_COOKIE)?.value;
  if (!isWellFormedToken(token)) throw new HttpError(401, "invalid_session");
  return hashToken(token);
}
