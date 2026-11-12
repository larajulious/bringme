/**
 * Pure helpers for the Game Master's review screen. The SERVER decides who wins
 * (fastest approved by the ranking policy); this only describes what the host
 * is about to confirm, so the confirmation dialog can't hide anything.
 */
export type ReviewRow = {
  submissionId: string;
  playerId: string;
  nickname: string;
  status: "pending" | "approved" | "rejected";
  rankMs: number;
  nearTie: boolean;
  isLeader: boolean;
  timing: "consistent" | "flagged";
};

export type Confirmation =
  | {
      kind: "winner";
      leader: ReviewRow;
      /** Other contenders (not disqualified) that finished within the near-tie window of the leader. */
      closeContenders: ReviewRow[];
      pending: number;
      disqualified: number;
      flagged: boolean;
    }
  | { kind: "none"; pending: number; disqualified: number };

/** What would be announced right now, and what the host should double-check first. */
export function describeConfirmation(rows: ReviewRow[], nearMs = 150): Confirmation {
  const pending = rows.filter((r) => r.status === "pending").length;
  const disqualified = rows.filter((r) => r.status === "rejected").length;
  const leader = rows.find((r) => r.isLeader);
  if (!leader) return { kind: "none", pending, disqualified };
  const closeContenders = rows.filter(
    (r) => r.playerId !== leader.playerId && r.status !== "rejected" && Math.abs(r.rankMs - leader.rankMs) < nearMs,
  );
  return { kind: "winner", leader, closeContenders, pending, disqualified, flagged: leader.timing === "flagged" };
}

export const statusLabel: Record<ReviewRow["status"], string> = {
  pending: "Needs review",
  approved: "Approved",
  rejected: "Disqualified",
};
