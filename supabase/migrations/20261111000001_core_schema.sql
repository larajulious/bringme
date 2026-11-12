-- BringMe! Phase 2 / migration 1 of 3: core schema.
-- Safe to apply on a project that has none of these objects. Every statement is
-- guarded (IF NOT EXISTS / DO blocks) so a re-run never drops or rewrites data.
-- Security (RLS, grants, entitlement triggers) lives in migration 2.

-- ---------------------------------------------------------------- enums ----
do $$ begin
  create type public.user_role as enum ('super_admin', 'subscriber');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.subscription_status as enum ('trialing', 'active', 'past_due', 'canceled', 'expired');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.game_status as enum ('draft', 'lobby', 'live', 'finished', 'canceled');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.round_status as enum ('pending', 'open', 'closed');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.submission_status as enum ('pending', 'approved', 'rejected');
exception when duplicate_object then null; end $$;

-- ------------------------------------------------------------ utilities ----
create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- 6-char join code from a CSPRNG (gen_random_uuid), ambiguous characters removed.
-- SECURITY DEFINER: it is a column DEFAULT (runs as the inserting role) and its
-- uniqueness probe must see ALL games, not just the caller's rows under RLS.
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

-- ------------------------------------------------------------- profiles ----
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  email        text,
  display_name text check (display_name is null or char_length(display_name) between 1 and 60),
  role         public.user_role not null default 'subscriber',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists profiles_super_admin_idx on public.profiles (id) where role = 'super_admin';

-- ----------------------------------------------------- subscription_plans ----
create table if not exists public.subscription_plans (
  id                    uuid primary key default gen_random_uuid(),
  code                  text not null unique check (code ~ '^[a-z0-9_-]{2,40}$'),
  name                  text not null check (char_length(name) between 1 and 80),
  description           text,
  price_cents           integer not null default 0 check (price_cents >= 0),
  currency              text not null default 'usd' check (currency ~ '^[a-z]{3}$'),
  max_active_games      integer not null check (max_active_games > 0),
  max_players_per_game  integer not null check (max_players_per_game between 2 and 500),
  max_rounds_per_game   integer not null check (max_rounds_per_game > 0),
  is_active             boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- ------------------------------------------------------- subscriptions ----
create table if not exists public.subscriptions (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references public.profiles (id) on delete cascade,
  plan_id               uuid not null references public.subscription_plans (id),
  status                public.subscription_status not null default 'active',
  current_period_start  timestamptz not null default now(),
  current_period_end    timestamptz not null,
  cancel_at_period_end  boolean not null default false,
  external_ref          text unique,  -- reserved for the future billing provider
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  check (current_period_end > current_period_start)
);
create index if not exists subscriptions_user_idx on public.subscriptions (user_id);
create index if not exists subscriptions_plan_idx on public.subscriptions (plan_id);
-- At most one entitling subscription per user.
create unique index if not exists subscriptions_one_live_per_user
  on public.subscriptions (user_id) where status in ('trialing', 'active', 'past_due');

-- ---------------------------------------------------------------- games ----
create table if not exists public.games (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references public.profiles (id) on delete cascade,
  title        text not null check (char_length(btrim(title)) between 1 and 80),
  join_code    text not null unique default public.generate_join_code()
               check (join_code ~ '^[A-Z0-9]{6}$'),
  status       public.game_status not null default 'draft',
  max_players  integer not null default 20 check (max_players between 2 and 500),
  started_at   timestamptz,
  finished_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists games_owner_idx on public.games (owner_id);
create index if not exists games_status_idx on public.games (status) where status in ('lobby', 'live');

-- ---------------------------------------------------------- game_rounds ----
create table if not exists public.game_rounds (
  id                  uuid primary key default gen_random_uuid(),
  game_id             uuid not null references public.games (id) on delete cascade,
  round_no            integer not null check (round_no >= 1),
  prompt              text not null check (char_length(btrim(prompt)) between 1 and 200),
  time_limit_seconds  integer not null default 60 check (time_limit_seconds between 10 and 600),
  points              integer not null default 100 check (points between 0 and 10000),
  status              public.round_status not null default 'pending',
  opened_at           timestamptz,
  closed_at           timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (game_id, round_no),
  unique (id, game_id)  -- target for composite FKs from submissions
);
create index if not exists game_rounds_game_idx on public.game_rounds (game_id);
create unique index if not exists game_rounds_one_open_per_game
  on public.game_rounds (game_id) where status = 'open';

-- --------------------------------------------------------------- players ----
-- Guests never have a Supabase Auth account. Identity = random token held in an
-- httpOnly cookie; only its SHA-256 hash is stored here.
create table if not exists public.players (
  id            uuid primary key default gen_random_uuid(),
  game_id       uuid not null references public.games (id) on delete cascade,
  nickname      text not null check (char_length(nickname) between 1 and 24 and nickname = btrim(nickname)),
  token_hash    text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  joined_at     timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  kicked_at     timestamptz,
  unique (id, game_id)  -- target for composite FKs from submissions
);
create index if not exists players_game_idx on public.players (game_id);
create unique index if not exists players_nickname_per_game on public.players (game_id, lower(nickname));

-- ----------------------------------------------------------- submissions ----
create table if not exists public.submissions (
  id              uuid primary key default gen_random_uuid(),
  game_id         uuid not null,
  round_id        uuid not null,
  player_id       uuid not null,
  storage_path    text not null,
  status          public.submission_status not null default 'pending',
  points_awarded  integer not null default 0 check (points_awarded >= 0),
  submitted_at    timestamptz not null default now(),
  reviewed_at     timestamptz,
  -- Composite FKs: the round and the player must belong to the SAME game,
  -- so a submission can never cross game boundaries.
  foreign key (round_id, game_id)  references public.game_rounds (id, game_id) on delete cascade,
  foreign key (player_id, game_id) references public.players (id, game_id)     on delete cascade,
  -- One submission per player per round (duplicate / replay protection).
  unique (round_id, player_id),
  -- Path is fully determined by the row: <game>/<round>/<player>.<ext>
  check (storage_path ~ ('^' || game_id::text || '/' || round_id::text || '/' || player_id::text || '\.(jpg|png|webp)$'))
);
create index if not exists submissions_game_idx on public.submissions (game_id);
create index if not exists submissions_player_idx on public.submissions (player_id);

-- ------------------------------------------------------ updated_at hooks ----
do $$
declare t text;
begin
  foreach t in array array['subscription_plans','subscriptions','games','game_rounds'] loop
    execute format('drop trigger if exists set_updated_at on public.%I', t);
    execute format('create trigger set_updated_at before update on public.%I
                    for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- ------------------------------------------------------ profile creation ----
-- Every new auth user gets a profile with the fixed role 'subscriber'.
-- raw_user_meta_data (client-controlled) is NEVER used for the role.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    nullif(left(btrim(coalesce(new.raw_user_meta_data ->> 'display_name', '')), 60), '')
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill profiles for users created before this migration (no data is changed).
insert into public.profiles (id, email)
select u.id, u.email from auth.users u
on conflict (id) do nothing;

-- ---------------------------------------------------------- plan seeding ----
-- Placeholder limits and price 0: adjust when billing is integrated.
insert into public.subscription_plans
  (code, name, description, price_cents, max_active_games, max_players_per_game, max_rounds_per_game)
values
  ('starter', 'Starter', 'Small get-togethers',  0,  1,  10,  5),
  ('party',   'Party',   'Regular game nights',  0,  3,  50, 15),
  ('pro',     'Pro',     'Events and communities', 0, 10, 200, 40)
on conflict (code) do nothing;
