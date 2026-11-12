-- BringMe! Phase 7: authoritative real-time game engine.
--
-- Source of truth = PostgreSQL. A game has
--   status (lifecycle, Phase 2): draft | lobby | live | finished | canceled
--   phase  (engine, this phase):  lobby | countdown | active | reviewing | winner_announced | finished
--   state_version: a monotonic revision bumped on EVERY visible change (phase, round,
--                  player joins/removals). Clients only ever apply a newer version.
-- Clients (even the host) can no longer write status/phase: only game_transition() can.

do $$ begin
  create type public.game_phase as enum ('lobby', 'countdown', 'active', 'reviewing', 'winner_announced', 'finished');
exception when duplicate_object then null; end $$;

alter table public.games
  add column if not exists phase public.game_phase not null default 'lobby',
  add column if not exists state_version bigint not null default 0,
  add column if not exists current_round_id uuid references public.game_rounds (id) on delete set null,
  add column if not exists countdown_ends_at timestamptz,
  add column if not exists phase_changed_at timestamptz not null default now();
alter table public.game_rounds
  add column if not exists winner_player_id uuid references public.players (id) on delete set null;

-- Backfill for databases that already hold games. The Phase 2 guard rejects ANY
-- update of a finished/cancelled game (game_is_closed), so pause it for this one
-- statement only (a no-op on an empty table; same transaction as the migration).
alter table public.games disable trigger enforce_game_update;
update public.games set phase = 'finished' where status in ('finished', 'canceled') and phase <> 'finished';
alter table public.games enable trigger enforce_game_update;
alter table public.games drop constraint if exists games_status_phase_check;
alter table public.games add constraint games_status_phase_check check (
  (status in ('draft', 'lobby') and phase = 'lobby') or
  (status = 'live' and phase in ('lobby', 'countdown', 'active', 'reviewing', 'winner_announced')) or
  (status in ('finished', 'canceled') and phase = 'finished')
);

-- ---------------------------------------------------------------- grants ----
-- The state machine is the only way to change status/phase.
revoke update (status) on public.games from authenticated;
revoke update (status) on public.game_rounds from authenticated;

-- ------------------------------------------------------------ broadcasting ----
-- Transient "something changed" ping on a PRIVATE Realtime channel. Payload has
-- only the version/phase (no prompt, no player data); clients always re-read the
-- authoritative state. A broadcast failure must never fail a transition.
create or replace function public.broadcast_game(p_game uuid, p_version bigint, p_phase public.game_phase)
returns void language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform realtime.send(
      jsonb_build_object('version', p_version, 'phase', p_phase),
      'state', 'game:' || p_game::text, true);
  exception when others then
    null; -- database state stays authoritative; clients resync on their own
  end;
end $$;

