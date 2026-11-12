import "server-only";

import { GUEST_TOKEN_TTL_SECONDS, guestChannelClaims, signHs256 } from "./jwt";

/** null = Realtime for guests isn't configured (clients fall back to slower polling). */
export function mintGuestChannelToken(args: { playerId: string; gameId: string }): { token: string; expiresAt: number } | null {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) return null;
  const now = Math.floor(Date.now() / 1000);
  return {
    token: signHs256(guestChannelClaims({ ...args, nowSeconds: now }), secret),
    expiresAt: (now + GUEST_TOKEN_TTL_SECONDS) * 1000,
  };
}
