/**
 * BingoSnap snapshot types and constants. Shapes match `bingo_state_json`
 * (supabase/migrations/20261112000018_bingosnap_functions.sql).
 * Photos are never part of any of these: they exist only on the player's device.
 */
import type { GamePhase, GameStatus } from "@/lib/supabase/database.types";

export const BOARD_SIZES = [3, 4, 5] as const;
export type BoardSize = (typeof BOARD_SIZES)[number];
export const WIN_MODES = ["traditional", "full_card"] as const;
export type WinMode = (typeof WIN_MODES)[number];
export const WINNER_RULES = ["ranked", "first"] as const;
export type WinnerRule = (typeof WINNER_RULES)[number];

export const MIN_DURATION_SECONDS = 180;
export const MAX_DURATION_SECONDS = 7200;
export const DEFAULT_DURATION_SECONDS = 1200;
export const CHALLENGE_MAX_LENGTH = 120;
export const REASON_MAX_LENGTH = 120;
export const MAX_ATTEMPTS = 5;
/** Claims are accepted up to this long after the deadline (database clock). */
export const CLAIM_GRACE_MS = 2000;

/** Host lifecycle actions accepted by `bingo_transition`. */
export const BINGO_ACTIONS = [
  "start_game", "start_countdown", "start_hunt", "close_hunt", "announce_results", "end_game", "cancel", "archive",
] as const;
export type BingoAction = (typeof BINGO_ACTIONS)[number];
export const REVIEW_DECISIONS = ["verify", "reject", "reset"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

/** BingoSnap vocabulary for games.status (draft | lobby | live | finished | canceled). */
export type BingoStatus = "draft" | "lobby" | "active" | "completed" | "cancelled";
export type SubmissionStatus = "pending" | "verified" | "rejected";
export type Pattern = `row:${number}` | `col:${number}` | "diag:main" | "diag:anti" | "full";

/** Number of challenges a board needs (the free centre needs none). */
export const challengeCount = (size: BoardSize, freeSpace: boolean) => size * size - (freeSpace ? 1 : 0);
/** The free centre is allowed on odd boards in Traditional mode only. */
export const freeSpaceAllowed = (size: number, mode: WinMode) => size % 2 === 1 && mode === "traditional";

export type BingoBoardInfo = {
  size: BoardSize;
  winMode: WinMode;
  winnerRule: WinnerRule;
  freeSpace: boolean;
  durationSeconds: number;
  huntStartedAt: string | null;
  huntEndsAt: string | null;
  huntOver: boolean;
  resultsAt: string | null;
};

export type BingoResults = {
  winnerRule: WinnerRule;
  entries: { rank: number; playerId: string; nickname: string; submittedAt: string; pattern: Pattern }[];
};

export type BingoSnapshotBase = {
  gameId: string;
  gameType: "bingosnap";
  title: string;
  version: number;
  serverNow: string;
  status: BingoStatus;
  lifecycle: GameStatus;
  phase: GamePhase;
  countdownEndsAt: string | null;
  playerCount: number;
  maxPlayers: number;
  archivedAt: string | null;
  board: BingoBoardInfo;
  counts: { pending: number; verified: number; rejected: number };
  results: BingoResults | null;
};

export type BingoCell = { id: string; row: number; col: number; order: number; challenge: string | null; isFree: boolean };

export type BingoHostSubmission = {
  id: string;
  playerId: string;
  nickname: string;
  playerRemoved: boolean;
  attempt: number;
  status: SubmissionStatus;
  pattern: Pattern;
  submittedAt: string;
  validatedAt: string | null;
  /** Host view only (null on the presenter screen). */
  rejectionReason: string | null;
  /** Host view only: the claimed challenges (no photos exist server-side). */
  cells: { id: string; challenge: string }[] | null;
  /** Position among verified claims (earliest received first). */
  rank: number | null;
};

export type BingoHostSnapshot = BingoSnapshotBase & {
  joinCode: string;
  /** Board save revision (host views only); send it back as expectedRevision. */
  boardRevision?: number;
  /** Presenter: null until the hunt starts. */
  cells: BingoCell[] | null;
  players: { id: string; nickname: string; joinedAt: string; state: "active" | "removed" }[];
  submissions: BingoHostSubmission[];
};

export type BingoLayoutCell = { pos: number; row: number; col: number; cellId: string; challenge: string | null; isFree: boolean };

export type BingoPlayerSubmission = {
  id: string;
  attempt: number;
  status: SubmissionStatus;
  pattern: Pattern;
  cellIds: string[];
  submittedAt: string;
  validatedAt: string | null;
  rejectionReason: string | null;
};

export type BingoPlayerSnapshot = BingoSnapshotBase & {
  /** The room code (checked against the lobby URL). */
  joinCode: string;
  me: {
    id: string;
    nickname: string;
    joinedAt: string;
    state: "active" | "removed";
    /** This participant's own order of the challenges; null until the hunt starts. */
    layout: BingoLayoutCell[] | null;
    submissions: BingoPlayerSubmission[];
    attemptsLeft: number;
    canClaim: boolean;
  };
};

/** Public facts behind a room code (`bingo_room_info`); never includes challenges. */
export type BingoRoomInfo =
  | { gameType: "bring_me"; status: GameStatus }
  | {
      gameType: "bingosnap";
      title: string;
      status: GameStatus;
      playerCount: number;
      maxPlayers: number;
      /** null while the game is a draft. */
      board: { size: BoardSize; winMode: WinMode; freeSpace: boolean; winnerRule: WinnerRule; durationSeconds: number } | null;
    };
