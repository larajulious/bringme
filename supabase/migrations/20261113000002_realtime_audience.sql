-- Audit Phase 2 (G2/G7, BRINGME_PHASE2_REALTIME_OPTIMIZATION.md): audience-aware Realtime hints. Forward-only, re-runnable.
-- REQUIRES Phase 1 (20261113000001_submission_lock_order.sql): complete_submission below is that body with ONE line
-- changed (which topic its hint goes to). Its locks are untouched.
--
-- Before: every visible change sent {version, phase} to game:<id> and EVERY client (all players, host, presenter)
-- re-read its snapshot, including for changes only the host's screens show.
-- Now every hint carries a scope, and host-only hints use a separate owner-only topic:
--   scope 'all'    -> game:<id>       everyone re-reads at once (phase changes, kicks/restores, rounds, capacity, results)
--   scope 'roster' -> game:<id>       a player joined: host/presenter at once, players debounce (headcount only)
--   scope 'claims' -> game:<id>       a BingoSnap claim was reviewed: only players holding a claim re-read
--   scope 'host'   -> game:<id>:host  a photo submission, a Bring Me review decision, a BingoSnap claim:
--                                     only the owner's console/presenter receive it; players never do
-- The payload stays {version, phase, scope}: no ids, names, prompts or claim data. Versions and authoritative snapshots
-- are unchanged (state_version still bumps for every change; clients still re-read the database, never the payload).
-- Host snapshots gain rosterKey/submissionsKey fingerprints so side lists are re-read only when they changed.
-- Older clients keep working: they ignore 'scope', and hosts on an older page fall back to the 30 s safety re-read
-- for host-only changes until they reload (deploy the app first, see the report).
-- Revert (not a migration): supabase/rollback/20261113000002_realtime_audience_revert.sql

do $$ begin
  if to_regprocedure('public.complete_submission(text, uuid, uuid, jsonb)') is null
     or position('p.game_id for no key update' in pg_get_functiondef('public.complete_submission(text, uuid, uuid, jsonb)'::regprocedure)) = 0 then
    raise exception 'phase2_precondition: apply 20261113000001_submission_lock_order.sql (Phase 1) first';
  end if;
  if to_regprocedure('public.bingo_submit_claim(text, uuid[], uuid)') is null then
    raise exception 'phase2_precondition: apply the BingoSnap migrations (20261112000017..21) first';
  end if;
end $$;


-- ---------------------------------------------------------- broadcasting ----
create or replace function public.broadcast_game(p_game uuid, p_version bigint, p_phase public.game_phase, p_scope text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_scope text := case when p_scope in ('all', 'roster', 'claims', 'host') then p_scope else 'all' end;
begin
  begin
    perform realtime.send(
      jsonb_build_object('version', p_version, 'phase', p_phase, 'scope', v_scope),
      'state',
      case when v_scope = 'host' then 'game:' || p_game::text || ':host' else 'game:' || p_game::text end,
      true);
  exception when others then
    null; -- database state stays authoritative; clients resync on their own
  end;
end $$;

create or replace function public.broadcast_game(p_game uuid, p_version bigint, p_phase public.game_phase)
returns void language sql security definer set search_path = '' as $$
  select public.broadcast_game(p_game, p_version, p_phase, 'all')
$$;

create or replace function public.bump_game_version(p_game uuid, p_scope text)
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
    perform public.broadcast_game(p_game, v_ver, v_phase, p_scope);
  end if;
end $$;

create or replace function public.bump_game_version(p_game uuid)
returns void language sql security definer set search_path = '' as $$
  select public.bump_game_version(p_game, 'all')
$$;

create or replace function public.players_bump_version()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- a join only changes the headcount (players debounce it); a removal or restore matters at once
  perform public.bump_game_version(new.game_id, case when tg_op = 'INSERT' then 'roster' else 'all' end);
  return null;
end $$;

-- ------------------------------------------------- channel authorization ----
create or replace function public.can_listen_game_topic(p_topic text)
returns boolean language sql stable security definer set search_path = '' as $$
  select case
    when p_topic ~ '^game:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      exists (select 1 from public.games g
              where g.id = substr(p_topic, 6)::uuid and g.owner_id = auth.uid())
      or ((auth.jwt() ->> 'kind') = 'guest' and (auth.jwt() ->> 'game_id') = substr(p_topic, 6))
    -- host-only hints (submissions, reviews, claims): the owning host only, never a guest token
    when p_topic ~ '^game:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:host$' then
      exists (select 1 from public.games g
              where g.id = substr(p_topic, 6, 36)::uuid and g.owner_id = auth.uid())
    else false
  end
