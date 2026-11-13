/**
 * Host / presenter photo listing (Phase 3). Pure: every database and Storage call is injected,
 * so the authorization and signing decisions are unit-tested and benchmarked with real queries.
 *
 * Rules
 *  - The game is looked up OWNER-scoped first: not your game = not found, nothing is ranked or signed.
 *  - Paths come only from the database (round_ranking under the host's RLS), never from the request,
 *    and must lie inside this game's folder. The request can only say which photos it ALREADY has
 *    (`have` = submission ids): those are not signed again. Lying about it only costs the caller
 *    their own picture; it can never produce a URL for anything else.
 *  - Host view: every photo of the current round (the host reviews them, rejected ones included,
 *    so a decision can be undone). Removed players' photos are not listed (round_ranking).
 *  - Presenter view (a public screen): names only, plus the OFFICIAL winner's photo during the
 *    announcement. No other photo is ever signed for it.
 *  - Signing runs under the caller's own session, so Storage's policy re-checks ownership per object.
 */
import { SUBMISSION_BUCKET } from "../players/submission.ts";

/** Unchanged from before Phase 3: a leaked URL is usable for at most 2 minutes. Reuse, not longer URLs, saves the work. */
export const PHOTO_URL_TTL_SECONDS = 120;
const MAX_HAVE = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_SRC = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export type PhotoView = "host" | "presenter";

export type RankingRow = {
  submission_id: string; rank: number; player_id: string; nickname: string; status: string;
  rank_ms: number; claimed_elapsed_ms: number; server_elapsed_ms: number; timing_status: string;
  timing_flags: string[]; near_tie: boolean; is_leader: boolean; storage_path: string;
};

export type ListedSubmission = {
  submissionId: string; rank: number; playerId: string; nickname: string; status: string;
  rankMs: number; claimedMs: number; serverMs: number; timing: string; flags: string[];
  nearTie: boolean; isLeader: boolean;
  /** Cache identity of the photo (`bucket/path`); null when this view may not show it. */
  photoKey: string | null;
  /** A freshly signed URL, or null (not needed: the caller has it; not allowed; or signing failed). */
  photoUrl: string | null;
};

export type Listing = { submissions: ListedSubmission[]; ttlSeconds: number; signed: number; signFailed: number };

export type ListingDeps = {
  /** The game IF the caller owns it (null otherwise). */
  game(): Promise<{ currentRoundId: string | null; phase: string } | null>;
  ranking(roundId: string): Promise<RankingRow[]>;
  /** The round's winner once it is official, else null. */
  officialWinner(roundId: string): Promise<string | null>;
  /** path -> signed URL; a missing entry means that path couldn't be signed. */
  sign(paths: string[], ttlSeconds: number): Promise<Map<string, string>>;
};

export const photoKey = (path: string) => `${SUBMISSION_BUCKET}/${path}`;

/** `have` query parameter: comma-separated submission ids (anything else is ignored). */
export function parseHave(raw: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!raw) return out;
  for (const part of raw.split(",")) {
    const id = part.trim().toLowerCase();
    if (UUID.test(id)) out.add(id);
    if (out.size >= MAX_HAVE) break;
  }
  return out;
}

/** A submission photo of THIS game: `<game>/<round>/<player>.<ext>` exactly. */
export function isGamePhotoPath(path: string, gameId: string): boolean {
  return new RegExp(`^${UUID_SRC}/${UUID_SRC}/${UUID_SRC}\\.(jpg|png|webp)$`).test(path) && path.startsWith(`${gameId.toLowerCase()}/`);
}

export async function listSubmissionPhotos(
  deps: ListingDeps,
  opts: { gameId: string; view: PhotoView; have: Set<string>; ttlSeconds?: number },
): Promise<Listing | null> {
  const ttlSeconds = opts.ttlSeconds ?? PHOTO_URL_TTL_SECONDS;
  const game = await deps.game();
  if (!game) return null;
  if (!game.currentRoundId) return { submissions: [], ttlSeconds, signed: 0, signFailed: 0 };

  const rows = await deps.ranking(game.currentRoundId);
  let showable: (r: RankingRow) => boolean = () => true;
  if (opts.view === "presenter") {
    const winner = game.phase === "winner_announced" ? await deps.officialWinner(game.currentRoundId) : null;
    showable = (r) => winner !== null && r.player_id === winner;
  }
  const visible = (r: RankingRow) => showable(r) && isGamePhotoPath(r.storage_path, opts.gameId);

  const toSign = [...new Set(rows.filter((r) => visible(r) && !opts.have.has(r.submission_id)).map((r) => r.storage_path))];
  const urls = toSign.length ? await deps.sign(toSign, ttlSeconds) : new Map<string, string>();

  return {
    ttlSeconds,
    signed: toSign.filter((p) => urls.has(p)).length,
    signFailed: toSign.filter((p) => !urls.has(p)).length,
    submissions: rows.map((r) => ({
      submissionId: r.submission_id, rank: r.rank, playerId: r.player_id, nickname: r.nickname, status: r.status,
      rankMs: r.rank_ms, claimedMs: r.claimed_elapsed_ms, serverMs: r.server_elapsed_ms, timing: r.timing_status,
      flags: r.timing_flags, nearTie: r.near_tie, isLeader: r.is_leader,
      photoKey: visible(r) ? photoKey(r.storage_path) : null,
      photoUrl: visible(r) ? urls.get(r.storage_path) ?? null : null,
    })),
  };
}
