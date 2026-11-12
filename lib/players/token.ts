import { createHash, randomBytes } from "node:crypto";

/** 256 bits from the OS CSPRNG, URL/cookie safe. Never stored; only its hash is. */
export function generatePlayerToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * SHA-256 hex of the token. The token already has 256 bits of entropy, so a
 * fast unsalted hash is appropriate (nothing to brute-force or rainbow-table);
 * a DB leak does not reveal usable tokens.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Cheap shape check so garbage cookies never reach the database. */
export function isWellFormedToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}
