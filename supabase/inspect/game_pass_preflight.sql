-- BringMe! Game Pass — PRE-MIGRATION verification. READ-ONLY (every statement is a SELECT).
-- Run in Supabase > SQL Editor BEFORE 20261112000001..7 and keep the output with the
-- change record (MIGRATION_VERIFICATION.md §3). Each block says what "go" looks like.

-- P1. Baseline row counts (re-run after the migration: every number must be identical,
--     except subscription_plans +1 for the new 'trial' plan).
select 'auth.users' t, count(*) from auth.users
union all select 'profiles', count(*) from public.profiles
union all select 'subscription_plans', count(*) from public.subscription_plans
union all select 'subscriptions', count(*) from public.subscriptions
union all select 'games', count(*) from public.games
union all select 'game_rounds', count(*) from public.game_rounds
union all select 'players', count(*) from public.players
union all select 'submissions', count(*) from public.submissions
union all select 'platform_settings', count(*) from public.platform_settings;

-- P2. Migration history (expect 13 rows if the CLI was used; often EMPTY when files were run
--     in the SQL Editor -> repair history before any `supabase db push`, see MIGRATION_VERIFICATION.md).
select version, name from supabase_migrations.schema_migrations order by version;

-- P3. Prerequisites the Game Pass files check themselves (all must be true).
select 'subscription_plans.code unique' as check, exists (
         select 1 from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
         where i.indrelid = 'public.subscription_plans'::regclass and i.indisunique and i.indnatts = 1
           and i.indpred is null and a.attname = 'code') as ok
union all select 'plans have code/max_players_per_game/max_active_games/max_rounds_per_game',
         (select count(*) = 4 from information_schema.columns where table_schema = 'public' and table_name = 'subscription_plans'
            and column_name in ('code', 'max_players_per_game', 'max_active_games', 'max_rounds_per_game'))
union all select 'players.nickname exists', exists (select 1 from information_schema.columns
         where table_schema = 'public' and table_name = 'players' and column_name = 'nickname')
union all select 'subscriptions.current_period_start/end exist',
         (select count(*) = 2 from information_schema.columns where table_schema = 'public' and table_name = 'subscriptions'
            and column_name in ('current_period_start', 'current_period_end'))
union all select 'btree_gist available', exists (select 1 from pg_available_extensions where name = 'btree_gist')
union all select 'auth.users.email_confirmed_at exists', exists (select 1 from information_schema.columns
         where table_schema = 'auth' and table_name = 'users' and column_name = 'email_confirmed_at')
union all select 'm11 applied (review_submission)', exists (select 1 from pg_proc where proname = 'review_submission')
union all select 'm12 applied (no host DELETE on games)', not has_table_privilege('authenticated', 'public.games', 'DELETE')
union all select 'Game Pass NOT yet applied (no game_passes)', to_regclass('public.game_passes') is null;

-- P4. Nullability / constraints of the tables the migration reads or extends.
select table_name, column_name, is_nullable, column_default,
       case when data_type = 'USER-DEFINED' then udt_name else data_type end as type
from information_schema.columns
where table_schema = 'public' and table_name in ('subscription_plans', 'subscriptions', 'profiles', 'games')
order by table_name, ordinal_position;
select conrelid::regclass t, conname, pg_get_constraintdef(oid) def
from pg_constraint where conrelid in ('public.subscription_plans'::regclass, 'public.subscriptions'::regclass)
order by 1, 2;
select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename in ('subscriptions', 'subscription_plans');

-- P5. Data the backfill must map. "Go" = P5b and P5c return NO rows.
--   a) every subscription with its plan (expect live: 1 row, starter, active, ends 2026-12-11)
select s.id, p.code, s.status, s.current_period_start, s.current_period_end, s.external_ref,
       s.current_period_end > now() as running
from public.subscriptions s join public.subscription_plans p on p.id = s.plan_id order by s.user_id, s.current_period_start;
--   b) running rows that start in the future (backfill refuses them)
select id from public.subscriptions
where status in ('trialing', 'active', 'suspended') and current_period_start > now();
--   c) overlapping running rows of one user (backfill refuses them)
select a.id, b.id from public.subscriptions a join public.subscriptions b on b.user_id = a.user_id and a.id < b.id
where a.status in ('trialing', 'active', 'suspended') and b.status in ('trialing', 'active', 'suspended')
  and a.current_period_end > now() and b.current_period_end > now()
  and tstzrange(a.current_period_start, a.current_period_end, '[)') && tstzrange(b.current_period_start, b.current_period_end, '[)');
--   d) plan limits that will be kept / changed (pro 200 -> 100 only if it is still 200)
select code, name, is_active, max_players_per_game, max_active_games, max_rounds_per_game, max_games_per_period, price_cents, currency
from public.subscription_plans order by max_players_per_game;
--   e) is any plan already coded 'trial'? (it would be converted into THE trial plan)
select id, code, name from public.subscription_plans where code = 'trial';

-- P6. Function / trigger dependencies the cutover replaces (bodies are re-created with the
--     same signatures; record them so the revert can be compared).
select p.proname, pg_get_function_identity_arguments(p.oid) args, p.prosecdef definer, md5(p.prosrc) body_md5
from pg_proc p where p.pronamespace = 'public'::regnamespace
  and p.proname in ('entitlement_for', 'access_state_for', 'enforce_game_insert', 'enforce_player_insert',
                    'public_room_info', 'game_transition', 'admin_set_subscription', 'my_entitlement', 'my_access_status')
order by 1;
select event_object_table, trigger_name, action_timing, event_manipulation
from information_schema.triggers
where event_object_schema = 'public' and event_object_table in ('subscriptions', 'subscription_plans', 'profiles', 'games', 'players')
order by 1, 2;
-- Anything (views, other functions) that references the subscriptions table:
select distinct v.relname as dependent from pg_depend d join pg_rewrite r on r.oid = d.objid
join pg_class v on v.oid = r.ev_class where d.refobjid = 'public.subscriptions'::regclass and v.oid <> d.refobjid;

-- P7. Locks: the migration takes brief ACCESS EXCLUSIVE locks on subscription_plans and profiles
--     (ADD COLUMN with constant defaults: metadata-only, no rewrite) and on subscriptions/games/
--     players for CREATE TRIGGER. Check nothing long-running holds them right now:
select pid, state, now() - xact_start as xact_age, left(query, 80) q
from pg_stat_activity where datname = current_database() and state <> 'idle' and pid <> pg_backend_pid()
order by xact_start nulls last;
