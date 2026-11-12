/**
 * BingoSnap database error -> [HTTP status, stable code] (pure, unit-tested).
 * Order matters: more specific messages first.
 */
const RULES: [string, number][] = [
  ["wrong_game_type", 409],
  ["invalid_board_size", 400],
  ["invalid_board_dimensions", 400],
  ["free_cell_not_editable", 400],
  ["board_incomplete", 422],
  ["board_locked", 409],
  ["stale_board", 409],
  ["invalid_win_mode", 400],
  ["invalid_winner_rule", 400],
  ["free_space_not_allowed", 400],
  ["invalid_duration", 400],
  ["wrong_challenge_count", 400],
  ["duplicate_challenge", 400],
  ["invalid_challenge", 400],
  ["invalid_title", 400],
  ["settings_locked", 409],
  ["hunt_not_started", 409],
  ["hunt_not_active", 409],
  ["hunt_over", 409],
  ["already_verified", 409],
  ["attempts_exhausted", 409],
  ["invalid_cells", 422],
  ["invalid_pattern", 422],
  ["earlier_claim_pending", 409], // before claim_pending (substring)
  ["claim_pending", 409],
  ["already_reviewed", 409],
  ["already_pending", 409],
  ["claim_superseded", 409],
  ["invalid_reason", 400],
  ["invalid_view", 400],
];

/** null = not a BingoSnap-specific error (use the shared host mapping). */
export function bingoErrorCode(message: string): [status: number, code: string] | null {
  const hit = RULES.find(([needle]) => message.includes(needle));
  return hit ? [hit[1], hit[0]] : null;
}