$$;

-- ---------------------------------------------------------- host snapshot ----
-- Fingerprints for the host's side lists, so the console and presenter re-read the roster or the
-- submissions list only when it actually changed (not on every version). Host views only.
create or replace function public.host_sync_keys(p_game uuid, p_viewer text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when p_viewer = 'host' then jsonb_build_object(
    'rosterKey', (select md5(coalesce(string_agg(p.id::text, ',' order by p.id), ''))
                    from public.players p where p.game_id = p_game and p.kicked_at is null),
    'submissionsKey', (select md5(coalesce(string_agg(s.id::text || ':' || s.status::text || ':' || (pl.kicked_at is null)::text, ',' order by s.id), ''))
                         from public.games g
                         join public.submissions s on s.round_id = g.current_round_id
                         join public.players pl on pl.id = s.player_id
                        where g.id = p_game))
  else '{}'::jsonb end
$$;

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
  return public.host_sync_keys(g.id, p_viewer) || jsonb_build_object(
    'version', g.state_version,
    'status', g.status,
    'phase', g.phase,
    'title', g.title,
    'serverNow', clock_timestamp(),
    'countdownEndsAt', g.countdown_ends_at,
    'totalRounds', (select count(*) from public.game_rounds where game_id = g.id and replayed_at is null),
    'roundsRemaining', (select count(*) from public.game_rounds
                         where game_id = g.id and status = 'pending' and id is distinct from g.current_round_id),
    'playerCount', (select count(*) from public.players where game_id = g.id and kicked_at is null),
    'maxPlayers', g.max_players,
    'archivedAt', g.archived_at,
    'submissionCount', case when r.id is null then 0
                            else (select count(*) from public.submissions s
                                   join public.players pl on pl.id = s.player_id and pl.kicked_at is null
                                  where s.round_id = r.id) end,
    'reviewCounts', case when r.id is null then null else (
      select jsonb_build_object(
        'pending',  count(*) filter (where s.status = 'pending'),
        'approved', count(*) filter (where s.status = 'approved'),
        'rejected', count(*) filter (where s.status = 'rejected'))
      from public.submissions s join public.players pl on pl.id = s.player_id and pl.kicked_at is null
      where s.round_id = r.id) end,
    'results', case when g.status = 'finished' then public.game_results_json(g.id, null) else null end,
    'round', case when r.id is null then null else jsonb_build_object(
      'id', r.id,
      -- the number players see: replayed rounds are left out, so a replay keeps its round's number
      'no', (select count(*) from public.game_rounds x where x.game_id = g.id and x.round_no <= r.round_no and x.replayed_at is null),
      'status', r.status,
      'openedAt', r.opened_at,
      'closedAt', r.closed_at,
      'timeLimitSeconds', r.time_limit_seconds,
      'prompt', case when p_viewer = 'host' or (r.opened_at is not null and r.opened_at <= clock_timestamp())
                     then r.prompt end,
      'winnerPlayerId', r.winner_player_id,
      'winnerName', (select nickname from public.players where id = r.winner_player_id),
      'winnerMs', r.winner_rank_ms,
      'decided', r.winner_confirmed_at is not null
    ) end
  );
end $$;

-- ----------------------------------------- host-only events (bodies unchanged otherwise) ----
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
  select * into p from public.players where token_hash = p_token_hash for no key update;
  if not found then raise exception 'invalid_session' using errcode = 'P0001'; end if;
  if p.kicked_at is not null then raise exception 'player_removed' using errcode = 'P0001'; end if;
  -- Exclusive (no-key) lock up front: this transaction UPDATEs the game row below (bump_game_version).
  -- A shared lock here was upgraded later, and two players doing that at once deadlocked (audit G1).
  select * into g from public.games where id = p.game_id for no key update;

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

  perform public.bump_game_version(p.game_id, 'host');   -- only host screens show submissions (audit G2)
  return jsonb_build_object('status', 'accepted', 'elapsedMs', v_claimed, 'rankMs', v_rank,
                            'timing', v_status, 'flags', v_flags);
end $$;

create or replace function public.review_submission(p_submission uuid, p_decision text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  g public.games%rowtype;
  s public.submissions%rowtype;
  v_status public.submission_status;
begin
  if auth.uid() is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  v_status := case p_decision
    when 'approve' then 'approved'::public.submission_status
    when 'disqualify' then 'rejected'::public.submission_status
    when 'reset' then 'pending'::public.submission_status
  end;
  if v_status is null then raise exception 'invalid_decision' using errcode = 'P0001'; end if;

  -- owner check without leaking existence
  select sub.* into s from public.submissions sub
    join public.games gg on gg.id = sub.game_id and gg.owner_id = auth.uid()
    where sub.id = p_submission;
  if not found then raise exception 'submission_not_found' using errcode = 'P0001'; end if;

  -- same lock as game_transition: reviews and winner announcements are strictly ordered
  select * into g from public.games where id = s.game_id for update;
  if g.status <> 'live' or g.phase not in ('active', 'reviewing') or g.current_round_id is distinct from s.round_id then
    raise exception 'review_locked' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.game_rounds where id = s.round_id and winner_confirmed_at is not null) then
    raise exception 'review_locked' using errcode = 'P0001';
  end if;

  if s.status <> v_status then
    update public.submissions set status = v_status where id = s.id;
    perform public.bump_game_version(g.id, 'host');   -- outcomes reach players with the announcement (audit G2)
  end if;
  return public.game_state_json(g.id, 'host');
end $$;

create or replace function public.bingo_submit_claim(p_token_hash text, p_cell_ids uuid[], p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  p public.players%rowtype;
  g public.games%rowtype;
  b public.bingo_games%rowtype;
  v_arrived timestamptz := statement_timestamp();
  v_limit timestamptz;
  v_attempts integer;
  v_positions integer[];
  v_cells uuid[];
  v_free integer;
  v_pattern text;
  v_scope text := 'host';   -- a claim is news for the host; the claimant gets its own answer
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_session' using errcode = 'P0001';
  end if;
  select * into p from public.players where token_hash = p_token_hash;
  if not found then raise exception 'invalid_session' using errcode = 'P0001'; end if;

  -- Serialise all claims of this game (and against close_hunt / announce / end).
  select * into g from public.games where id = p.game_id for update;
  if g.game_type <> 'bingosnap' then raise exception 'wrong_game_type' using errcode = 'P0001'; end if;

  -- A replay of a request that already succeeded: same answer, nothing new.
  if p_request_id is not null and exists (
       select 1 from public.bingo_submissions where player_id = p.id and request_id = p_request_id) then
    return public.bingo_state_json(g.id, 'player', p.id);
  end if;

  if p.kicked_at is not null then raise exception 'player_removed' using errcode = 'P0001'; end if;
  select * into b from public.bingo_games where game_id = g.id;

  perform set_config('bingosnap.engine', 'on', true);
  if public.bingo_settle(g.id) then
    select * into g from public.games where id = g.id;
    v_scope := 'all';   -- the expired hunt moved to review in this transaction: everyone must know
  end if;
  perform set_config('bingosnap.engine', 'off', true);

  if g.status in ('finished', 'canceled') or g.phase = 'winner_announced' then
    raise exception 'hunt_over' using errcode = 'P0001';
  end if;
  if g.status <> 'live' or g.phase not in ('active', 'reviewing') or b.hunt_started_at is null or v_arrived < b.hunt_started_at then
    raise exception 'hunt_not_active' using errcode = 'P0001';
  end if;
  -- The last accepted arrival: the natural deadline + 2 s grace, or exactly the moment of an early close.
  v_limit := b.hunt_ends_at + case
    when b.hunt_ends_at < b.hunt_started_at + make_interval(secs => b.duration_seconds) then interval '0'
    else interval '2 seconds' end;
  if v_arrived > v_limit then
    raise exception 'hunt_over' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.bingo_submissions where player_id = p.id and status = 'verified') then
    raise exception 'already_verified' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.bingo_submissions where player_id = p.id and status = 'pending') then
    raise exception 'claim_pending' using errcode = 'P0001';
  end if;
  select count(*) into v_attempts from public.bingo_submissions where player_id = p.id;
  if v_attempts >= 5 then raise exception 'attempts_exhausted' using errcode = 'P0001'; end if;

  if p_cell_ids is null or cardinality(p_cell_ids) not between 1 and 25
     or array_position(p_cell_ids, null) is not null
     or (select count(distinct x) from unnest(p_cell_ids) x) <> cardinality(p_cell_ids) then
    raise exception 'invalid_cells' using errcode = 'P0001';
  end if;
  -- Map to THIS participant's own board positions (cells of other games / the free space don't match).
  select array_agg(l.pos::integer order by l.pos), array_agg(l.cell_id order by l.pos) into v_positions, v_cells
    from unnest(p_cell_ids) x join public.bingo_layout(g.id, p.id) l on l.cell_id = x and not l.is_free;
  if coalesce(cardinality(v_positions), 0) <> cardinality(p_cell_ids) then
    raise exception 'invalid_cells' using errcode = 'P0001';
  end if;
  select l.pos into v_free from public.bingo_layout(g.id, p.id) l where l.is_free;
  v_pattern := public.bingo_pattern(b.board_size, b.win_mode, v_free, v_positions);
  if v_pattern is null then raise exception 'invalid_pattern' using errcode = 'P0001'; end if;

  insert into public.bingo_submissions (game_id, player_id, attempt_no, cell_ids, pattern, submitted_at, request_id)
  values (g.id, p.id, v_attempts + 1, v_cells, v_pattern, v_arrived, p_request_id);

  perform public.bump_game_version(g.id, v_scope);
  return public.bingo_state_json(g.id, 'player', p.id);
