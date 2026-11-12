-- BringMe! — compatibility bridge for databases that ALREADY had an older
-- BringMe! schema before 20261111000001 ran.
--
-- Why: migration 1 uses CREATE TABLE IF NOT EXISTS, so pre-existing tables
-- (room_code, item_name, round_number, starts_at/expires_at, price, max_players,
-- max_games, display_name, ...) were kept as-is, and every later statement that
-- names a column only migration 1 would have created failed with 42703
-- (e.g. p.code / p.max_active_games / players.nickname / join_code / round_no).
--
-- What it does, only where a table already exists (a no-op on a fresh project):
--   * adds every column migration 1 expects (ADD COLUMN IF NOT EXISTS),
--     backfills it from the legacy column when there is one, then sets
--     NOT NULL / defaults only when every row has a value;
--   * converts status/role text columns to the enum types (only if every
--     existing value is a valid label; otherwise it stops and changes nothing);
--   * adds the unique keys later migrations rely on (composite FK targets,
--     join code, token hash, one submission per player per round);
--   * relaxes NOT NULL on legacy-only columns the new code never writes;
--   * removes LEGACY row-level policies on these tables (policies are OR-ed, so an
--     old "read all" policy would silently defeat migration 2's rules). Data is untouched.
-- It never drops a table, a column or a row. Safe to re-run.
-- Order: run this FIRST, then 20261111000001 … 20261111000012 (see supabase/README.md).

-- ------------------------------------------------ enums (same as migration 1) ----
do $$ begin create type public.user_role as enum ('super_admin', 'subscriber'); exception when duplicate_object then null; end $$;
do $$ begin create type public.subscription_status as enum ('trialing', 'active', 'past_due', 'canceled', 'expired'); exception when duplicate_object then null; end $$;
do $$ begin create type public.game_status as enum ('draft', 'lobby', 'live', 'finished', 'canceled'); exception when duplicate_object then null; end $$;
do $$ begin create type public.round_status as enum ('pending', 'open', 'closed'); exception when duplicate_object then null; end $$;
do $$ begin create type public.submission_status as enum ('pending', 'approved', 'rejected'); exception when duplicate_object then null; end $$;

-- Needed to backfill join codes; migration 1 re-creates it with the same body.
create or replace function public.generate_join_code()
returns text language plpgsql volatile security definer set search_path = '' as $$
declare
  v_code text;
begin
  loop
    v_code := upper(substr(
      translate(encode(sha256(uuid_send(gen_random_uuid())), 'base64'), '+/=0O1lIiLo', ''),
      1, 6));
    if char_length(v_code) = 6
       and not exists (select 1 from public.games where join_code = v_code) then
      return v_code;
    end if;
  end loop;
end $$;
revoke all on function public.generate_join_code() from public, anon;

-- ------------------------------------------------------ session-local helpers ----
create or replace function pg_temp.has_tbl(t text) returns boolean language sql stable as
  $$ select to_regclass('public.' || t) is not null $$;
create or replace function pg_temp.has_col(t text, c text) returns boolean language sql stable as
  $$ select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = t and column_name = c) $$;

-- ADD COLUMN IF NOT EXISTS (+ default) only when the table exists.
create or replace function pg_temp.add_col(t text, c text, def text) returns void language plpgsql as $$
begin
  if pg_temp.has_tbl(t) then execute format('alter table public.%I add column if not exists %I %s', t, c, def); end if;
end $$;

-- Backfill c from a SQL expression where c is null (expression may use legacy columns: check first).
create or replace function pg_temp.fill(t text, c text, expr text) returns void language plpgsql as $$
begin
  if pg_temp.has_col(t, c) then execute format('update public.%I set %I = %s where %I is null', t, c, expr, c); end if;
end $$;

-- SET NOT NULL only if no row is null (otherwise leave it nullable and say so).
create or replace function pg_temp.not_null(t text, c text) returns void language plpgsql as $$
declare n bigint;
begin
  if not pg_temp.has_col(t, c) then return; end if;
  execute format('select count(*) from public.%I where %I is null', t, c) into n;
  if n = 0 then execute format('alter table public.%I alter column %I set not null', t, c);
  else raise notice 'legacy_compat: %.% left NULLABLE (% legacy rows have no value)', t, c, n; end if;
