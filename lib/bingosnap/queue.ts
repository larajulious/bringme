/**
 * The host's claim queue, derived from the authoritative host snapshot (pure; unit-tested).
 * The snapshot is the single source: entries are keyed by submission id, so a repeated or
 * out-of-order Realtime hint can never create a duplicate entry. It only ever triggers a re-read.
 */
import type { BingoHostSubmission, WinnerRule } from "./types.ts";

export type QueueEntry = BingoHostSubmission & {
  /** Position among ALL claims in the order the server received them (1-based). */
  order: number;
};

export type ClaimQueue = {
  /** Waiting for the host, earliest received first (ties: id). The first is "up next". */
  pending: QueueEntry[];
  /** Verified, by rank (earliest received first). */
  verified: QueueEntry[];
  /** Every decided claim (verified + rejected), most recently decided first. */
  history: QueueEntry[];
  /** Players (ids) with a verified claim: distinguished everywhere in the dashboard. */
  verifiedPlayers: Set<string>;
  /** "First wins": the winner so far (null in Ranked mode or with nothing verified). */
  leader: QueueEntry | null;
};

const byReceived = (a: BingoHostSubmission, b: BingoHostSubmission) =>
  Date.parse(a.submittedAt) - Date.parse(b.submittedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function buildQueue(submissions: readonly BingoHostSubmission[], winnerRule: WinnerRule): ClaimQueue {
  const unique = [...new Map(submissions.map((s) => [s.id, s])).values()];
  const ordered = unique.sort(byReceived).map((s, i) => ({ ...s, order: i + 1 }));
  const pending = ordered.filter((s) => s.status === "pending");
  const verified = ordered
    .filter((s) => s.status === "verified")
    .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || byReceived(a, b));
  const history = ordered
    .filter((s) => s.status !== "pending")
    .sort((a, b) => Date.parse(b.validatedAt ?? "") - Date.parse(a.validatedAt ?? "") || b.order - a.order);
  return {
    pending,
    verified,
    history,
    verifiedPlayers: new Set(verified.map((s) => s.playerId)),
    leader: winnerRule === "first" ? verified[0] ?? null : null,
  };
}

/** Host-facing text for review refusals (the server decides; this only explains). */
export function reviewErrorText(code: string | undefined, nickname: string): string {
  switch (code) {
    case "already_reviewed": return `${nickname}'s claim was already decided (another tab or device?). Showing the latest.`;
    case "already_pending": return `${nickname}'s claim is already waiting for review.`;
    case "claim_superseded": return `${nickname} has already sent a newer claim, so this one can't be reopened.`;
    case "player_removed": return `${nickname} was removed from the game, so their claim can't be verified.`;
    case "review_locked": return "Reviews are closed for this game.";
    case "submission_not_found": return "That claim isn't part of this game.";
    case "invalid_reason": return "Keep the reason under 120 characters.";
    default: return "That didn't go through. Check your connection and try again.";
  }
}

/** Quick reasons for a rejection (the host can also type one). */
export const REJECT_REASONS = ["Photo missing", "Doesn't match the challenge", "Photo too blurry", "Same photo used twice"] as const;
