-- BringMe! live-schema inspection. READ-ONLY: every statement is a SELECT.
-- Run in Supabase > SQL Editor BEFORE applying 20261110000000_legacy_schema_compat.sql
-- and send the results back if anything looks unexpected.
-- (Not a migration: it lives outside supabase/migrations on purpose.)

-- 1. Columns of the BringMe! tables (type, nullability, default)
select table_name, ordinal_position as pos, column_name,
       case when data_type = 'USER-DEFINED' then udt_name else data_type end as type,
       is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name in ('profiles','subscription_plans','subscriptions','games','game_rounds','players','submissions',
                     'platform_settings','submission_intents')
order by table_name, ordinal_position;

-- 2. Constraints (PK / UNIQUE / FK / CHECK) on those tables
select conrelid::regclass as table_name, conname, contype, pg_get_constraintdef(oid) as definition
from pg_constraint
where connamespace = 'public'::regnamespace
  and conrelid::regclass::text in ('profiles','subscription_plans','subscriptions','games','game_rounds','players','submissions')
order by 1, contype, conname;

-- 3. Indexes
select tablename, indexname, indexdef from pg_indexes
where schemaname = 'public'
  and tablename in ('profiles','subscription_plans','subscriptions','games','game_rounds','players','submissions')
order by 1, 2;

-- 4. Enum types and their values (migration 1 / 4 / 9 create these)
select t.typname, string_agg(e.enumlabel, ', ' order by e.enumsortorder) as labels
from pg_type t join pg_enum e on e.enumtypid = t.oid
where t.typnamespace = 'public'::regnamespace
group by 1 order by 1;

-- 5. RLS state and existing policies (legacy policies can block column type changes)
select c.relname, c.relrowsecurity as rls_on, c.relforcerowsecurity as rls_forced
from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' order by 1;
select tablename, policyname, cmd, roles::text, qual, with_check
from pg_policies where schemaname in ('public','storage') order by 1, 2;

-- 6. Views / materialized views depending on these tables (also block type changes)
select distinct v.relname as dependent_view, t.relname as on_table
from pg_depend d
join pg_rewrite r on r.oid = d.objid
join pg_class v on v.oid = r.ev_class
join pg_class t on t.oid = d.refobjid
where t.relnamespace = 'public'::regnamespace and v.oid <> t.oid
  and t.relname in ('profiles','subscription_plans','subscriptions','games','game_rounds','players','submissions');

-- 7. Triggers (incl. auth.users signup triggers) and public functions
select event_object_schema as schema, event_object_table as on_table, trigger_name, action_timing, event_manipulation
from information_schema.triggers
where event_object_schema in ('public','auth') order by 1, 2, 3;
select p.proname, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef as security_definer
from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1;

-- 8. Row counts (what must be preserved)
select 'auth.users' as t, count(*) from auth.users
union all select 'profiles', count(*) from public.profiles
union all select 'subscription_plans', count(*) from public.subscription_plans
union all select 'subscriptions', count(*) from public.subscriptions
union all select 'games', count(*) from public.games
union all select 'game_rounds', count(*) from public.game_rounds
union all select 'players', count(*) from public.players
union all select 'submissions', count(*) from public.submissions;

-- 9. Values the compatibility migration must convert to enums.
--    Anything outside the listed labels makes it stop (nothing is changed) and must be mapped by you first.
select 'profiles.role' as col, role::text as value, count(*) from public.profiles group by 2
union all select 'subscriptions.status', status::text, count(*) from public.subscriptions group by 2
union all select 'games.status', status::text, count(*) from public.games group by 2
union all select 'game_rounds.status', status::text, count(*) from public.game_rounds group by 2
union all select 'submissions.status', status::text, count(*) from public.submissions group by 2
order by 1, 2;
-- allowed: role {super_admin, subscriber}; subscriptions {trialing, active, past_due, canceled, expired, suspended};
--          games {draft, lobby, live, finished, canceled}; rounds {pending, open, closed}; submissions {pending, approved, rejected}

-- 10. Duplicates that would block the unique indexes the migrations create
select 'plans.code' as k, code::text as v, count(*) from public.subscription_plans group by 2 having count(*) > 1
union all select 'games.room_code', room_code::text, count(*) from public.games group by 2 having count(*) > 1
union all select 'players.(game,lower(nickname))', game_id::text || '/' || lower(nickname), count(*) from public.players group by 2 having count(*) > 1
union all select 'submissions.(round,player)', round_id::text || '/' || player_id::text, count(*) from public.submissions group by 2 having count(*) > 1
union all select 'live subscriptions per user', user_id::text, count(*) from public.subscriptions
  where status::text in ('trialing','active','past_due') group by 2 having count(*) > 1;
-- (If a column named here doesn't exist, delete that line: the query is only a check.)

-- 11. Which migrations already left their marks (helps decide what to re-run)
select 'm1 generate_join_code()' as marker, to_regprocedure('public.generate_join_code()') is not null as present
union all select 'm2 is_super_admin()',         to_regprocedure('public.is_super_admin()') is not null
union all select 'm3 storage bucket',           exists (select 1 from storage.buckets where id = 'submissions')
union all select 'm4 enum suspended',           exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'subscription_status' and e.enumlabel = 'suspended')
union all select 'm5 my_access_status()',       to_regprocedure('public.my_access_status()') is not null
union all select 'm6 platform_settings',        to_regclass('public.platform_settings') is not null
union all select 'm7 create_game_with_rounds',  exists (select 1 from pg_proc where proname = 'create_game_with_rounds')
union all select 'm8 join_game',                exists (select 1 from pg_proc where proname = 'join_game')
union all select 'm9 game_transition',          exists (select 1 from pg_proc where proname = 'game_transition')
union all select 'm10 submission_intents',      to_regclass('public.submission_intents') is not null
union all select 'm11 review_submission',       exists (select 1 from pg_proc where proname = 'review_submission');
