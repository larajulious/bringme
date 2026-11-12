-- BringMe! Phase 8: camera submissions with server-verified timing.
--
-- Flow (all service-role functions, called by server handlers after the guest's
-- cookie is validated):
--   1. begin_submission    at TAP time: records a server-side "intent" (intent_at =
--                          when the server first heard about the capture) + the
--                          client's claimed elapsed ms. One intent per player/round.
--   2. (photo is compressed and uploaded to private storage)
--   3. complete_submission once the stored photo is verified: creates THE
--                          submission, computes consistency flags and a rank.
-- The client's elapsed time is a CLAIM. The server independently records
-- intent_at (≈ tap + one-way latency) and receipt time, cross-checks them, and
-- falls back to the server-observed time when the claim is inconsistent.
-- See TIMING.md for the ranking policy and its limits.

-- ----------------------------------------------------------------- columns ----
alter table public.submissions
  add column if not exists attempt_id uuid,
  add column if not exists intent_at timestamptz,
  add column if not exists claimed_elapsed_ms integer,
  add column if not exists server_elapsed_ms integer,    -- intent_at - opened_at (server-observed, includes one-way latency)
  add column if not exists received_elapsed_ms integer,  -- completion receipt - opened_at
  add column if not exists rank_ms integer,              -- the number used for ranking (see policy)
  add column if not exists timing_status text check (timing_status in ('consistent', 'flagged')),
  add column if not exists timing_flags text[] not null default '{}',
  add column if not exists client_meta jsonb;

create table if not exists public.submission_intents (
  id                  uuid primary key default gen_random_uuid(),
  game_id             uuid not null,
  round_id            uuid not null,
  player_id           uuid not null,
  attempt_id          uuid not null,
  intent_at           timestamptz not null default clock_timestamp(),
  claimed_elapsed_ms  integer not null,
  client_meta         jsonb not null default '{}'::jsonb,
  foreign key (round_id, game_id)  references public.game_rounds (id, game_id) on delete cascade,
  foreign key (player_id, game_id) references public.players (id, game_id)     on delete cascade,
  unique (round_id, player_id)
);
alter table public.submission_intents enable row level security;
revoke all on public.submission_intents from public, anon, authenticated;
grant all on public.submission_intents to service_role;

-- ----------------------------------------------------- insert backstop trigger ----
-- A submission can only exist if an intent was recorded while the round was open.
-- Late-landing uploads ("stragglers") are accepted if the TAP happened before the
-- host closed submissions and the upload finishes inside the window.
create or replace function public.enforce_submission_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_round record;
  v_game record;
  v_kicked timestamptz;
  v_intent record;
begin
  select * into v_round from public.game_rounds where id = new.round_id and game_id = new.game_id;
  select status, phase, current_round_id into v_game from public.games where id = new.game_id;
  select kicked_at into v_kicked from public.players where id = new.player_id and game_id = new.game_id;
  select * into v_intent from public.submission_intents
    where round_id = new.round_id and player_id = new.player_id and game_id = new.game_id;

  if v_game.status is distinct from 'live' then
    raise exception 'game_not_live' using errcode = 'P0001';
  end if;
  if v_kicked is not null then
    raise exception 'player_kicked' using errcode = 'P0001';
  end if;
  if v_intent is null then
    raise exception 'intent_required' using errcode = 'P0001';
  end if;
  if v_game.phase not in ('active', 'reviewing') or v_game.current_round_id is distinct from new.round_id then
    raise exception 'round_not_open' using errcode = 'P0001';
  end if;
  if not (v_round.status = 'open'
          or (v_round.status = 'closed' and v_intent.intent_at <= v_round.closed_at)) then
    raise exception 'round_not_open' using errcode = 'P0001';
  end if;
  if v_intent.intent_at < v_round.opened_at then
    raise exception 'round_not_started' using errcode = 'P0001';
  end if;
  if clock_timestamp() - v_intent.intent_at > interval '50 seconds' then
    raise exception 'attempt_expired' using errcode = 'P0001';
  end if;
  new.attempt_id := v_intent.attempt_id;
  new.status := 'pending'; new.points_awarded := 0; new.reviewed_at := null; new.submitted_at := now();
  return new;
end $$;