end $$;

create or replace function public.bingo_review_submission(p_submission uuid, p_decision text, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s public.bingo_submissions%rowtype;
  g public.games%rowtype;
  b public.bingo_games%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_kicked timestamptz;
  v_scope text := 'claims';   -- players holding a claim re-read; the rest have nothing to update
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  if p_decision is null or p_decision not in ('verify', 'reject', 'reset') then
    raise exception 'invalid_decision' using errcode = 'P0001';
  end if;
  if v_reason is not null and (p_decision <> 'reject' or char_length(v_reason) > 120) then
    raise exception 'invalid_reason' using errcode = 'P0001';
  end if;

  select gm.* into g from public.games gm
    join public.bingo_submissions x on x.game_id = gm.id
   where x.id = p_submission and gm.owner_id = auth.uid()
   for update of gm;
  if not found then raise exception 'submission_not_found' using errcode = 'P0001'; end if;   -- not owner = not found
  select * into s from public.bingo_submissions where id = p_submission for update;
  select * into b from public.bingo_games where game_id = g.id;
  if g.status <> 'live' or b.results_at is not null then
    raise exception 'review_locked' using errcode = 'P0001';
  end if;

  perform set_config('bingosnap.engine', 'on', true);
  if public.bingo_settle(g.id) then v_scope := 'all'; end if;
  perform set_config('bingosnap.engine', 'off', true);

  select kicked_at into v_kicked from public.players where id = s.player_id;
  if p_decision in ('verify', 'reject') then
    if s.status <> 'pending' then raise exception 'already_reviewed' using errcode = 'P0001'; end if;
    if p_decision = 'verify' and v_kicked is not null then
      raise exception 'player_removed' using errcode = 'P0001';
    end if;
    update public.bingo_submissions
       set status = case when p_decision = 'verify' then 'verified' else 'rejected' end::public.bingo_submission_status,
           validated_at = clock_timestamp(), validated_by = auth.uid(),
           rejection_reason = case when p_decision = 'reject' then v_reason end
     where id = s.id;
  else
    if s.status = 'pending' then raise exception 'already_pending' using errcode = 'P0001'; end if;
    begin
      update public.bingo_submissions
         set status = 'pending', validated_at = null, validated_by = null, rejection_reason = null
       where id = s.id;
    exception when unique_violation then
      raise exception 'claim_superseded' using errcode = 'P0001';   -- the participant has a newer live claim
    end;
  end if;

  perform public.bump_game_version(g.id, v_scope);
  return public.bingo_state_json(g.id, 'host');
end $$;

-- ------------------------------------------------------------------ privileges ----
-- New internals: no client may execute them (create or replace keeps every existing grant).
revoke all on function
  public.broadcast_game(uuid, bigint, public.game_phase, text), public.bump_game_version(uuid, text),
  public.host_sync_keys(uuid, text)
  from public, anon, authenticated;
