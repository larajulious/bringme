/**
 * When the host console / presenter must re-read a side list (Phase 2, audit G7). Each key changes
 * exactly when the list's data can have changed, so an unrelated hint (a phase change, another
 * player's photo) doesn't re-read the roster or the rounds. Without the database fingerprints
 * (older database) every key falls back to the version: the pre-Phase-2 behaviour.
 * Pure (no imports at runtime), unit-tested.
 */
import type { HostSnapshot } from "./types.ts";

type K = Pick<HostSnapshot, "version" | "status" | "phase" | "totalRounds" | "roundsRemaining" | "round" | "rosterKey" | "submissionsKey">;

/** Joined/removed players. */
export const rosterKey = (s: K): string => s.rosterKey ?? `v${s.version}`;

/** The round list (items, their status): a round added, opened, closed, replayed, or the game moved on. */
export const roundsKey = (s: K): string =>
  `${s.status}|${s.totalRounds}|${s.roundsRemaining}|${s.round?.id ?? "-"}|${s.round?.status ?? "-"}`;

/** The current round's ranked photos: a new photo, a review decision, a removal, the round or phase, the official winner. */
export const submissionsKey = (s: K): string =>
  s.submissionsKey === undefined
    ? `v${s.version}`
    : `${s.round?.id ?? "-"}|${s.submissionsKey}|${s.phase}|${s.round?.status ?? "-"}|${s.round?.winnerPlayerId ?? "-"}|${s.round?.decided ?? false}`;