-- ------------------------------------------------------------ begin (tap time) ----
create or replace function public.begin_submission(
  p_token_hash text, p_round uuid, p_attempt uuid, p_elapsed_ms integer, p_meta jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  p public.players%rowtype;
  g public.games%rowtype;
  r public.game_rounds%rowtype;
  i public.submission_intents%rowtype;
  s public.submissions%rowtype;
  v_now timestamptz;
begin
  -- Serialise everything this player does (double taps, two devices, retries).
  select * into p from public.players where token_hash = p_token_hash for update;
  if not found then raise exception 'invalid_session' using errcode = 'P0001'; end if;
  if p.kicked_at is not null then raise exception 'player_removed' using errcode = 'P0001'; end if;

  -- Share-lock the game so a concurrent Game Master transition is ordered with us.
  select * into g from public.games where id = p.game_id for share;

  select * into s from public.submissions where round_id = p_round and player_id = p.id;
  if found then
    return jsonb_build_object('status', 'already_submitted', 'elapsedMs', s.claimed_elapsed_ms,
                              'rankMs', s.rank_ms, 'timing', s.timing_status);
  end if;

  if g.status <> 'live' or g.phase <> 'active' or g.current_round_id is distinct from p_round then
    raise exception 'round_not_open' using errcode = 'P0001';
  end if;
  select * into r from public.game_rounds where id = p_round and game_id = g.id;
  v_now := clock_timestamp();
  if r.status <> 'open' then raise exception 'round_not_open' using errcode = 'P0001'; end if;
  if v_now < r.opened_at then raise exception 'round_not_started' using errcode = 'P0001'; end if;
  if v_now > r.opened_at + make_interval(secs => r.time_limit_seconds) + interval '2 seconds' then
    raise exception 'round_closed' using errcode = 'P0001';
  end if;
  if p_elapsed_ms is null or p_elapsed_ms < -60000 or p_elapsed_ms > 7200000 then
    raise exception 'invalid_timing' using errcode = 'P0001';
  end if;

  select * into i from public.submission_intents where round_id = p_round and player_id = p.id;
  if found then
    if i.attempt_id = p_attempt then
      -- Same capture, retrying its upload: keep the ORIGINAL timing.
      if v_now - i.intent_at > interval '45 seconds' then
        raise exception 'attempt_expired' using errcode = 'P0001';
      end if;
      return jsonb_build_object('status', 'resumed', 'gameId', p.game_id, 'roundId', p_round,
                                'playerId', p.id, 'intentAt', i.intent_at);
    end if;
    -- A NEW capture replaces an unfinished one and its timing restarts: tapping
    -- early to "reserve" a time and photographing later gains nothing.
    delete from public.submission_intents where id = i.id;
  end if;

  insert into public.submission_intents (game_id, round_id, player_id, attempt_id, intent_at, claimed_elapsed_ms, client_meta)
  values (p.game_id, p_round, p.id, p_attempt, v_now, p_elapsed_ms, coalesce(p_meta, '{}'::jsonb))
  returning * into i;

  return jsonb_build_object('status', 'ready', 'gameId', p.game_id, 'roundId', p_round,
                            'playerId', p.id, 'intentAt', i.intent_at);
end $$;

-- ------------------------------------------------ complete (photo verified) ----
create or replace function public.complete_submission(
  p_token_hash text, p_round uuid, p_attempt uuid, p_meta jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  p public.players%rowtype;
  g public.games%rowtype;
  r public.game_rounds%rowtype;
  i public.submission_intents%rowtype;
  s public.submissions%rowtype;
  v_now timestamptz;
  v_claimed integer;
  v_tc timestamptz;
  v_server_ms integer;
  v_recv_ms integer;
  v_flags text[] := '{}';
  v_hard text[] := array['elapsed_negative', 'intent_before_capture', 'intent_lag_high', 'elapsed_exceeds_limit'];
  v_status text;
  v_rank integer;
  v_meta jsonb;
  v_rtt numeric;
  v_age numeric;
  v_path text;
begin
  select * into p from public.players where token_hash = p_token_hash for update;
  if not found then raise exception 'invalid_session' using errcode = 'P0001'; end if;
  if p.kicked_at is not null then raise exception 'player_removed' using errcode = 'P0001'; end if;
  select * into g from public.games where id = p.game_id for share;

  -- Idempotent: a retry after a lost response just gets the accepted result again.
  select * into s from public.submissions where round_id = p_round and player_id = p.id;
  if found then
    return jsonb_build_object('status', 'duplicate', 'elapsedMs', s.claimed_elapsed_ms,
                              'rankMs', s.rank_ms, 'timing', s.timing_status, 'flags', s.timing_flags);
  end if;

  select * into i from public.submission_intents where round_id = p_round and player_id = p.id;
  if not found then raise exception 'no_intent' using errcode = 'P0001'; end if;
  if i.attempt_id <> p_attempt then raise exception 'attempt_superseded' using errcode = 'P0001'; end if;
  v_now := clock_timestamp();
  if v_now - i.intent_at > interval '45 seconds' then
    raise exception 'attempt_expired' using errcode = 'P0001';
  end if;
  if g.status <> 'live' or g.current_round_id is distinct from p_round or g.phase not in ('active', 'reviewing') then
    raise exception 'round_not_open' using errcode = 'P0001';
  end if;
  select * into r from public.game_rounds where id = p_round and game_id = g.id;

  -- ---- independent timing evidence -------------------------------------------
  v_claimed   := i.claimed_elapsed_ms;
  v_tc        := r.opened_at + make_interval(secs => v_claimed / 1000.0);           -- when the client says it captured
  v_server_ms := round(extract(epoch from (i.intent_at - r.opened_at)) * 1000)::integer;  -- when the SERVER first heard about it
  v_recv_ms   := round(extract(epoch from (v_now - r.opened_at)) * 1000)::integer;
  v_meta      := i.client_meta || coalesce(p_meta, '{}'::jsonb);

  if v_claimed < -250 then v_flags := array_append(v_flags, 'elapsed_negative'::text); end if;
  -- the server heard about the tap BEFORE the client says it happened: impossible
  if i.intent_at < v_tc - interval '250 milliseconds' then v_flags := array_append(v_flags, 'intent_before_capture'::text); end if;
  -- the client says it happened long before the server heard. A real tap reaches the server one network
  -- hop later (typically < 150 ms), so more than 1 s means a very slow network OR an inflated lead:
  -- the claim is not trusted. 1 s is therefore also the largest lead a cheater can claim undetected.
  if i.intent_at - v_tc > interval '1 second' then v_flags := array_append(v_flags, 'intent_lag_high'::text); end if;
  if i.intent_at - v_tc > interval '400 milliseconds' then v_flags := array_append(v_flags, 'intent_lag_elevated'::text); end if;
  if v_claimed > r.time_limit_seconds * 1000 + 2000 then v_flags := array_append(v_flags, 'elapsed_exceeds_limit'::text); end if;

  v_rtt := case when jsonb_typeof(v_meta -> 'syncRttMs') = 'number' then (v_meta ->> 'syncRttMs')::numeric end;
  v_age := case when jsonb_typeof(v_meta -> 'syncAgeMs') = 'number' then (v_meta ->> 'syncAgeMs')::numeric end;
  if v_rtt is null or v_age is null then v_flags := array_append(v_flags, 'sync_unknown'::text); end if;
  if v_rtt > 1500 then v_flags := array_append(v_flags, 'sync_rtt_high'::text); end if;
  if v_age > 120000 then v_flags := array_append(v_flags, 'sync_stale'::text); end if;
  if v_now - i.intent_at > interval '20 seconds' then v_flags := array_append(v_flags, 'upload_slow'::text); end if;

  v_status := case when v_flags && v_hard then 'flagged' else 'consistent' end;
  -- Ranking number: the client's measurement when it is consistent with the
  -- server's evidence; otherwise the server-observed time (conservative).
  v_rank := case when v_status = 'flagged' then greatest(v_server_ms, 0) else greatest(v_claimed, 0) end;
  v_path := p.game_id::text || '/' || p_round::text || '/' || p.id::text || '.jpg';

  insert into public.submissions (
    game_id, round_id, player_id, storage_path, intent_at, claimed_elapsed_ms, server_elapsed_ms,
    received_elapsed_ms, rank_ms, timing_status, timing_flags, client_meta)
  values (p.game_id, p_round, p.id, v_path, i.intent_at, v_claimed, v_server_ms,
          v_recv_ms, v_rank, v_status, v_flags, v_meta);

  perform public.bump_game_version(p.game_id);   -- hosts/players see the new submission
  return jsonb_build_object('status', 'accepted', 'elapsedMs', v_claimed, 'rankMs', v_rank,
                            'timing', v_status, 'flags', v_flags);
end $$;

-- Photo failed server-side checks: forget the attempt so the player may capture again.
create or replace function public.discard_submission_intent(p_token_hash text, p_round uuid, p_attempt uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from public.submission_intents i
   using public.players p
   where p.token_hash = p_token_hash and i.player_id = p.id and i.round_id = p_round and i.attempt_id = p_attempt
     and not exists (select 1 from public.submissions s where s.round_id = i.round_id and s.player_id = i.player_id);
end $$;

-- --------------------------------------------------------------------- ranking ----
-- Ranking policy (TIMING.md): ascending rank_ms; ties broken by the server-observed
-- time, then receipt order. Results closer than p_near_ms are marked near_tie so
-- the Game Master can judge them instead of trusting millisecond precision.
-- SECURITY INVOKER: the host's own RLS decides which rows exist.
-- Migration 11 replaces this with a different return shape, so drop first: that keeps
-- a re-run of 10 → 12 working (11 then installs the current version again).
drop function if exists public.round_ranking(uuid, integer);
create or replace function public.round_ranking(p_round uuid, p_near_ms integer default 150)
returns table (
  rank integer, player_id uuid, nickname text, rank_ms integer, claimed_elapsed_ms integer,
  server_elapsed_ms integer, timing_status text, timing_flags text[], near_tie boolean,
  submitted_at timestamptz, storage_path text
) language sql stable security invoker set search_path = '' as $$
  with ordered as (
    select s.*, pl.nickname as nick,
           row_number() over (order by s.rank_ms, s.server_elapsed_ms, s.submitted_at, s.id) as rn
    from public.submissions s
    join public.players pl on pl.id = s.player_id
    where s.round_id = p_round
  )
  select o.rn::integer, o.player_id, o.nick, o.rank_ms, o.claimed_elapsed_ms, o.server_elapsed_ms,
         o.timing_status, o.timing_flags,
         coalesce(o.rank_ms - lag(o.rank_ms) over w < p_near_ms, false)
           or coalesce(lead(o.rank_ms) over w - o.rank_ms < p_near_ms, false),
         o.submitted_at, o.storage_path
  from ordered o
  window w as (order by o.rn)
  order by o.rn
$$;

-- --------------------------------------------------------------- snapshots ----
-- (re-declared with: round id, submission count, and the player's own result)
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
    'submissionCount', case when r.id is null then 0
                            else (select count(*) from public.submissions where round_id = r.id) end,
    'round', case when r.id is null then null else jsonb_build_object(
      'id', r.id,
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

create or replace function public.player_game_state(p_token_hash text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  p public.players%rowtype;
  g public.games%rowtype;
  v jsonb;
  s public.submissions%rowtype;
begin
  select * into p from public.players where token_hash = p_token_hash;
  if not found then return null; end if;
  select * into g from public.games where id = p.game_id;
  v := public.game_state_json(g.id, 'player');
  select * into s from public.submissions where player_id = p.id and round_id = g.current_round_id;
  return v || jsonb_build_object(
    'gameId', g.id,
    'joinCode', g.join_code,
    'me', jsonb_build_object(
      'id', p.id,
      'nickname', p.nickname,
      'kicked', p.kicked_at is not null,
      'hasSubmitted', s.id is not null,
      'submission', case when s.id is null then null
                         else jsonb_build_object('elapsedMs', s.claimed_elapsed_ms, 'timing', s.timing_status) end,
      'isWinner', exists (select 1 from public.game_rounds r
                           where r.id = g.current_round_id and r.winner_player_id = p.id)
    )
  );
end $$;

-- ------------------------------------------------------------------ privileges ----
revoke all on function
  public.begin_submission(text, uuid, uuid, integer, jsonb), public.complete_submission(text, uuid, uuid, jsonb),
  public.discard_submission_intent(text, uuid, uuid), public.round_ranking(uuid, integer),
  public.game_state_json(uuid, text), public.player_game_state(text)
  from public, anon, authenticated;
grant execute on function
  public.begin_submission(text, uuid, uuid, integer, jsonb), public.complete_submission(text, uuid, uuid, jsonb),
  public.discard_submission_intent(text, uuid, uuid), public.game_state_json(uuid, text),
  public.player_game_state(text) to service_role;
grant execute on function public.round_ranking(uuid, integer) to authenticated;
