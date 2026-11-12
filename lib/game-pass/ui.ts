/** Game Pass UI wording and small rules (pure; unit-tested in tests/game-pass-ui.test.ts). */

export type CurrentPass = { active: boolean; isTrial: boolean; maxPlayers: number | null };
export type PassAction = { label: "Buy Game Pass" | "Upgrade Pass" | "Purchase Again"; note: string };

/** Button wording for a paid plan, given the host's current access (policy: GAME_PASS_DESIGN.md §3). */
export function passAction(current: CurrentPass, planMaxPlayers: number): PassAction {
  if (!current.active || current.isTrial || current.maxPlayers == null) {
    return { label: "Buy Game Pass", note: current.isTrial && current.active ? "Starts now and ends your free trial." : "Starts right after payment is confirmed." };
  }
  if (planMaxPlayers > current.maxPlayers) return { label: "Upgrade Pass", note: "Starts now. The unused days of your current pass resume afterwards." };
  if (planMaxPlayers === current.maxPlayers) return { label: "Purchase Again", note: "Adds 7 days after your current pass." };
  return { label: "Buy Game Pass", note: "Starts after your current pass ends." };
}

/** "99", "99.0", "99.00", "1.99" -> minor units. Rejects more than 2 decimals, negatives, junk. */
export function parseMoneyInput(raw: string): number | null {
  const s = raw.trim();
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

export const SOURCE_LABEL = { trial: "Free trial", purchase: "Purchased", admin_grant: "Complimentary (manual grant)", legacy_subscription: "Legacy access" } as const;

export const PASS_STATE_LABEL: Record<string, string> = {
  active: "Active", queued: "Queued", paused: "Paused (resumes later)", consumed: "Expired", revoked: "Revoked", forfeited: "Ended by purchase",
};

export const ORDER_STATUS_LABEL: Record<string, string> = {
  pending: "Pending", paid: "Paid", failed: "Failed", expired: "Checkout expired", canceled: "Canceled",
  needs_review: "Under review", refunded: "Refunded", partially_refunded: "Partially refunded",
};

export function refundLabel(status: string, refundedMinor: number): string | null {
  if (status === "refunded") return "Fully refunded";
  if (status === "partially_refunded" || refundedMinor > 0) return "Partially refunded";
  return null;
}
