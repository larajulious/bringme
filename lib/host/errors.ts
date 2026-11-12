import { HttpError } from "@/lib/api/http";

/** Maps database trigger/RPC messages (Phase 2–5) to stable HTTP errors. */
export function toHttpError(message: string): HttpError {
  const rules: [string, number, string][] = [
    ["subscription_required", 402, "subscription_required"],
    ["period_game_limit_reached", 409, "period_game_limit_reached"],
    ["game_limit_reached", 409, "game_limit_reached"],
    ["round_limit_reached", 422, "round_limit_reached"],
    ["items_required", 400, "items_required"],
    ["empty_item", 400, "empty_item"],
    ["invalid_game_transition", 409, "invalid_game_transition"],
    ["stale_state", 409, "stale_state"],
    ["invalid_transition", 409, "invalid_transition"],
    ["round_not_started", 409, "round_not_started"],
    ["no_players", 409, "no_players"],
    ["player_limit_exceeded", 409, "player_limit_exceeded"],
    ["no_rounds_left", 409, "no_rounds_left"],
    ["invalid_winner", 422, "invalid_winner"],
    ["invalid_action", 400, "invalid_action"],
    ["winner_mismatch", 409, "winner_mismatch"],
    ["winner_already_confirmed", 409, "winner_already_confirmed"],
    ["review_locked", 409, "review_locked"],
    ["submission_not_found", 404, "submission_not_found"],
    ["invalid_decision", 400, "invalid_decision"],
    ["round_not_open", 409, "round_not_open"],
    ["round_closed", 409, "round_closed"],
    ["invalid_timing", 400, "invalid_timing"],
    ["attempt_expired", 409, "attempt_expired"],
    ["attempt_superseded", 409, "attempt_superseded"],
    ["no_intent", 409, "no_intent"],
    ["invalid_session", 401, "invalid_session"],
    ["player_removed", 403, "player_removed"],
    ["game_not_found", 404, "game_not_found"],
    ["game_is_closed", 409, "game_is_closed"],
  ];
  const hit = rules.find(([needle]) => message.includes(needle));
  return hit ? new HttpError(hit[1], hit[2]) : new HttpError(500, "request_failed");
}
