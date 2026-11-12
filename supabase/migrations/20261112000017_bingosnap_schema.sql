-- BingoSnap (Extra Fun) 1/2: schema, RLS and isolation guards. Additive only.
-- Design: BINGOSNAP_DESIGN.md. Revert (not a migration): supabase/rollback/20261112000017_18_bingosnap_revert.sql
--
-- A BingoSnap game IS a public.games row (game_type = 'bingosnap'), so it inherits
-- without any change: host ownership + RLS, the Game Pass check, the per-plan open-game
-- and per-period limits, the room's player cap (enforce_player_insert locks the game row),
-- the join code / QR / guest cookie, Realtime broadcast and archiving.
-- Participants ARE public.players rows (same join_game, same capacity trigger).
--
-- PHOTOS ARE NEVER STORED. No table here has a column for an image, URL, path, thumbnail,
-- hash, size or EXIF. Only cell ids, timestamps and review results are kept.
--
-- Existing Bring Me behaviour is unchanged: existing rows get game_type 'bring_me' and no
-- existing function or trigger is redefined. New triggers only refuse Bring Me code paths
-- (rounds, photo intents, photo submissions, game_transition) for BingoSnap games.

do $$ begin
  create type public.game_type as enum ('bring_me', 'bingosnap');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.bingo_win_mode as enum ('traditional', 'full_card');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.bingo_winner_rule as enum ('ranked', 'first');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.bingo_submission_status as enum ('pending', 'verified', 'rejected');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------- game type ----
-- No client column grant: hosts can't choose or change it (only create_bingosnap_game sets it).
alter table public.games add column if not exists game_type public.game_type not null default 'bring_me';
create index if not exists games_bingosnap_idx on public.games (owner_id) where game_type = 'bingosnap';

create or replace function public.guard_game_type_immutable()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.game_type is distinct from old.game_type then
    raise exception 'immutable game column' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists guard_game_type_immutable on public.games;
create trigger guard_game_type_immutable before update of game_type on public.games
  for each row execute function public.guard_game_type_immutable();

-- A BingoSnap game's status/phase may change only inside the BingoSnap engine
-- (bingo_transition / create_bingosnap_game set a transaction-local flag).
-- So game_transition() and any other path cannot drive a BingoSnap game.
create or replace function public.guard_bingosnap_game_state()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.game_type = 'bingosnap'
     and (new.status is distinct from old.status or new.phase is distinct from old.phase)
     and coalesce(current_setting('bingosnap.engine', true), '') <> 'on' then
    raise exception 'wrong_game_type' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists guard_bingosnap_game_state on public.games;
create trigger guard_bingosnap_game_state before update of status, phase on public.games
  for each row execute function public.guard_bingosnap_game_state();

-- Bring Me rows (rounds, photo intents, photo submissions) can never attach to a BingoSnap game.
create or replace function public.guard_bring_me_only()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.games g where g.id = new.game_id and g.game_type = 'bingosnap') then
    raise exception 'wrong_game_type' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists guard_bring_me_only on public.game_rounds;
create trigger guard_bring_me_only before insert on public.game_rounds
  for each row execute function public.guard_bring_me_only();
drop trigger if exists guard_bring_me_only on public.submission_intents;
create trigger guard_bring_me_only before insert on public.submission_intents
  for each row execute function public.guard_bring_me_only();
drop trigger if exists guard_bring_me_only on public.submissions;
create trigger guard_bring_me_only before insert on public.submissions
  for each row execute function public.guard_bring_me_only();

-- -------------------------------------------------------------- bingo_games ----
-- Board settings + authoritative timer (database clock). Title, owner, status,
-- created/updated, join code and capacity live on public.games.
create table if not exists public.bingo_games (
  game_id          uuid primary key references public.games (id) on delete cascade,
  board_size       smallint not null check (board_size in (3, 4, 5)),
  win_mode         public.bingo_win_mode not null,
  free_space       boolean not null default false,
  winner_rule      public.bingo_winner_rule not null default 'ranked',
  duration_seconds integer not null check (duration_seconds between 180 and 7200),
  -- seeds each participant's own order of the challenges (never sent to clients)
  layout_seed      uuid not null default gen_random_uuid(),
  hunt_started_at  timestamptz,
  hunt_ends_at     timestamptz,
  results_at       timestamptz,   -- results frozen (announced or game ended)
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- free centre: only odd boards, only Traditional Bingo
  constraint bingo_free_space_rule check (not free_space or (board_size in (3, 5) and win_mode = 'traditional')),
  constraint bingo_timer_shape check (
    (hunt_started_at is null and hunt_ends_at is null) or
    (hunt_started_at is not null and hunt_ends_at is not null and hunt_ends_at >= hunt_started_at))
);

