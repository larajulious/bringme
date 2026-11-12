/** Authoritative game snapshots (built in SQL by game_state_json). Dates are ISO strings. */
export type GameStatus = "draft" | "lobby" | "live" | "finished" | "canceled";
export type GamePhase = "lobby" | "countdown" | "active" | "reviewing" | "winner_announced" | "finished";
export type RoundStatus = "pending" | "open" | "closed";

export type RoundSnapshot = {
  id: string;
  no: number;
  status: RoundStatus;
  openedAt: string | null;
  closedAt: string | null;
  timeLimitSeconds: number;
  /** null for players until the official round start (the server withholds it). */
  prompt: string | null;
  winnerPlayerId: string | null;
  winnerName: string | null;
  /** The winning time (ranking number). */
  winnerMs: number | null;
  /** True once the winner (or "no winner") is official and final. */
  decided: boolean;
};

export type ResultRow = {
  no: number;
  prompt: string;
  decided: boolean;
  winnerName: string | null;
  winnerMs: number | null;
  /** Players only: did I win this round? */
  isMe: boolean;
  submissions: number;
};

export type GameSnapshot = {
  /** Visible-state revision. Only ever increases. */
  version: number;
  status: GameStatus;
  phase: GamePhase;
  title: string;
  /** Server clock when this snapshot was built (for clock-offset estimation). */
  serverNow: string;
  countdownEndsAt: string | null;
  totalRounds: number;
  roundsRemaining: number;
  playerCount: number;
  maxPlayers: number;
  /** Accepted photos in the current round. */
  submissionCount: number;
  reviewCounts: { pending: number; approved: number; rejected: number } | null;
  archivedAt: string | null;
  /** Per-round winners; only present once the game is finished. */
  results: ResultRow[] | null;
  round: RoundSnapshot | null;
};

export type PlayerSnapshot = GameSnapshot & {
  gameId: string;
  joinCode: string;
  me: {
    id: string;
    nickname: string;
    kicked: boolean;
    hasSubmitted: boolean;
    /** Own accepted result for the current round (claimed capture time). */
    submission: {
      elapsedMs: number;
      /** The time used for ranking (the server's own if the claim was flagged). */
      rankMs: number;
      timing: "consistent" | "flagged";
      /** Revealed only once the round's winner is official. */
      review: "pending" | "approved" | "rejected" | null;
    } | null;
    isWinner: boolean;
  };
};

export type HostSnapshot = GameSnapshot & { joinCode?: string };

export const HOST_ACTIONS = [
  "start_game", "start_countdown", "start_round", "close_submissions",
  "move_to_review", "announce_winner", "next_round", "end_game", "cancel", "archive",
] as const;
export type HostAction = (typeof HOST_ACTIONS)[number];
