/**
 * Database types for the `public` schema, matching supabase/migrations.
 * Regenerate from the live project with `npm run db:types` (needs the Supabase
 * CLI linked to the project) and keep the convenience aliases at the bottom.
 */
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type UserRole = "super_admin" | "subscriber";
export type SubscriptionStatus = "trialing" | "active" | "past_due" | "canceled" | "expired" | "suspended";
/** Derived access state shown to subscribers (see access_state_for in SQL). */
export type AccessState = "active" | "pending" | "suspended" | "expired" | "deactivated";
export type GameStatus = "draft" | "lobby" | "live" | "finished" | "canceled";
export type RoundStatus = "pending" | "open" | "closed";
export type GamePhase = "lobby" | "countdown" | "active" | "reviewing" | "winner_announced" | "finished";
export type SubmissionStatus = "pending" | "approved" | "rejected";
/** Game Pass ledger (migrations 20261112000001..7). */
export type PassSource = "trial" | "purchase" | "admin_grant" | "legacy_subscription";
export type PassDisposition = "granted" | "revoked" | "forfeited";
/** Derived per-pass state (pass_timeline_for). An expired pass is "consumed", never a failed payment. */
export type PassState = "active" | "queued" | "paused" | "consumed" | "revoked" | "forfeited";
/** PAYMENT state of one checkout attempt (separate from entitlement). */
export type OrderStatus = "pending" | "paid" | "failed" | "expired" | "canceled" | "needs_review" | "refunded" | "partially_refunded";
export type Currency = "PHP" | "USD";
/** BingoSnap (Extra Fun): migrations 20261112000017/18. */
export type GameType = "bring_me" | "bingosnap";
export type BingoWinMode = "traditional" | "full_card";
export type BingoWinnerRule = "ranked" | "first";
export type BingoSubmissionStatus = "pending" | "verified" | "rejected";

type ProfileRow = {
  id: string;
  email: string | null;
  display_name: string | null;
  role: UserRole;
  /** Set when an admin deactivates the account (also bans the auth user). */
  deactivated_at: string | null;
  /** Account-level hosting suspension (Game Pass). Pass time keeps running. */
  hosting_suspended_at: string | null;
  created_at: string;
  updated_at: string;
};
type PlanRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  /** @deprecated Game Pass: prices live in plan_prices (PHP and USD separately). */
  price_cents: number;
  /** @deprecated Game Pass: prices live in plan_prices. */
  currency: string;
  /** Catalogue tier: trial 0, starter 1, party 2, pro 3 (null for custom plans). */
  tier: number | null;
  /** Exact pass length in seconds (604800 = 7 days). */
  duration_seconds: number;
  is_trial: boolean;
  sort_order: number;
  max_active_games: number;
  max_players_per_game: number;
  max_rounds_per_game: number;
  /** null = unlimited. A period = one pass (counted from the current pass's activation). */
  max_games_per_period: number | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};
type SettingsRow = {
  id: true;
  default_max_players: number;
  max_photo_size_mb: number;
  photo_retention_days: number;
  support_email: string | null;
  updated_at: string;
};
type SubscriptionRow = {
  id: string;
  user_id: string;
  plan_id: string;
  status: SubscriptionStatus;
  current_period_start: string;
  current_period_end: string;
  cancel_at_period_end: boolean;
  external_ref: string | null;
  created_at: string;
  updated_at: string;
};
/** Fixed price of a plan in ONE currency, integer minor units (PHP 9900 = PHP 99.00). */
type PlanPriceRow = {
  id: string;
  plan_id: string;
  currency: Currency;
  amount_minor: number;
  /** Server/service role only (not granted to client roles). */
  polar_product_id: string | null;
  polar_price_id: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};