end $$;

-- Unique index if missing; stops with a clear message if duplicates exist.
create or replace function pg_temp.uniq(t text, idx text, cols text) returns void language plpgsql as $$
begin
  if pg_temp.has_tbl(t) and to_regclass('public.' || idx) is null then
    execute format('create unique index %I on public.%I (%s)', idx, t, cols);
  end if;
exception when unique_violation then
  raise exception 'legacy_compat: duplicate values in %(%) block a required unique key — see supabase/inspect/schema_inspection.sql #10', t, cols;
end $$;

-- Convert a text column to an enum (keeps every value). Stops if a value is not a valid label.
create or replace function pg_temp.to_enum(t text, c text, typ text, def text) returns void language plpgsql as $$
declare
  v_udt text; v_bad text; r record;
begin
  if not pg_temp.has_col(t, c) then return; end if;
  select udt_name into v_udt from information_schema.columns where table_schema = 'public' and table_name = t and column_name = c;
  if v_udt = typ then return; end if;
  execute format('select string_agg(distinct %1$I::text, '', '') from public.%2$I
                  where %1$I is not null and not (%1$I::text = any (enum_range(null::public.%3$I)::text[]))', c, t, typ) into v_bad;
  if v_bad is not null then
    raise exception 'legacy_compat: %.% contains values that are not valid %: [%]. Map them to valid values first (inspection query #9); nothing was changed.', t, c, typ, v_bad;
  end if;
  if exists (select 1 from pg_depend d join pg_rewrite rw on rw.oid = d.objid
             where d.refobjid = format('public.%I', t)::regclass
               and d.refobjsubid = (select attnum from pg_attribute where attrelid = format('public.%I', t)::regclass and attname = c)) then
    raise exception 'legacy_compat: a view depends on %.%; drop/recreate it around this migration (inspection query #6). Nothing was changed.', t, c;
  end if;
  -- Policies that read this column (legacy ones, or ones a partial migration 2 left
  -- behind comparing it as text) block ALTER TYPE. Migrations 2+ re-create theirs.
  for r in select distinct pol.polname, cls.relname from pg_depend d
           join pg_policy pol on pol.oid = d.objid and d.classid = 'pg_policy'::regclass
           join pg_class cls on cls.oid = pol.polrelid
           where d.refobjid = format('public.%I', t)::regclass
             and d.refobjsubid = (select attnum from pg_attribute where attrelid = format('public.%I', t)::regclass and attname = c) loop
    raise notice 'legacy_compat: dropping policy % on % (reads %.% as text; migrations 2+ re-create the real policies)', r.polname, r.relname, t, c;
    execute format('drop policy %I on public.%I', r.polname, r.relname);
  end loop;
  -- Partial/expression indexes comparing it as text can't be rebuilt for an enum. They hold no data;
  -- migration 1 re-creates its own (IF NOT EXISTS).
  for r in select ic.relname from pg_index i join pg_class ic on ic.oid = i.indexrelid
           where i.indrelid = format('public.%I', t)::regclass
             and (i.indpred is not null or i.indexprs is not null)
             and pg_get_indexdef(i.indexrelid) ~ ('\m' || c || '\M')
             and not exists (select 1 from pg_constraint k where k.conindid = i.indexrelid) loop
    raise notice 'legacy_compat: dropping partial/expression index % (compares %.% as text; recreated by migration 1 if it is one of ours)', r.relname, t, c;
    execute format('drop index public.%I', r.relname);
  end loop;
  -- Legacy CHECKs compare the column as text and would block the type change.
  for r in select con.conname from pg_constraint con
           where con.conrelid = format('public.%I', t)::regclass and con.contype = 'c'
             and exists (select 1 from pg_attribute a where a.attrelid = con.conrelid and a.attnum = any (con.conkey) and a.attname = c) loop
    raise notice 'legacy_compat: replacing legacy check % on %.% (the enum type now enforces the values)', r.conname, t, c;
    execute format('alter table public.%I drop constraint %I', t, r.conname);
  end loop;
  execute format('alter table public.%I alter column %I drop default', t, c);
  execute format('alter table public.%I alter column %I type public.%I using %I::text::public.%I', t, c, typ, c, typ);
  execute format('alter table public.%I alter column %I set default %L::public.%I', t, c, def, typ);
end $$;

-- Legacy-only columns: drop NOT NULL when they have no default (new code never writes them).
create or replace function pg_temp.relax_legacy(t text, expected text[]) returns void language plpgsql as $$
declare r record;
begin
  for r in select column_name from information_schema.columns
           where table_schema = 'public' and table_name = t and is_nullable = 'NO'
             and column_default is null and not (column_name = any (expected)) loop
    raise notice 'legacy_compat: %.% is a legacy column; dropping its NOT NULL so new rows can be inserted', t, r.column_name;
    execute format('alter table public.%I alter column %I drop not null', t, r.column_name);
  end loop;
end $$;

-- Remove legacy policies (any name the migrations don't define). Migration 2+ create the real ones.
create or replace function pg_temp.drop_legacy_policies(t text, keep text[]) returns void language plpgsql as $$
declare r record;
begin
  for r in select policyname from pg_policies where schemaname = 'public' and tablename = t and not (policyname = any (keep)) loop
    raise notice 'legacy_compat: dropping legacy policy "%" on % (rows are not affected)', r.policyname, t;
    execute format('drop policy %I on public.%I', r.policyname, t);
  end loop;
end $$;

-- id must be a usable key with a generated default (new code never supplies ids).
create or replace function pg_temp.fix_id(t text) returns void language plpgsql as $$
begin
  if not pg_temp.has_tbl(t) then return; end if;
  if not exists (select 1 from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
                 where i.indrelid = format('public.%I', t)::regclass and (i.indisprimary or i.indisunique)
                   and i.indnatts = 1 and a.attname = 'id') then
    raise exception 'legacy_compat: public.%.id is not a primary/unique key; add one before continuing', t;
  end if;
  if (select column_default from information_schema.columns where table_schema = 'public' and table_name = t and column_name = 'id') is null
     and t <> 'profiles' then
    execute format('alter table public.%I alter column id set default gen_random_uuid()', t);
  end if;
end $$;

-- Give an existing timestamp column a now() default if it has none.
create or replace function pg_temp.default_now(t text, c text) returns void language plpgsql as $$
begin
  if pg_temp.has_col(t, c) and (select column_default from information_schema.columns
       where table_schema = 'public' and table_name = t and column_name = c) is null then
    execute format('alter table public.%I alter column %I set default now()', t, c);
  end if;
end $$;

-- Legacy policies go first: they may reference columns whose type changes below.
select pg_temp.drop_legacy_policies('profiles', array['profiles_select_own','profiles_select_admin','profiles_update_own']);
select pg_temp.drop_legacy_policies('subscription_plans', array['plans_select_active','plans_select_admin']);
select pg_temp.drop_legacy_policies('subscriptions', array['subs_select_own','subs_select_admin']);
select pg_temp.drop_legacy_policies('games', array['games_select_own','games_select_admin','games_insert_own','games_update_own','games_delete_own']);
select pg_temp.drop_legacy_policies('game_rounds', array['rounds_select_own','rounds_select_admin','rounds_insert_own','rounds_update_own','rounds_delete_own']);
select pg_temp.drop_legacy_policies('players', array['players_select_own','players_select_admin','players_update_own']);
select pg_temp.drop_legacy_policies('submissions', array['submissions_select_own','submissions_select_admin','submissions_update_own']);

-- ------------------------------------------------------------------ profiles ----
select pg_temp.fix_id('profiles');
select pg_temp.add_col('profiles', 'email', 'text');
select pg_temp.add_col('profiles', 'display_name', 'text');
select pg_temp.add_col('profiles', 'role', 'text');
select pg_temp.add_col('profiles', 'created_at', 'timestamptz default now()');
select pg_temp.add_col('profiles', 'updated_at', 'timestamptz default now()');
do $$ begin
  if pg_temp.has_tbl('profiles') then
    update public.profiles p set email = u.email from auth.users u where u.id = p.id and p.email is null;
  end if;
end $$;
select pg_temp.fill('profiles', 'role', '''subscriber''');
select pg_temp.to_enum('profiles', 'role', 'user_role', 'subscriber');
select pg_temp.fill('profiles', 'created_at', 'now()');
select pg_temp.fill('profiles', 'updated_at', 'now()');
select pg_temp.default_now('profiles', 'created_at');
select pg_temp.not_null('profiles', 'role');
select pg_temp.not_null('profiles', 'created_at');
select pg_temp.not_null('profiles', 'updated_at');
select pg_temp.relax_legacy('profiles', array['id','email','display_name','role','created_at','updated_at','deactivated_at']);

-- ------------------------------------------------------- subscription_plans ----
select pg_temp.fix_id('subscription_plans');
select pg_temp.add_col('subscription_plans', 'code', 'text');
select pg_temp.add_col('subscription_plans', 'name', 'text');
select pg_temp.add_col('subscription_plans', 'description', 'text');
select pg_temp.add_col('subscription_plans', 'price_cents', 'integer default 0');
select pg_temp.add_col('subscription_plans', 'currency', 'text default ''usd''');
select pg_temp.add_col('subscription_plans', 'max_active_games', 'integer');
select pg_temp.add_col('subscription_plans', 'max_players_per_game', 'integer');
select pg_temp.add_col('subscription_plans', 'max_rounds_per_game', 'integer');
select pg_temp.add_col('subscription_plans', 'is_active', 'boolean default true');
select pg_temp.add_col('subscription_plans', 'created_at', 'timestamptz default now()');
select pg_temp.add_col('subscription_plans', 'updated_at', 'timestamptz default now()');
do $$ begin
  if not pg_temp.has_tbl('subscription_plans') then return; end if;
  -- code: legacy rows without one get a slug from the name (or the id), always matching ^[a-z0-9_-]{2,40}$.
  update public.subscription_plans
     set code = left(coalesce(nullif(regexp_replace(lower(coalesce(name, '')), '[^a-z0-9_-]+', '-', 'g'), ''), 'plan') || '-' || left(id::text, 8), 40)
   where code is null or code !~ '^[a-z0-9_-]{2,40}$';
  update public.subscription_plans set name = initcap(code) where name is null;
  -- Limits: legacy max_players -> players per game; legacy max_games -> games open at once.
  -- Review these in Admin > Plans afterwards; rounds default to 15 (the Party plan's value).
  if pg_temp.has_col('subscription_plans', 'max_players') then
    execute 'update public.subscription_plans set max_players_per_game = least(greatest(coalesce(max_players, 50)::int, 2), 500) where max_players_per_game is null';
  end if;
  if pg_temp.has_col('subscription_plans', 'max_games') then
    execute 'update public.subscription_plans set max_active_games = greatest(coalesce(max_games, 3)::int, 1) where max_active_games is null';
  end if;
  update public.subscription_plans set max_players_per_game = 50 where max_players_per_game is null;
  update public.subscription_plans set max_active_games = 3 where max_active_games is null;
  update public.subscription_plans set max_rounds_per_game = 15 where max_rounds_per_game is null;
  update public.subscription_plans set price_cents = 0 where price_cents is null;   -- no billing yet; legacy "price" is kept as-is
  update public.subscription_plans set currency = 'usd' where currency is null;
  update public.subscription_plans set is_active = true where is_active is null;
end $$;
select pg_temp.fill('subscription_plans', 'created_at', 'now()');
select pg_temp.fill('subscription_plans', 'updated_at', 'now()');
select pg_temp.default_now('subscription_plans', 'created_at');
select pg_temp.uniq('subscription_plans', 'subscription_plans_code_key', 'code');
select pg_temp.not_null('subscription_plans', c) from unnest(array['code','name','price_cents','currency','max_active_games',
  'max_players_per_game','max_rounds_per_game','is_active','created_at','updated_at']) c;
select pg_temp.relax_legacy('subscription_plans', array['id','code','name','description','price_cents','currency','max_active_games',
  'max_players_per_game','max_rounds_per_game','is_active','created_at','updated_at','max_games_per_period']);

-- ------------------------------------------------------------ subscriptions ----
select pg_temp.fix_id('subscriptions');
select pg_temp.add_col('subscriptions', 'status', 'text');
select pg_temp.add_col('subscriptions', 'current_period_start', 'timestamptz default now()');
select pg_temp.add_col('subscriptions', 'current_period_end', 'timestamptz');
select pg_temp.add_col('subscriptions', 'cancel_at_period_end', 'boolean default false');
select pg_temp.add_col('subscriptions', 'external_ref', 'text');
select pg_temp.add_col('subscriptions', 'created_at', 'timestamptz default now()');
select pg_temp.add_col('subscriptions', 'updated_at', 'timestamptz default now()');
do $$ begin
  if not pg_temp.has_tbl('subscriptions') then return; end if;
  if pg_temp.has_col('subscriptions', 'starts_at') then
    execute 'update public.subscriptions set current_period_start = starts_at where starts_at is not null and current_period_start is distinct from starts_at and current_period_end is null';
  end if;
  update public.subscriptions set current_period_start = coalesce(created_at, now()) where current_period_start is null;
  if pg_temp.has_col('subscriptions', 'expires_at') then
    execute 'update public.subscriptions set current_period_end = expires_at where current_period_end is null and expires_at is not null';
  end if;
  -- No legacy end date: treat as already ended (never silently grants access).
  update public.subscriptions set current_period_end = current_period_start + interval '1 second' where current_period_end is null;
  update public.subscriptions set current_period_end = current_period_start + interval '1 second' where current_period_end <= current_period_start;
  update public.subscriptions set cancel_at_period_end = false where cancel_at_period_end is null;
end $$;
select pg_temp.fill('subscriptions', 'status', '''expired''');
select pg_temp.to_enum('subscriptions', 'status', 'subscription_status', 'active');
select pg_temp.fill('subscriptions', 'created_at', 'now()');
select pg_temp.fill('subscriptions', 'updated_at', 'now()');
select pg_temp.default_now('subscriptions', 'created_at');
select pg_temp.uniq('subscriptions', 'subscriptions_external_ref_key', 'external_ref');
select pg_temp.not_null('subscriptions', c) from unnest(array['status','current_period_start','current_period_end',
  'cancel_at_period_end','created_at','updated_at']) c;
select pg_temp.relax_legacy('subscriptions', array['id','user_id','plan_id','status','current_period_start','current_period_end',
  'cancel_at_period_end','external_ref','created_at','updated_at']);

-- -------------------------------------------------------------------- games ----
select pg_temp.fix_id('games');
select pg_temp.add_col('games', 'title', 'text');
select pg_temp.add_col('games', 'join_code', 'text');
select pg_temp.add_col('games', 'status', 'text');
select pg_temp.add_col('games', 'max_players', 'integer default 20');
select pg_temp.add_col('games', 'started_at', 'timestamptz');
select pg_temp.add_col('games', 'finished_at', 'timestamptz');
select pg_temp.add_col('games', 'created_at', 'timestamptz default now()');
select pg_temp.add_col('games', 'updated_at', 'timestamptz default now()');
do $$ declare r record; begin
  if not pg_temp.has_tbl('games') then return; end if;
  -- Reuse the legacy room code when it already has the new format and is unique, otherwise mint one.
  if pg_temp.has_col('games', 'room_code') then
    execute $q$
      update public.games g set join_code = upper(g.room_code::text)
      where g.join_code is null and upper(g.room_code::text) ~ '^[A-Z0-9]{6}$'
        and (select count(*) from public.games x where upper(x.room_code::text) = upper(g.room_code::text)) = 1
        and not exists (select 1 from public.games y where y.join_code = upper(g.room_code::text))$q$;
  end if;
  for r in select id from public.games where join_code is null loop
    update public.games set join_code = public.generate_join_code() where id = r.id;
  end loop;
  update public.games set title = 'Game ' || join_code where title is null or char_length(btrim(title)) = 0;
  update public.games set max_players = least(greatest(coalesce(max_players, 20), 2), 500) where max_players is null or max_players not between 2 and 500;
end $$;
select pg_temp.fill('games', 'status', '''canceled''');
select pg_temp.to_enum('games', 'status', 'game_status', 'draft');
select pg_temp.fill('games', 'created_at', 'now()');
select pg_temp.fill('games', 'updated_at', 'now()');
select pg_temp.default_now('games', 'created_at');
do $$ begin
  if pg_temp.has_col('games', 'join_code') then
    execute 'alter table public.games alter column join_code set default public.generate_join_code()';
  end if;
end $$;
select pg_temp.uniq('games', 'games_join_code_key', 'join_code');
select pg_temp.not_null('games', c) from unnest(array['owner_id','title','join_code','status','max_players','created_at','updated_at']) c;
select pg_temp.relax_legacy('games', array['id','owner_id','title','join_code','status','max_players','started_at','finished_at',
  'created_at','updated_at','phase','state_version','current_round_id','countdown_ends_at','phase_changed_at','winner_player_id','archived_at']);

-- -------------------------------------------------------------- game_rounds ----
select pg_temp.fix_id('game_rounds');
select pg_temp.add_col('game_rounds', 'round_no', 'integer');
select pg_temp.add_col('game_rounds', 'prompt', 'text');
select pg_temp.add_col('game_rounds', 'time_limit_seconds', 'integer default 60');
select pg_temp.add_col('game_rounds', 'points', 'integer default 100');
select pg_temp.add_col('game_rounds', 'status', 'text');
select pg_temp.add_col('game_rounds', 'opened_at', 'timestamptz');
select pg_temp.add_col('game_rounds', 'closed_at', 'timestamptz');
select pg_temp.add_col('game_rounds', 'created_at', 'timestamptz default now()');
select pg_temp.add_col('game_rounds', 'updated_at', 'timestamptz default now()');
do $$ begin
  if not pg_temp.has_tbl('game_rounds') then return; end if;
  if pg_temp.has_col('game_rounds', 'round_number') then
    execute 'update public.game_rounds set round_no = round_number::int where round_no is null and round_number::int >= 1';
  end if;
  -- Anything still missing: number after the highest existing round of that game, in id order.
  update public.game_rounds r set round_no = n.no
    from (select id, coalesce((select max(round_no) from public.game_rounds m where m.game_id = x.game_id), 0)
                     + row_number() over (partition by game_id order by id) as no
          from public.game_rounds x where round_no is null) n
   where r.id = n.id;
  if pg_temp.has_col('game_rounds', 'item_name') then
    execute 'update public.game_rounds set prompt = left(btrim(item_name::text), 200) where prompt is null and char_length(btrim(coalesce(item_name::text, ''''))) > 0';
  end if;
  update public.game_rounds set prompt = 'Item ' || round_no where prompt is null;
  update public.game_rounds set time_limit_seconds = 60 where time_limit_seconds is null;
  update public.game_rounds set points = 100 where points is null;
end $$;
select pg_temp.fill('game_rounds', 'status', '''closed''');
select pg_temp.to_enum('game_rounds', 'status', 'round_status', 'pending');
select pg_temp.fill('game_rounds', 'created_at', 'now()');
select pg_temp.fill('game_rounds', 'updated_at', 'now()');
select pg_temp.uniq('game_rounds', 'game_rounds_game_id_round_no_key', 'game_id, round_no');
select pg_temp.uniq('game_rounds', 'game_rounds_id_game_id_key', 'id, game_id');   -- composite FK target (migrations 1, 10)
select pg_temp.not_null('game_rounds', c) from unnest(array['game_id','round_no','prompt','time_limit_seconds','points','status','created_at','updated_at']) c;
select pg_temp.relax_legacy('game_rounds', array['id','game_id','round_no','prompt','time_limit_seconds','points','status','opened_at',
  'closed_at','created_at','updated_at','winner_submission_id','winner_rank_ms','winner_confirmed_at']);

-- ------------------------------------------------------------------ players ----
select pg_temp.fix_id('players');
select pg_temp.add_col('players', 'nickname', 'text');
select pg_temp.add_col('players', 'token_hash', 'text');
select pg_temp.add_col('players', 'joined_at', 'timestamptz default now()');
select pg_temp.add_col('players', 'last_seen_at', 'timestamptz default now()');
select pg_temp.add_col('players', 'kicked_at', 'timestamptz');
do $$ begin
  if not pg_temp.has_tbl('players') then return; end if;
  if pg_temp.has_col('players', 'display_name') then
    execute 'update public.players set nickname = left(btrim(display_name::text), 24) where nickname is null and char_length(btrim(coalesce(display_name::text, ''''))) > 0';
  end if;
  if pg_temp.has_col('players', 'name') then
    execute 'update public.players set nickname = left(btrim(name::text), 24) where nickname is null and char_length(btrim(coalesce(name::text, ''''))) > 0';
  end if;
  update public.players set nickname = 'Player ' || left(id::text, 4) where nickname is null;
  -- Legacy players have no session token: give them an unguessable hash nobody holds.
  -- (Their old sessions can't be resumed under the new cookie scheme anyway.)
  update public.players set token_hash = encode(sha256(convert_to(gen_random_uuid()::text || clock_timestamp()::text, 'utf8')), 'hex')
   where token_hash is null;
end $$;
select pg_temp.fill('players', 'joined_at', 'now()');
select pg_temp.fill('players', 'last_seen_at', 'coalesce(joined_at, now())');
select pg_temp.default_now('players', 'joined_at');
select pg_temp.uniq('players', 'players_token_hash_key', 'token_hash');
select pg_temp.uniq('players', 'players_id_game_id_key', 'id, game_id');   -- composite FK target
select pg_temp.not_null('players', c) from unnest(array['game_id','nickname','token_hash','joined_at','last_seen_at']) c;
select pg_temp.relax_legacy('players', array['id','game_id','nickname','token_hash','joined_at','last_seen_at','kicked_at']);

-- -------------------------------------------------------------- submissions ----
select pg_temp.fix_id('submissions');
select pg_temp.add_col('submissions', 'storage_path', 'text');         -- legacy rows keep NULL (no photo path to reconstruct)
select pg_temp.add_col('submissions', 'status', 'text');
select pg_temp.add_col('submissions', 'points_awarded', 'integer default 0');
select pg_temp.add_col('submissions', 'submitted_at', 'timestamptz default now()');
select pg_temp.add_col('submissions', 'reviewed_at', 'timestamptz');
do $$ begin
  if not pg_temp.has_tbl('submissions') then return; end if;
  if pg_temp.has_col('submissions', 'created_at') then
    execute 'update public.submissions set submitted_at = created_at where submitted_at is null';
  end if;
  update public.submissions set points_awarded = 0 where points_awarded is null;
end $$;
select pg_temp.fill('submissions', 'submitted_at', 'now()');
select pg_temp.fill('submissions', 'status', '''pending''');
select pg_temp.to_enum('submissions', 'status', 'submission_status', 'pending');
select pg_temp.uniq('submissions', 'submissions_round_id_player_id_key', 'round_id, player_id');
select pg_temp.not_null('submissions', c) from unnest(array['game_id','round_id','player_id','status','points_awarded','submitted_at']) c;
do $$ begin
  if not pg_temp.has_tbl('submissions') then return; end if;
  -- Same-game guarantees from migration 1. NOT VALID: enforced for every new/updated row,
  -- legacy rows are not re-checked (nothing is deleted). Validate later with
  --   alter table public.submissions validate constraint <name>;
  if not exists (select 1 from pg_constraint where conname = 'submissions_round_game_fkey') then
    alter table public.submissions add constraint submissions_round_game_fkey
      foreign key (round_id, game_id) references public.game_rounds (id, game_id) on delete cascade not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'submissions_player_game_fkey') then
    alter table public.submissions add constraint submissions_player_game_fkey
      foreign key (player_id, game_id) references public.players (id, game_id) on delete cascade not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'submissions_storage_path_check') then
    alter table public.submissions add constraint submissions_storage_path_check check (
      storage_path ~ ('^' || game_id::text || '/' || round_id::text || '/' || player_id::text || '\.(jpg|png|webp)$')) not valid;
  end if;
end $$;
select pg_temp.relax_legacy('submissions', array['id','game_id','round_id','player_id','storage_path','status','points_awarded',
  'submitted_at','reviewed_at','attempt_id','intent_at','claimed_elapsed_ms','server_elapsed_ms','received_elapsed_ms',
  'rank_ms','timing_status','timing_flags','client_meta']);
