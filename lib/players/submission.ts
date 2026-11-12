/** Pure helpers for the private photo flow (no secrets, unit-testable). */

export const SUBMISSION_BUCKET = "submissions";

export const ALLOWED_IMAGE_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const;
export type AllowedImageType = keyof typeof ALLOWED_IMAGE_TYPES;

export const isAllowedImageType = (v: unknown): v is AllowedImageType =>
  typeof v === "string" && Object.hasOwn(ALLOWED_IMAGE_TYPES, v);

/**
 * Object key for a submission. Fully derived from server-verified ids, so a
 * client can never choose (or overwrite) another player's or game's path. It
 * must match the CHECK constraint on public.submissions.storage_path and the
 * storage read policy (first segment = game id).
 */
export function submissionPath(args: {
  gameId: string;
  roundId: string;
  playerId: string;
  contentType: AllowedImageType;
}): string {
  const { gameId, roundId, playerId, contentType } = args;
  return `${gameId}/${roundId}/${playerId}.${ALLOWED_IMAGE_TYPES[contentType]}`;
}

/** Remaining seconds a round accepts submissions (matches DB: limit + 5s grace). */
export function roundAcceptsSubmissions(
  round: { status: string; opened_at: string | null; time_limit_seconds: number },
  now = Date.now(),
): boolean {
  if (round.status !== "open" || !round.opened_at) return false;
  return now <= Date.parse(round.opened_at) + (round.time_limit_seconds + 5) * 1000;
}
