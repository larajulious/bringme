-- Revert of 20261113000001_submission_lock_order.sql (NOT a migration). Restores the exact begin_/complete_submission
-- bodies of 20261111000010. WARNING: this brings back the deadlock between simultaneous photo submissions (audit G1).
-- Only use it if the new lock behaviour itself causes a problem. Run in one transaction:  begin; \i this file; commit;

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

revoke all on function
  public.begin_submission(text, uuid, uuid, integer, jsonb), public.complete_submission(text, uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function
  public.begin_submission(text, uuid, uuid, integer, jsonb), public.complete_submission(text, uuid, uuid, jsonb)
  to service_role;
