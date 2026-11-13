-- BringMe! production drift checks (READ-ONLY: catalog lookups and row COUNTS; no personal data).
-- Companion to production_fingerprint.sql; see BRINGME_PRODUCTION_MIGRATION_RECONCILIATION.md section C.
-- Run: npx supabase db query --remote --read-only -f supabase/inspect/production_drift_checks.sql
-- 'violations' = existing rows that would break each constraint the legacy upgrade path never created (0 = safe to add).
select jsonb_build_object(
  'unique_indexes', (select jsonb_object_agg(i, to_regclass('public.' || i) is not null) from unnest(array['games_join_code_key','players_token_hash_key','subscription_plans_code_key','subscriptions_external_ref_key','game_rounds_game_id_round_no_key','submissions_round_id_player_id_key']) i),
  'not_valid_constraints', (select jsonb_agg(c.conrelid::regclass::text || '/' || c.conname) from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname = 'public' and not c.convalidated),
  'max_photo_size_mb', (select max_photo_size_mb from public.platform_settings limit 1),
  'audit_actions', (select jsonb_object_agg(action, n) from (select action, count(*) n from public.admin_audit_events group by action) s),
  'violations', jsonb_build_object(
    'games_join_code_format', (select count(*) from public.games where join_code !~ '^[A-Z0-9]{6}$'),
    'games_max_players_range', (select count(*) from public.games where max_players not between 2 and 500),
    'games_title_len', (select count(*) from public.games where char_length(btrim(title)) not between 1 and 80),
    'rounds_round_no', (select count(*) from public.game_rounds where round_no < 1),
    'rounds_points', (select count(*) from public.game_rounds where points not between 0 and 10000),
    'rounds_prompt_len', (select count(*) from public.game_rounds where char_length(btrim(prompt)) not between 1 and 200),
    'rounds_time_limit', (select count(*) from public.game_rounds where time_limit_seconds not between 10 and 600),
    'rounds_winner_submission_orphan', (select count(*) from public.game_rounds r where r.winner_submission_id is not null and not exists (select 1 from public.submissions s where s.id = r.winner_submission_id)),
    'players_nickname', (select count(*) from public.players where not (char_length(nickname) between 1 and 24 and nickname = btrim(nickname))),
    'players_token_hash_format', (select count(*) from public.players where token_hash !~ '^[0-9a-f]{64}$'),
    'profiles_display_name', (select count(*) from public.profiles where display_name is not null and char_length(display_name) not between 1 and 60),
    'submissions_storage_path_null', (select count(*) from public.submissions where storage_path is null),
    'submissions_storage_path_format', (select count(*) from public.submissions where storage_path is not null and storage_path !~ ('^' || game_id::text || '/' || round_id::text || '/' || player_id::text || '\.(jpg|png|webp)$')),
    'submissions_points', (select count(*) from public.submissions where points_awarded < 0),
    'submissions_orphan_round_game', (select count(*) from public.submissions s where not exists (select 1 from public.game_rounds r where r.id = s.round_id and r.game_id = s.game_id)),
    'submissions_orphan_player_game', (select count(*) from public.submissions s where not exists (select 1 from public.players p where p.id = s.player_id and p.game_id = s.game_id)),
    'plans_code_format', (select count(*) from public.subscription_plans where code !~ '^[a-z0-9_-]{2,40}$'),
    'plans_currency_format', (select count(*) from public.subscription_plans where currency !~ '^[a-z]{3}$'),
    'plans_limits', (select count(*) from public.subscription_plans where max_active_games <= 0 or max_rounds_per_game <= 0 or max_players_per_game not between 2 and 500 or price_cents < 0 or char_length(name) not between 1 and 80),
    'subscriptions_period', (select count(*) from public.subscriptions where not (current_period_end > current_period_start))
  ),
  'active_now', (select jsonb_object_agg(status::text || '/' || phase::text, n) from (select status, phase, count(*) n from public.games where status in ('lobby','live') group by 1, 2) s),
  'lobby_game_updated', (select max(updated_at) from public.games where status in ('lobby','live'))
) as checks;
