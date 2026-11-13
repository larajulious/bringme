import { createHmac } from "node:crypto";

/** Minimal HS256 JWT signer (no dependency). Only used to mint short-lived guest channel tokens. */
export function signHs256(payload: Record<string, unknown>, secret: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64(payload);
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

export const GUEST_TOKEN_TTL_SECONDS = 60 * 60;

/**
 * Claims for a guest's Realtime token. role=anon: the token carries NO database
 * privileges (anon has none on game tables); it only satisfies the Realtime
 * authorization policy for ONE game's private channel (kind=guest + game_id).
 */
export function guestChannelClaims(args: { playerId: string; gameId: string; nowSeconds: number }) {
  return {
    role: "anon",
    sub: args.playerId,
    kind: "guest",
    game_id: args.gameId,
    iat: args.nowSeconds,
    exp: args.nowSeconds + GUEST_TOKEN_TTL_SECONDS,
  };
}

/**
 * Claims for a TV link's Realtime token (migration 20261113000003). role=anon, no database privileges; the channel
 * policy accepts it only while `screen_token` is still the game's current TV link, so a reset cuts it off.
 */
export function screenChannelClaims(args: { gameId: string; screenToken: string; nowSeconds: number }) {
  return {
    role: "anon",
    sub: args.gameId,
    kind: "screen",
    game_id: args.gameId,
    screen_token: args.screenToken,
    iat: args.nowSeconds,
    exp: args.nowSeconds + GUEST_TOKEN_TTL_SECONDS,
  };
}