-- -------------------------------------------------------------- bingo_cells ----
-- The host's board, row-major. Participants see the same challenges in their own order.
create table if not exists public.bingo_cells (
  id             uuid primary key default gen_random_uuid(),
  game_id        uuid not null references public.bingo_games (game_id) on delete cascade,
  row_no         smallint not null check (row_no between 0 and 4),
  col_no         smallint not null check (col_no between 0 and 4),
  display_order  smallint not null check (display_order between 0 and 24),
  challenge      text check (challenge is null or (char_length(challenge) between 1 and 120 and challenge = btrim(challenge))),
  is_free        boolean not null default false,
  created_at     timestamptz not null default now(),
  constraint bingo_cell_free_has_no_challenge check (is_free = (challenge is null)),
  unique (game_id, row_no, col_no),
  unique (game_id, display_order),
  unique (id, game_id)
);
create index if not exists bingo_cells_game_idx on public.bingo_cells (game_id);
create unique index if not exists bingo_cells_one_free on public.bingo_cells (game_id) where is_free;

-- -------------------------------------------------------- bingo_submissions ----
-- One row per claim attempt (history kept). No photo data of any kind.
create table if not exists public.bingo_submissions (
  id                uuid primary key default gen_random_uuid(),
  game_id           uuid not null references public.bingo_games (game_id) on delete cascade,
  player_id         uuid not null,
  attempt_no        smallint not null check (attempt_no between 1 and 5),
  cell_ids          uuid[] not null check (cardinality(cell_ids) between 2 and 25),
  pattern           text not null check (pattern ~ '^(row:[0-4]|col:[0-4]|diag:(main|anti)|full)$'),
  status            public.bingo_submission_status not null default 'pending',
  submitted_at      timestamptz not null default clock_timestamp(),
  validated_at      timestamptz,
  validated_by      uuid references public.profiles (id) on delete set null,
  rejection_reason  text check (rejection_reason is null or char_length(rejection_reason) between 1 and 120),
  constraint bingo_submission_player_fk foreign key (player_id, game_id)
    references public.players (id, game_id) on delete cascade,
  constraint bingo_submission_review_shape check (
    (status = 'pending' and validated_at is null and rejection_reason is null) or
    (status = 'verified' and validated_at is not null and rejection_reason is null) or
    (status = 'rejected' and validated_at is not null)),
  unique (player_id, attempt_no)
);
create index if not exists bingo_submissions_game_idx on public.bingo_submissions (game_id, submitted_at);
-- at most ONE live claim per participant (pending or verified)
create unique index if not exists bingo_submissions_one_open
  on public.bingo_submissions (player_id) where status in ('pending', 'verified');

-- ------------------------------------------------------------- updated_at ----
create or replace function public.bingo_touch()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists bingo_games_touch on public.bingo_games;
create trigger bingo_games_touch before update on public.bingo_games
  for each row execute function public.bingo_touch();

-- ---------------------------------------------------------- RLS + grants ----
-- Clients never write these tables: every write is a SECURITY DEFINER function.
-- Hosts (and Super Admins) may read their own games' rows; guests have no table access.
alter table public.bingo_games enable row level security;
alter table public.bingo_cells enable row level security;
alter table public.bingo_submissions enable row level security;

revoke all on public.bingo_games, public.bingo_cells, public.bingo_submissions from public, anon, authenticated;
grant select on public.bingo_games, public.bingo_cells, public.bingo_submissions to authenticated;
grant all on public.bingo_games, public.bingo_cells, public.bingo_submissions to service_role;

drop policy if exists bingo_games_select_own on public.bingo_games;
create policy bingo_games_select_own on public.bingo_games for select to authenticated
  using (public.owns_game(game_id) or (select public.is_super_admin()));
drop policy if exists bingo_cells_select_own on public.bingo_cells;
create policy bingo_cells_select_own on public.bingo_cells for select to authenticated
  using (public.owns_game(game_id) or (select public.is_super_admin()));
drop policy if exists bingo_submissions_select_own on public.bingo_submissions;
create policy bingo_submissions_select_own on public.bingo_submissions for select to authenticated
  using (public.owns_game(game_id) or (select public.is_super_admin()));

revoke all on function
  public.guard_game_type_immutable(), public.guard_bingosnap_game_state(),
  public.guard_bring_me_only(), public.bingo_touch()
  from public, anon, authenticated;