-- Bump the visible-state revision (no-op for closed games) and notify.
create or replace function public.bump_game_version(p_game uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_ver bigint;
  v_phase public.game_phase;
begin
  update public.games
     set state_version = state_version + 1, phase_changed_at = clock_timestamp()
   where id = p_game and status not in ('finished', 'canceled')
   returning state_version, phase into v_ver, v_phase;
  if v_ver is not null then
    perform public.broadcast_game(p_game, v_ver, v_phase);
  end if;
end $$;

create or replace function public.players_bump_version()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.bump_game_version(new.game_id);
  return null;
end $$;

drop trigger if exists players_bump_version_ins on public.players;
create trigger players_bump_version_ins after insert on public.players
  for each row execute function public.players_bump_version();
drop trigger if exists players_bump_version_upd on public.players;
create trigger players_bump_version_upd after update of kicked_at on public.players
  for each row when (old.kicked_at is distinct from new.kicked_at)
  execute function public.players_bump_version();

-- ------------------------------------------------------ updated game trigger ----
-- Phase 2 trigger + engine bookkeeping (phase follows status; version never skipped).
create or replace function public.enforce_game_update()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_ent record;
begin
  if new.id <> old.id or new.owner_id <> old.owner_id
     or new.join_code <> old.join_code or new.created_at <> old.created_at then
    raise exception 'immutable game column' using errcode = '42501';
  end if;

  if new.status is distinct from old.status then
    if not (
      (old.status = 'draft' and new.status in ('lobby', 'canceled')) or
      (old.status = 'lobby' and new.status in ('live', 'canceled')) or
      (old.status = 'live'  and new.status in ('finished', 'canceled'))
    ) then
      raise exception 'invalid_game_transition' using errcode = 'P0001';
    end if;
    if new.status in ('lobby', 'live') and not public.is_admin_user(old.owner_id) then
      if not exists (select 1 from public.entitlement_for(old.owner_id)) then
        raise exception 'subscription_required' using errcode = 'P0001';
      end if;
    end if;
    if new.status = 'live' then new.started_at := now(); end if;
    if new.status in ('finished', 'canceled') then
      new.finished_at := now();
      new.phase := 'finished';
      new.current_round_id := null;
      new.countdown_ends_at := null;
    end if;
    if new.state_version = old.state_version then
      new.state_version := old.state_version + 1;
      new.phase_changed_at := clock_timestamp();
    end if;
  elsif old.status in ('finished', 'canceled') then
    raise exception 'game_is_closed' using errcode = 'P0001';
  end if;

  if new.max_players is distinct from old.max_players and not public.is_admin_user(old.owner_id) then
    select * into v_ent from public.entitlement_for(old.owner_id);
    if v_ent is null then
      raise exception 'subscription_required' using errcode = 'P0001';
    end if;
    new.max_players := least(new.max_players, v_ent.max_players_per_game);
  end if;
  return new;
end $$;

-- ---------------------------------------- joining only before the game starts ----
create or replace function public.enforce_player_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_game record;
  v_count integer;
begin
  select * into v_game from public.games where id = new.game_id for update;
  if v_game is null or v_game.status <> 'lobby' then
    raise exception 'game_not_joinable' using errcode = 'P0001';
  end if;
  select count(*) into v_count from public.players where game_id = new.game_id and kicked_at is null;
  if v_count >= v_game.max_players then
    raise exception 'game_full' using errcode = 'P0001';
  end if;
  new.kicked_at := null;
  return new;
end $$;

create or replace function public.join_game(
  p_code text, p_nickname text, p_token_hash text, p_existing_hash text default null
) returns table (player_id uuid, nickname text, game_id uuid, restored boolean)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_game record;
  v_player record;
  v_id uuid;
begin
  select g.id as gid, g.status as gstatus into v_game
    from public.games g where g.join_code = upper(p_code);
  if not found then
    raise exception 'game_not_found' using errcode = 'P0001';
  end if;

  if p_existing_hash is not null then
    select p.id as pid, p.nickname as pname, p.kicked_at as kicked into v_player
      from public.players p
      where p.game_id = v_game.gid and p.token_hash = p_existing_hash;
    if found then
      if v_player.kicked is not null then
        raise exception 'player_removed' using errcode = 'P0001';
      end if;
      update public.players set last_seen_at = now() where id = v_player.pid;
      return query select v_player.pid, v_player.pname, v_game.gid, true;
      return;
    end if;
  end if;

  -- New players may only enter while the lobby is open (before Start Game).
  if v_game.gstatus <> 'lobby' then
    raise exception 'game_not_joinable' using errcode = 'P0001';
  end if;

  insert into public.players (game_id, nickname, token_hash)
  values (v_game.gid, p_nickname, p_token_hash)
  returning id into v_id;

  return query select v_id, p_nickname, v_game.gid, false;
end $$;

-- Submissions: not before the official round start, in addition to the time limit.
create or replace function public.enforce_submission_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_round record;
  v_game_status public.game_status;
  v_kicked timestamptz;
begin
  select * into v_round from public.game_rounds where id = new.round_id and game_id = new.game_id;
  select status into v_game_status from public.games where id = new.game_id;
  select kicked_at into v_kicked from public.players where id = new.player_id and game_id = new.game_id;

  if v_game_status is distinct from 'live' then
    raise exception 'game_not_live' using errcode = 'P0001';
  end if;
  if v_kicked is not null then
    raise exception 'player_kicked' using errcode = 'P0001';
  end if;
  if v_round.status is distinct from 'open' then
    raise exception 'round_not_open' using errcode = 'P0001';
  end if;
  if clock_timestamp() < v_round.opened_at then
    raise exception 'round_not_started' using errcode = 'P0001';
  end if;
  if now() > v_round.opened_at + make_interval(secs => v_round.time_limit_seconds + 5) then
    raise exception 'round_closed' using errcode = 'P0001';
  end if;
  new.status := 'pending'; new.points_awarded := 0; new.reviewed_at := null; new.submitted_at := now();
  return new;
end $$;

-- create_game_with_rounds can no longer rely on a client UPDATE of status, so it
-- runs as definer. Owner is still ONLY auth.uid(); entitlement/plan-limit
-- triggers apply to its inserts exactly as before.
create or replace function public.create_game_with_rounds(p_title text, p_items text[])
returns table (game_id uuid, code text)
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_code text;
  v_n integer := coalesce(array_length(p_items, 1), 0);
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  if v_n < 1 then
    raise exception 'items_required' using errcode = 'P0001';
  end if;
  if exists (select 1 from unnest(p_items) i where i is null or btrim(i) = '') then
    raise exception 'empty_item' using errcode = 'P0001';
  end if;

  insert into public.games (owner_id, title)
  values (auth.uid(), coalesce(nullif(btrim(p_title), ''), 'Untitled game'))
  returning public.games.id, public.games.join_code into v_id, v_code;

  insert into public.game_rounds (game_id, round_no, prompt)
  select v_id, t.ord::integer, btrim(t.item)
  from unnest(p_items) with ordinality as t(item, ord);

  update public.games set status = 'lobby' where id = v_id;

  return query select v_id, v_code;
end $$;

-- ------------------------------------------------------------ state snapshots ----
-- One builder for every viewer. Players never receive the round's item before
-- its official start time (opened_at), even if they ask early.
create or replace function public.game_state_json(p_game uuid, p_viewer text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  g public.games%rowtype;
  r public.game_rounds%rowtype;
begin
  select * into g from public.games where id = p_game;
  if not found then return null; end if;
  if g.current_round_id is not null then
    select * into r from public.game_rounds where id = g.current_round_id;
  end if;
  return jsonb_build_object(
    'version', g.state_version,
    'status', g.status,
    'phase', g.phase,
    'title', g.title,
    'serverNow', clock_timestamp(),
    'countdownEndsAt', g.countdown_ends_at,
    'totalRounds', (select count(*) from public.game_rounds where game_id = g.id),
    'roundsRemaining', (select count(*) from public.game_rounds
                         where game_id = g.id and status = 'pending' and id is distinct from g.current_round_id),
    'playerCount', (select count(*) from public.players where game_id = g.id and kicked_at is null),
    'maxPlayers', g.max_players,
    'round', case when r.id is null then null else jsonb_build_object(
      'no', r.round_no,
      'status', r.status,
      'openedAt', r.opened_at,
      'closedAt', r.closed_at,
      'timeLimitSeconds', r.time_limit_seconds,
      'prompt', case when p_viewer = 'host' or (r.opened_at is not null and r.opened_at <= clock_timestamp())
                     then r.prompt end,
      'winnerPlayerId', r.winner_player_id,
      'winnerName', (select nickname from public.players where id = r.winner_player_id)
    ) end
  );
end $$;

create or replace function public.host_game_state(p_game uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.games where id = p_game and owner_id = auth.uid()) then
    raise exception 'game_not_found' using errcode = 'P0001';
  end if;
  return public.game_state_json(p_game, 'host');
end $$;

create or replace function public.player_game_state(p_token_hash text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  p public.players%rowtype;
  g public.games%rowtype;
  v jsonb;
begin
  select * into p from public.players where token_hash = p_token_hash;
  if not found then return null; end if;
  select * into g from public.games where id = p.game_id;
  v := public.game_state_json(g.id, 'player');
  return v || jsonb_build_object(
    'gameId', g.id,
    'joinCode', g.join_code,
    'me', jsonb_build_object(
      'id', p.id,
      'nickname', p.nickname,
      'kicked', p.kicked_at is not null,
      'hasSubmitted', exists (select 1 from public.submissions s
                               where s.player_id = p.id and s.round_id = g.current_round_id),
      'isWinner', exists (select 1 from public.game_rounds r
                           where r.id = g.current_round_id and r.winner_player_id = p.id)
    )
  );
end $$;

drop function if exists public.player_lobby_state(text);

-- ----------------------------------------------------------- state machine ----
-- The ONLY way a Game Master changes game/round state. Concurrency control:
--  1. SELECT ... FOR UPDATE serialises simultaneous requests for one game.
--  2. p_expected_version (optimistic check) rejects any request that was made
--     against an older state: a double click, a second tab, a replayed request.
--  3. The transition table below rejects anything not valid from the current state.
--  4. A partial unique index allows only one 'open' round per game.
create or replace function public.game_transition(
  p_game uuid, p_action text, p_expected_version bigint, p_winner uuid default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  g public.games%rowtype;
  r public.game_rounds%rowtype;
  v_ver bigint;
  v_phase public.game_phase;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  if p_action not in ('start_game', 'start_countdown', 'start_round', 'close_submissions',
                      'move_to_review', 'announce_winner', 'next_round', 'end_game', 'cancel') then
    raise exception 'invalid_action' using errcode = 'P0001';
  end if;

  -- Not the owner and not existing look identical (no information leak).
  select * into g from public.games where id = p_game and owner_id = auth.uid() for update;
  if not found then
    raise exception 'game_not_found' using errcode = 'P0001';
  end if;
  if g.state_version <> p_expected_version then
    raise exception 'stale_state' using errcode = 'P0001';
  end if;

  if g.current_round_id is not null then
    select * into r from public.game_rounds where id = g.current_round_id for update;
  end if;

  if p_action = 'start_game' then
    if g.status <> 'lobby' then raise exception 'invalid_transition' using errcode = 'P0001'; end if;
    if not exists (select 1 from public.players where game_id = g.id and kicked_at is null) then
      raise exception 'no_players' using errcode = 'P0001';
    end if;
    if not exists (select 1 from public.game_rounds where game_id = g.id and status = 'pending') then
      raise exception 'no_rounds_left' using errcode = 'P0001';
    end if;
    update public.games set status = 'live' where id = g.id;  -- entitlement checked by trigger

  elsif p_action = 'start_countdown' then
    if g.status <> 'live' or g.phase <> 'lobby' then
      raise exception 'invalid_transition' using errcode = 'P0001';
    end if;
    if not public.is_admin_user(g.owner_id)
       and not exists (select 1 from public.entitlement_for(g.owner_id)) then
      raise exception 'subscription_required' using errcode = 'P0001';
    end if;
    select * into r from public.game_rounds
      where game_id = g.id and status = 'pending' order by round_no limit 1;
    if not found then raise exception 'no_rounds_left' using errcode = 'P0001'; end if;
    update public.games
       set phase = 'countdown', current_round_id = r.id,
           countdown_ends_at = clock_timestamp() + interval '3 seconds'
     where id = g.id;

  elsif p_action = 'start_round' then
    if g.phase <> 'countdown' or r.id is null then
      raise exception 'invalid_transition' using errcode = 'P0001';
    end if;
    update public.game_rounds set status = 'open' where id = r.id;
    -- Official start = the end of the countdown (or now, if it already passed).
    update public.game_rounds
       set opened_at = greatest(clock_timestamp(), g.countdown_ends_at)
     where id = r.id;
    update public.games set phase = 'active' where id = g.id;

  elsif p_action = 'close_submissions' then
    if g.phase <> 'active' or r.id is null or r.status <> 'open' then
      raise exception 'invalid_transition' using errcode = 'P0001';
    end if;
    if r.opened_at > clock_timestamp() then
      raise exception 'round_not_started' using errcode = 'P0001';
    end if;
    update public.game_rounds set status = 'closed' where id = r.id;

  elsif p_action = 'move_to_review' then
    if g.phase <> 'active' or r.id is null or r.status <> 'closed' then
      raise exception 'invalid_transition' using errcode = 'P0001';
    end if;
    update public.games set phase = 'reviewing' where id = g.id;

  elsif p_action = 'announce_winner' then
    if g.phase <> 'reviewing' or r.id is null then
      raise exception 'invalid_transition' using errcode = 'P0001';
    end if;
    if p_winner is not null and not exists (
         select 1 from public.players where id = p_winner and game_id = g.id and kicked_at is null) then
      raise exception 'invalid_winner' using errcode = 'P0001';
    end if;
    update public.game_rounds set winner_player_id = p_winner where id = r.id;
    update public.games set phase = 'winner_announced' where id = g.id;

  elsif p_action = 'next_round' then
    if g.phase <> 'winner_announced' then
      raise exception 'invalid_transition' using errcode = 'P0001';
    end if;
    if not exists (select 1 from public.game_rounds where game_id = g.id and status = 'pending') then
      raise exception 'no_rounds_left' using errcode = 'P0001';
    end if;
    update public.games set phase = 'lobby', current_round_id = null, countdown_ends_at = null where id = g.id;

  elsif p_action = 'end_game' then
    if g.status <> 'live' then raise exception 'invalid_transition' using errcode = 'P0001'; end if;
    update public.game_rounds set status = 'closed' where game_id = g.id and status = 'open';
    update public.games set status = 'finished' where id = g.id;

  elsif p_action = 'cancel' then
    if g.status not in ('draft', 'lobby', 'live') then
      raise exception 'invalid_transition' using errcode = 'P0001';
    end if;
    update public.game_rounds set status = 'closed' where game_id = g.id and status = 'open';
    update public.games set status = 'canceled' where id = g.id;
  end if;

  select state_version, phase into v_ver, v_phase from public.games where id = g.id;
  if v_ver = g.state_version then            -- e.g. close_submissions changed only the round
    update public.games set state_version = state_version + 1, phase_changed_at = clock_timestamp()
     where id = g.id returning state_version, phase into v_ver, v_phase;
  end if;
  perform public.broadcast_game(g.id, v_ver, v_phase);

  return public.game_state_json(g.id, 'host') || jsonb_build_object('joinCode', g.join_code);
end $$;

-- --------------------------------------------- Realtime channel authorization ----
-- Private channel 'game:<uuid>'. Listen access: the game's owner (Supabase session)
-- or a guest holding a server-minted token whose game_id claim matches the topic.
-- No INSERT policy exists, so no client can ever publish: only the database
-- (broadcast_game) and the service role send.
create or replace function public.can_listen_game_topic(p_topic text)
returns boolean language sql stable security definer set search_path = '' as $$
  select case
    when p_topic ~ '^game:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      exists (select 1 from public.games g
              where g.id = substr(p_topic, 6)::uuid and g.owner_id = auth.uid())
      or ((auth.jwt() ->> 'kind') = 'guest' and (auth.jwt() ->> 'game_id') = substr(p_topic, 6))
    else false
  end
$$;

drop policy if exists game_topic_listen on realtime.messages;
create policy game_topic_listen on realtime.messages for select to anon, authenticated
  using (realtime.messages.extension = 'broadcast' and public.can_listen_game_topic((select realtime.topic())));

-- ----------------------------------------------------------------- privileges ----
revoke all on function
  public.broadcast_game(uuid, bigint, public.game_phase), public.bump_game_version(uuid),
  public.players_bump_version(), public.game_state_json(uuid, text), public.host_game_state(uuid),
  public.player_game_state(text), public.game_transition(uuid, text, bigint, uuid),
  public.can_listen_game_topic(text), public.create_game_with_rounds(text, text[])
  from public, anon, authenticated;
grant execute on function
  public.host_game_state(uuid), public.game_transition(uuid, text, bigint, uuid),
  public.can_listen_game_topic(text), public.create_game_with_rounds(text, text[])
  to authenticated;
grant execute on function public.can_listen_game_topic(text) to anon;
grant execute on function public.player_game_state(text), public.game_state_json(uuid, text) to service_role;