/** Columns a host may read on their own passes (admin notes are not granted). */
type GamePassRow = {
  id: string;
  user_id: string;
  plan_id: string;
  source: PassSource;
  max_players: number;
  duration_seconds: number;
  disposition: PassDisposition;
  ended_at: string | null;
  end_reason: string | null;
  created_at: string;
};
type PassSegmentRow = { id: number; pass_id: string; user_id: string; starts_at: string; ends_at: string };
/** Columns a host may read on their own orders (no Polar ids / review notes). */
type PassOrderRow = {
  id: string;
  /** Service role only (not granted to hosts). */
  checkout_url?: string | null;
  polar_environment?: "sandbox" | "production" | null;
  /** Payment evidence: service role only. */
  paid_amount_minor?: number | null;
  paid_currency?: string | null;
  polar_order_id?: string | null;
  polar_checkout_id?: string | null;
  polar_product_id?: string | null;
  user_id: string;
  plan_id: string;
  currency: Currency;
  amount_minor: number;
  status: OrderStatus;
  refunded_amount_minor: number;
  created_at: string;
  paid_at: string | null;
  closed_at: string | null;
};
type PassTimelineRow = {
  pass_id: string;
  seq: number;
  plan_code: string;
  plan_name: string;
  source: PassSource;
  max_players: number;
  duration_seconds: number;
  consumed_seconds: number;
  remaining_seconds: number;
  state: PassState;
  first_start: string | null;
  last_end: string | null;
  disposition: PassDisposition;
  ended_at: string | null;
  end_reason: string | null;
  order_id: string | null;
  order_status: OrderStatus | null;
  created_at: string;
};
/** my_game_pass_summary(): seconds are relative to the database clock at `serverNow`. */
export type GamePassSummary = {
  serverNow: string;
  state: AccessState;
  planCode: string | null;
  planName: string | null;
  source: PassSource | null;
  isTrial: boolean;
  maxPlayers: number | null;
  passStartedAt: string | null;
  /** When the CURRENT pass stops being the active one. */
  passEndsAt: string | null;
  /** When access ends (after any queued passes). */
  accessUntil: string | null;
  passRemainingSeconds: number | null;
  accessRemainingSeconds: number | null;
  trial: {
    used: boolean;
    status: "none" | "active" | "ended" | "replaced_by_pass" | "revoked";
    startedAt: string | null;
    endsAt: string | null;
    eligible: boolean;
    reason: string | null;
  };
  /** The host's only access was the trial and it has ended. */
  trialEndedNoPass: boolean;
};
type PurchaseHistoryRow = {
  order_id: string; ordered_at: string; plan_code: string; plan_name: string; currency: Currency;
  amount_minor: number; paid_amount_minor: number | null; refunded_amount_minor: number;
  status: OrderStatus; environment: "sandbox" | "production" | null; paid_at: string | null;
  pass_id: string | null; pass_state: PassState | null; activated_at: string | null; expires_at: string | null;
};
type GameRow = {
  id: string;
  owner_id: string;
  title: string;
  join_code: string;
  status: GameStatus;
  /** Engine phase; only game_transition() changes it. */
  phase: GamePhase;
  /** Visible-state revision, bumped on every change players/hosts can see. */
  state_version: number;
  current_round_id: string | null;
  countdown_ends_at: string | null;
  phase_changed_at: string;
  archived_at: string | null;
  /** Set at creation, immutable; not client-writable. */
  game_type: GameType;
  max_players: number;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
};
type RoundRow = {
  id: string;
  game_id: string;
  round_no: number;
  prompt: string;
  time_limit_seconds: number;
  points: number;
  status: RoundStatus;
  opened_at: string | null;
  closed_at: string | null;
  winner_player_id: string | null;
  winner_submission_id: string | null;
  winner_rank_ms: number | null;
  /** Write-once: set when the winner (or "no winner") is confirmed. */
  winner_confirmed_at: string | null;
  /** Set when the host replayed this round (it ended with no winner; a copy followed). */
  replayed_at: string | null;
  created_at: string;
  updated_at: string;
};
type PlayerRow = {
  id: string;
  game_id: string;
  nickname: string;
  /** SHA-256 hex of the guest token. Only readable with the service role. */
  token_hash: string;
  joined_at: string;
  last_seen_at: string;
  kicked_at: string | null;
};
/** BingoSnap board settings + authoritative timer. Title/owner/status live on games. */
type BingoGameRow = {
  game_id: string;
  board_size: 3 | 4 | 5;
  win_mode: BingoWinMode;
  free_space: boolean;
  winner_rule: BingoWinnerRule;
  duration_seconds: number;
  layout_seed: string;
  hunt_started_at: string | null;
  hunt_ends_at: string | null;
  results_at: string | null;
  /** Bumped on every board save (optimistic concurrency). */
  board_revision: number;
  created_at: string;
  updated_at: string;
};
type BingoCellRow = {
  id: string;
  game_id: string;
  row_no: number;
  col_no: number;
  display_order: number;
  /** null only for the free space. */
  challenge: string | null;
  is_free: boolean;
  created_at: string;
};
/** One row per claim attempt. Never any photo data. */
type BingoSubmissionRow = {
  id: string;
  game_id: string;
  player_id: string;
  attempt_no: number;
  cell_ids: string[];
  pattern: string;
  status: BingoSubmissionStatus;
  submitted_at: string;
  validated_at: string | null;
  validated_by: string | null;
  rejection_reason: string | null;
};
type SubmissionRow = {
  id: string;
  game_id: string;
  round_id: string;
  player_id: string;
  storage_path: string;
  status: SubmissionStatus;
  points_awarded: number;
  submitted_at: string;
  reviewed_at: string | null;
  attempt_id: string | null;
  intent_at: string | null;
  claimed_elapsed_ms: number | null;
  server_elapsed_ms: number | null;
  received_elapsed_ms: number | null;
  rank_ms: number | null;
  timing_status: "consistent" | "flagged" | null;
  timing_flags: string[];
  client_meta: Json | null;
};

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: ProfileRow;
        Insert: never; // created only by the auth.users trigger
        Update: { display_name?: string | null }; // role changes: service role only
        Relationships: [];
      };
      subscription_plans: {
        Row: PlanRow;
        Insert: Omit<PlanRow, "id" | "created_at" | "updated_at" | "description" | "price_cents" | "currency" | "is_active" | "max_games_per_period" | "tier" | "duration_seconds" | "is_trial" | "sort_order"> &
          Partial<Pick<PlanRow, "description" | "price_cents" | "currency" | "is_active" | "max_games_per_period" | "tier" | "duration_seconds" | "is_trial" | "sort_order">>;
        Update: Partial<Omit<PlanRow, "id" | "created_at" | "updated_at">>;
        Relationships: [];
      };
      platform_settings: {
        Row: SettingsRow;
        Insert: never;
        Update: Partial<Omit<SettingsRow, "id" | "updated_at">>; // service role only
        Relationships: [];
      };
      /** FROZEN legacy history since the Game Pass cutover (writes are refused by a trigger). */
      subscriptions: {
        Row: SubscriptionRow;
        Insert: never;
        Update: never;
        Relationships: [];
      };
      plan_prices: { Row: PlanPriceRow; Insert: never; Update: never; Relationships: [] }; // service role / migrations
      plan_polar_state: { Row: { plan_id: string; environment: string; polar_product_id: string; status: "in_sync" | "out_of_sync" | "sync_failed" | "polar_ahead"; polar_name: string | null;
        php_price_id: string | null; php_minor: number | null; usd_price_id: string | null; usd_minor: number | null; polar_modified_at: string | null;
        last_synced_at: string | null; last_checked_at: string | null; last_error: string | null; details: Json; updated_at: string }; Insert: never; Update: never; Relationships: [] };
      plan_sync_jobs: { Row: { id: string; plan_id: string; environment: string | null; polar_product_id: string | null; requested: Json; previous: Json;
        status: "pending" | "polar_applied" | "synced" | "failed" | "superseded"; stage: string | null; last_error: string | null; polar_result: Json | null;
        attempts: number; created_by: string | null; created_at: string; updated_at: string; completed_at: string | null }; Insert: never; Update: never; Relationships: [] };
      admin_audit_events: { Row: { id: number; at: string; admin_id: string | null; action: string; target: string; details: Json }; Insert: never; Update: never; Relationships: [] };
      entitlement_events: { Row: { id: number; at: string; user_id: string; pass_id: string | null; order_id: string | null; actor_kind: string; actor_id: string | null; action: string; details: Json }; Insert: never; Update: never; Relationships: [] };
      game_passes: { Row: GamePassRow; Insert: never; Update: never; Relationships: [] }; // ledger functions only
      pass_segments: { Row: PassSegmentRow; Insert: never; Update: never; Relationships: [] };
      pass_orders: { Row: PassOrderRow; Insert: never; Update: never; Relationships: [] };
      games: {
        Row: GameRow;
        Insert: Pick<GameRow, "owner_id" | "title"> & Partial<Pick<GameRow, "max_players">>;
        Update: Partial<Pick<GameRow, "title" | "max_players">>; // status/phase: game_transition() only
        Relationships: [];
      };
      game_rounds: {
        Row: RoundRow;
        Insert: Pick<RoundRow, "game_id" | "round_no" | "prompt"> &
          Partial<Pick<RoundRow, "time_limit_seconds" | "points">>;
        Update: Partial<Pick<RoundRow, "round_no" | "prompt" | "time_limit_seconds" | "points">>;
        Relationships: [];
      };
      players: {
        Row: PlayerRow;
        /** Service role only (guest join handler). */
        Insert: Pick<PlayerRow, "game_id" | "nickname" | "token_hash">;
        Update: Pick<Partial<PlayerRow>, "kicked_at">;
        Relationships: [];
      };
      submissions: {
        Row: SubmissionRow;
        /** Service role only (guest submission handler). */
        Insert: never; // only complete_submission() creates submissions
        Update: Partial<Pick<SubmissionRow, "status" | "points_awarded">>;
        Relationships: [];
      };
      /** BingoSnap: host-readable (RLS), written only by the BingoSnap functions. */
      bingo_games: { Row: BingoGameRow; Insert: never; Update: never; Relationships: [] };
      bingo_cells: { Row: BingoCellRow; Insert: never; Update: never; Relationships: [] };
      bingo_submissions: { Row: BingoSubmissionRow; Insert: never; Update: never; Relationships: [] };
    };
    Views: { [_ in never]: never };
    Functions: {
      my_entitlement: {
        Args: Record<string, never>;
        Returns: {
          subscription_id: string;
          plan_code: string;
          max_active_games: number;
          max_players_per_game: number;
          max_rounds_per_game: number;
          current_period_end: string;
        }[];
      };
      is_super_admin: { Args: Record<string, never>; Returns: boolean };
      my_access_status: {
        Args: Record<string, never>;
        Returns: { state: AccessState; plan_code: string | null; current_period_end: string | null }[];
      };
      /** Runs as the caller (RLS + triggers apply). Creates game + rounds + opens lobby atomically. */
      create_game_with_rounds: {
        Args: { p_title: string; p_items: string[] };
        Returns: { game_id: string; code: string }[];
      };
      /** Service role only (guest join + waiting lobby). */
      public_room_info: {
        Args: { p_code: string };
        Returns: { title: string; status: GameStatus; player_count: number; max_players: number }[];
      };
      join_game: {
        Args: { p_code: string; p_nickname: string; p_token_hash: string; p_existing_hash?: string };
        Returns: { player_id: string; nickname: string; game_id: string; restored: boolean }[];
      };
      /** Service role only. Returns the player's authoritative snapshot (or null). */
      player_game_state: { Args: { p_token_hash: string }; Returns: Json };
      host_game_state: { Args: { p_game: string }; Returns: Json };
      /** Service role only (Phase 8). Records the tap-time intent. */
      begin_submission: {
        Args: { p_token_hash: string; p_round: string; p_attempt: string; p_elapsed_ms: number; p_meta?: Json };
        Returns: Json;
      };
      /** Service role only. Creates THE submission after the photo is verified. */
      complete_submission: {
        Args: { p_token_hash: string; p_round: string; p_attempt: string; p_meta?: Json };
        Returns: Json;
      };
      discard_submission_intent: { Args: { p_token_hash: string; p_round: string; p_attempt: string }; Returns: undefined };
      /** Runs as the host (RLS): ranking for one round (policy in TIMING.md). */
      round_ranking: {
        Args: { p_round: string; p_near_ms?: number };
        Returns: {
          submission_id: string;
          rank: number;
          player_id: string;
          nickname: string;
          status: "pending" | "approved" | "rejected";
          rank_ms: number;
          claimed_elapsed_ms: number;
          server_elapsed_ms: number;
          timing_status: "consistent" | "flagged";
          timing_flags: string[];
          near_tie: boolean;
          is_leader: boolean;
          submitted_at: string;
          storage_path: string;
        }[];
      };
      /** Host only (checked inside): approve / disqualify / reset one submission of the current round. */
      review_submission: { Args: { p_submission: string; p_decision: "approve" | "disqualify" | "reset" }; Returns: Json };
      /** Host (RLS): per-round results incl. the winners' photo paths. */
      game_results: {
        Args: { p_game: string };
        Returns: { round_no: number; prompt: string; winner_name: string | null; winner_ms: number | null; winner_path: string | null; submissions: number }[];
      };
      /** Service role only. Winner photo path while the announcement is on screen. */
      player_winner_photo: { Args: { p_token_hash: string }; Returns: string | null };
      /** The ONLY way to change game status/phase. Runs as the host. */
      game_transition: {
        Args: { p_game: string; p_action: string; p_expected_version: number; p_winner?: string };
        Returns: Json;
      };
      /** Host adds one round to a lobby/live game (plan round limit enforced by trigger). */
      add_game_round: {
        Args: { p_game: string; p_prompt: string };
        Returns: Json;
      };
      /** Host replays a round stopped too early (before its winner): closes it as "no winner", starts a copy. */
      replay_round: {
        Args: { p_game: string; p_expected_version: number };
        Returns: Json;
      };
      admin_overview: {
        Args: Record<string, never>;
        Returns: {
          total_subscribers: number;
          active_subscribers: number;
          pending_subscribers: number;
          expired_subscribers: number;
          suspended_subscribers: number;
          deactivated_subscribers: number;
          total_games: number;
          completed_games: number;
          active_rooms: number;
        }[];
      };
      /** BingoSnap, signed-in host: creates the game through the Game Pass triggers. */
      create_bingosnap_game: {
        Args: {
          p_title: string; p_board_size: number; p_win_mode: BingoWinMode; p_free_space: boolean;
          p_duration_seconds: number; p_winner_rule: BingoWinnerRule; p_challenges: string[];
        };
        Returns: { game_id: string; code: string }[];
      };
      /** BingoSnap, signed-in host: create (p_game null) / save a board draft; optionally publish it (draft -> lobby). */
      bingo_save_board: {
        Args: {
          p_game: string | null; p_expected_revision: number; p_title: string; p_board_size: number; p_win_mode: BingoWinMode;
          p_free_space: boolean; p_duration_seconds: number; p_winner_rule: BingoWinnerRule; p_cells: string[]; p_publish?: boolean;
        };
        Returns: Json;
      };
      /** BingoSnap, signed-in host: the ONLY way to change a BingoSnap game's status/phase. */
      bingo_transition: {
        Args: { p_game: string; p_action: string; p_expected_version: number; p_winner_submission?: string };
        Returns: Json;
      };
      /** BingoSnap, signed-in host: winner rule, until the hunt starts. */
      bingo_update_settings: { Args: { p_game: string; p_expected_version: number; p_winner_rule: BingoWinnerRule }; Returns: Json };
      /** BingoSnap, signed-in host: verify / reject / reset one claim. */
      bingo_review_submission: { Args: { p_submission: string; p_decision: "verify" | "reject" | "reset"; p_reason?: string }; Returns: Json };
      /** BingoSnap, signed-in host: host or presenter snapshot. */
      bingo_host_state: { Args: { p_game: string; p_view?: "host" | "presenter" }; Returns: Json };
      /** BingoSnap, service role only: the participant's snapshot from their session token hash. */
      bingo_player_state: { Args: { p_token_hash: string }; Returns: Json };
      /** BingoSnap, service role only: public facts behind a room code for the join page (no challenges). */
      bingo_room_info: { Args: { p_code: string }; Returns: Json };
      /** BingoSnap host: start_game + 3 s countdown + hunt, in one transaction. */
      bingo_start: { Args: { p_game: string; p_expected_version: number }; Returns: Json };
      /** BingoSnap, service role only: a claim (cell ids only). */
      bingo_submit_claim: { Args: { p_token_hash: string; p_cell_ids: string[]; p_request_id?: string | null }; Returns: Json };
      admin_subscriber_state: {
        Args: { p_user: string };
        Returns: { state: AccessState; plan_code: string | null; current_period_end: string | null }[];
      };
      admin_list_subscribers: {
        Args: { p_search?: string; p_state?: AccessState; p_limit?: number; p_offset?: number };
        Returns: {
          user_id: string;
          email: string | null;
          display_name: string | null;
          joined_at: string;
          state: AccessState;
          plan_code: string | null;
          current_period_end: string | null;
          total_count: number;
        }[];
      };
      /** Service role only. */
      admin_set_subscription: {
        Args: {
          p_user: string;
          p_action: "activate" | "set_plan" | "set_expiry" | "suspend";
          p_plan_code?: string;
          p_days?: number;
          p_expires?: string;
        };
        Returns: undefined;
      };
      /** Service role only. */
      admin_set_account_active: { Args: { p_user: string; p_active: boolean }; Returns: undefined };
      // ----------------------------------------------------------------- Game Pass ----
      /** Signed-in host: claim the one-time free trial (errors: trial_already_used, has_paid_history, ...). */
      start_trial: { Args: Record<string, never>; Returns: Json };
      my_trial_eligibility: { Args: Record<string, never>; Returns: { eligible: boolean; reason: string | null }[] };
      /** Service role only. */
      trial_eligibility: { Args: { p_user: string }; Returns: { eligible: boolean; reason: string | null }[] };
      /** Signed-in host: grant the automatic free trial if eligible (idempotent; never resets). */
      ensure_my_trial: { Args: Record<string, never>; Returns: { granted: boolean; reason: string | null; pass_id: string | null }[] };
      /** Signed-in host: dashboard summary computed with the database clock. */
      my_game_pass_summary: { Args: Record<string, never>; Returns: GamePassSummary };
      my_pass_timeline: { Args: Record<string, never>; Returns: PassTimelineRow[] };
      /** Super admin session (checked inside). */
      admin_pass_timeline: { Args: { p_user: string }; Returns: PassTimelineRow[] };
      /** Service role only. Current entitlement (at most one row). */
      pass_entitlement: {
        Args: { p_user: string };
        Returns: {
          pass_id: string;
          plan_id: string;
          plan_code: string;
          source: PassSource;
          max_players_per_game: number;
          max_active_games: number;
          max_rounds_per_game: number;
          max_games_per_period: number | null;
          activated_at: string;
          current_period_end: string;
          access_until: string;
          payment_status: OrderStatus | null;
        }[];
      };
      /** Service role only; p_admin = the authorized super admin's user id (audited). */
      admin_grant_pass: { Args: { p_admin: string | null; p_user: string; p_plan_code: string; p_days: number; p_reason: string }; Returns: string };
      admin_revoke_pass: { Args: { p_admin: string | null; p_pass: string; p_reason: string }; Returns: undefined };
      admin_set_suspended: { Args: { p_admin: string | null; p_user: string; p_suspended: boolean; p_reason: string }; Returns: undefined };
      admin_set_pass_plan: { Args: { p_admin: string | null; p_user: string; p_plan_code: string }; Returns: undefined };
      admin_set_pass_expiry: { Args: { p_admin: string | null; p_user: string; p_expires: string }; Returns: undefined };
      admin_review_order: { Args: { p_admin: string | null; p_order: string; p_decision: "approve" | "reject"; p_reason: string }; Returns: undefined };
      /** Service role only (Phase 3 checkout). */
      create_pass_order: {
        Args: { p_user: string; p_plan_code: string; p_currency: Currency };
        Returns: { order_id: string; amount_minor: number; currency: Currency; polar_product_id: string; polar_price_id: string | null }[];
      };
      attach_checkout: { Args: { p_order: string; p_checkout_id: string }; Returns: undefined };
      /** Service role only (Phase 4). Environment + product come from the server's env config. */
      create_checkout_order: {
        Args: { p_user: string; p_plan_code: string; p_currency: Currency; p_environment: "sandbox" | "production"; p_polar_product_id: string };
        Returns: { order_id: string; amount_minor: number; currency: Currency }[];
      };
      /** Service role only. Records Polar's checkout figures; returns "ok" or the mismatch reason (order then canceled). */
      attach_verified_checkout: {
        Args: { p_order: string; p_checkout_id: string; p_product_id: string; p_currency: string; p_amount_minor: number; p_total_minor: number | null;
                p_url?: string | null; p_expires_at?: string | null };
        Returns: string;
      };
      cancel_unstarted_order: { Args: { p_order: string; p_reason: string }; Returns: undefined };
      /** Service role only (Phase 5): idempotent start; reuses an open verified checkout. */
      start_checkout_order: {
        Args: { p_user: string; p_plan_code: string; p_currency: Currency; p_environment: "sandbox" | "production"; p_polar_product_id: string };
        Returns: { order_id: string; amount_minor: number; currency: Currency; reused: boolean; in_flight: boolean; checkout_url: string | null }[];
      };
      /** Signed-in host / super admin (Phase 8). */
      my_purchase_history: { Args: Record<string, never>; Returns: PurchaseHistoryRow[] };
      admin_purchase_history: { Args: { p_user: string }; Returns: PurchaseHistoryRow[] };
      admin_revenue: {
        Args: Record<string, never>;
        Returns: { environment: string; currency: string; paid_orders: number; refunded_orders: number; gross_minor: number; refunds_minor: number; net_minor: number; needs_review: number }[];
      };
      admin_pass_counts: { Args: Record<string, never>; Returns: { source: PassSource; passes: number; active_now: number; granted_days: number }[] };
      /** Service role only; p_admin re-checked; audited in admin_audit_events. */
      admin_update_plan: { Args: { p_admin: string; p_plan: string; p_patch: Json }; Returns: undefined };
      admin_set_plan_price: { Args: { p_admin: string; p_plan: string; p_currency: Currency; p_amount_minor: number }; Returns: string };
      admin_log: { Args: { p_admin: string; p_action: string; p_target: string; p_details?: Json }; Returns: undefined };
      /** Service role only (admin plan -> Polar sync). */
      admin_begin_plan_sync: { Args: { p_admin: string; p_plan: string; p_environment: string | null; p_product_id: string | null; p_requested: Json }; Returns: string };
      admin_retry_plan_sync: { Args: { p_admin: string; p_job: string }; Returns: Json };
      admin_fail_plan_sync: { Args: { p_admin: string; p_job: string; p_stage: string; p_error: string; p_polar?: Json }; Returns: undefined };
      admin_finish_plan_sync: { Args: { p_admin: string; p_job: string; p_polar: Json }; Returns: undefined };
      record_polar_product_state: { Args: { p_environment: string; p_plan_code: string; p_product: Json }; Returns: string };
      /** Service role only (POST /api/snappy): add a batch (1..500) of homepage taps; returns the new total. */
      add_snappy_taps: { Args: { p_taps: number }; Returns: number };
      /** Service role only: total homepage taps. */
      get_snappy_taps: { Args: Record<string, never>; Returns: number };
      /** Signed-in host: status of THEIR checkout (read-only). */
      my_checkout_status: { Args: { p_checkout_id: string }; Returns: Json };
      /** Service role only, AFTER webhook signature verification. Idempotent per (provider, event_id). */
      apply_payment_event: {
        Args: { p_provider: "polar"; p_event_id: string; p_event_type: string; p_payload: Json; p_effect: Json };
        Returns: "duplicate" | "applied" | "duplicate_effect" | "ignored" | "unmatched" | "needs_review";
      };
    };
    Enums: {
      user_role: UserRole;
      subscription_status: SubscriptionStatus;
      game_status: GameStatus;
      round_status: RoundStatus;
      submission_status: SubmissionStatus;
      pass_source: PassSource;
      pass_disposition: PassDisposition;
      order_status: OrderStatus;
      game_type: GameType;
      bingo_win_mode: BingoWinMode;
      bingo_winner_rule: BingoWinnerRule;
      bingo_submission_status: BingoSubmissionStatus;
    };
    CompositeTypes: { [_ in never]: never };
  };
};

// Convenience aliases
export type Profile = ProfileRow;
export type PlatformSettings = SettingsRow;
export type SubscriptionPlan = PlanRow;
export type Subscription = SubscriptionRow;
export type Game = GameRow;
export type GameRound = RoundRow;
/** Player row as visible to hosts (no token_hash). */
export type PublicPlayer = Omit<PlayerRow, "token_hash">;
export type Player = PlayerRow;
export type Submission = SubmissionRow;
export type AccessStatus = Database["public"]["Functions"]["my_access_status"]["Returns"][number];
export type SubscriberRow = Database["public"]["Functions"]["admin_list_subscribers"]["Returns"][number];
export type Entitlement = Database["public"]["Functions"]["my_entitlement"]["Returns"][number];
export type PlanPrice = PlanPriceRow;
export type GamePass = GamePassRow;
export type PassOrder = PassOrderRow;
export type PassTimelineEntry = PassTimelineRow;
