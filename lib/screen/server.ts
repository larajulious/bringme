import "server-only";

import { GUEST_TOKEN_TTL_SECONDS, screenChannelClaims, signHs256 } from "@/lib/game/jwt";
import { createAdminClient } from "@/lib/supabase/admin";

import { normalizeScreenToken } from "./token";

/**
 * TV link resolution. A token is the only credential: it is format-checked, then looked up with the service role,
 * and every query that follows is scoped to the ONE game it resolves to. A reset token resolves to nothing.
 */
export async function resolveScreen(raw: string): Promise<{ token: string; gameId: string; gameType: string; status: string } | null> {
  const token = normalizeScreenToken(raw);
  if (!token) return null;
  const admin = createAdminClient();
  const { data: link } = await admin.from("game_screens").select("game_id").eq("token", token).maybeSingle();
  if (!link) return null;
  const { data: game } = await admin.from("games").select("id, game_type, status").eq("id", link.game_id).maybeSingle();
  return game ? { token, gameId: game.id, gameType: game.game_type, status: game.status } : null;
}

/** The audience-safe snapshot (Bring Me: HostSnapshot-shaped; BingoSnap: presenter view). null = no such link. */
export async function getScreenState(raw: string): Promise<Record<string, unknown> | null> {
  const token = normalizeScreenToken(raw);
  if (!token) return null;
  const { data, error } = await createAdminClient().rpc("screen_state", { p_token: token });
  if (error) throw new Error("screen_state_failed");
  return (data as Record<string, unknown> | null) ?? null;
}

/** null = Realtime for TVs isn't configured (the screen falls back to slower polling). */
export function mintScreenChannelToken(args: { gameId: string; screenToken: string }): { token: string; expiresAt: number } | null {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) return null;
  const now = Math.floor(Date.now() / 1000);
  return {
    token: signHs256(screenChannelClaims({ ...args, nowSeconds: now }), secret),
    expiresAt: (now + GUEST_TOKEN_TTL_SECONDS) * 1000,
  };
}
