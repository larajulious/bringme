-- Bring Me countdown: 5 seconds instead of 3 (players get a little longer to get ready).
-- Copies of game_transition (20261112000022) and replay_round (20261112000026) with ONLY the countdown interval
-- changed. Same signatures, so grants are kept. BingoSnap keeps its own 3-second countdown (bingo_start).

create or replace function public.game_transition(
  p_game uuid, p_action text, p_expected_version bigint, p_winner uuid default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  g public.games%rowtype;
  r public.game_rounds%rowtype;
  v_ver bigint;
  v_phase public.game_phase;
  v_win record;
  v_cap integer;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  if p_action not in ('start_game', 'start_countdown', 'restart_countdown', 'start_round', 'close_submissions',
                      'move_to_review', 'announce_winner', 'next_round', 'end_game', 'cancel', 'archive') then
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
    -- Game Pass D-9: the CURRENT pass must cover everyone already in the room
    -- (a downgrade or an expiry may have lowered the cap since the lobby opened).
    if not public.is_admin_user(g.owner_id) then
      select e.max_players_per_game into v_cap from public.pass_entitlement(g.owner_id) e;
      if v_cap is null then
        raise exception 'subscription_required' using errcode = 'P0001';
      end if;
      v_cap := least(g.max_players, v_cap);
      if (select count(*) from public.players where game_id = g.id and kicked_at is null) > v_cap then
        raise exception 'player_limit_exceeded' using errcode = 'P0001';
      end if;
      update public.games set status = 'live', max_players = v_cap where id = g.id;  -- entitlement re-checked by trigger
    else
      update public.games set status = 'live' where id = g.id;
    end if;

  elsif p_action = 'start_countdown' then
    if g.status <> 'live' or g.phase <> 'lobby' then
      raise exception 'invalid_transition' using errcode = 'P0001';
    end if;
    -- Game Pass D-10: no per-round entitlement check. A game that went live while the
    -- host was entitled may finish its pre-created rounds (rounds cannot be added after start).
    select * into r from public.game_rounds
      where game_id = g.id and status = 'pending' order by round_no limit 1;
    if not found then raise exception 'no_rounds_left' using errcode = 'P0001'; end if;
    update public.games
       set phase = 'countdown', current_round_id = r.id,
           countdown_ends_at = clock_timestamp() + interval '5 seconds'
     where id = g.id;

  elsif p_action = 'restart_countdown' then
    -- Host replays the countdown (e.g. players looked away). Only before the round is started.
    if g.status <> 'live' or g.phase <> 'countdown' or r.id is null then
      raise exception 'invalid_transition' using errcode = 'P0001';
    end if;
    update public.games set countdown_ends_at = clock_timestamp() + interval '5 seconds' where id = g.id;

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
    if r.winner_confirmed_at is not null then
      raise exception 'winner_already_confirmed' using errcode = 'P0001';
    end if;
    -- THE WINNER IS COMPUTED HERE, never taken from the caller: the fastest APPROVED
    -- submission by the ranking policy (disqualified / pending / removed players never win).
    -- p_winner is the host's CONFIRMATION of what they saw; if the ranking moved
    -- meanwhile (late photo, another decision) it no longer matches and nothing is announced.
    select s.id, s.player_id, s.rank_ms into v_win
      from public.submissions s
      join public.players pl on pl.id = s.player_id and pl.kicked_at is null
      where s.round_id = r.id and s.status = 'approved'
      order by s.rank_ms, s.server_elapsed_ms, s.submitted_at, s.id
      limit 1;
    if p_winner is distinct from v_win.player_id then
      raise exception 'winner_mismatch' using errcode = 'P0001';
    end if;
    update public.game_rounds
       set winner_player_id = v_win.player_id, winner_submission_id = v_win.id,
           winner_rank_ms = v_win.rank_ms, winner_confirmed_at = clock_timestamp()
     where id = r.id;
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

  elsif p_action = 'archive' then
    if g.status <> 'finished' or g.archived_at is not null then
      raise exception 'invalid_transition' using errcode = 'P0001';
    end if;
    update public.games set archived_at = clock_timestamp() where id = g.id;

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

create or replace function public.replay_round(p_game uuid, p_expected_version bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  g public.games%rowtype;
  r public.game_rounds%rowtype;
  v_new uuid;
  v_ver bigint;
  v_phase public.game_phase;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  -- Not the owner and not existing look identical.
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
  -- Only after photos stopped (Time's up or reviewing) and before the result is official.
  if g.status <> 'live' or r.id is null or r.status <> 'closed'
     or g.phase not in ('active', 'reviewing') or r.winner_confirmed_at is not null then
    raise exception 'invalid_transition' using errcode = 'P0001';
  end if;

  -- 1) The stopped round ends with no winner (write-once, like announce_winner with nothing approved).
  update public.game_rounds
     set replayed_at = clock_timestamp(), winner_player_id = null, winner_submission_id = null,
         winner_rank_ms = null, winner_confirmed_at = clock_timestamp()
   where id = r.id;

  -- 2) Make room right after it (two steps, so unique (game_id, round_no) never collides). Later rounds are pending.
  update public.game_rounds set round_no = round_no + 100000 where game_id = g.id and round_no > r.round_no;
  update public.game_rounds set round_no = round_no - 99999 where game_id = g.id and round_no > 100000;
  insert into public.game_rounds (game_id, round_no, prompt, time_limit_seconds, points)
  values (g.id, r.round_no + 1, r.prompt, r.time_limit_seconds, r.points)
  returning id into v_new;

  -- 3) Start it: 5-second countdown, then the round opens when the countdown ends (as start_countdown + start_round).
  update public.games
     set phase = 'countdown', current_round_id = v_new, countdown_ends_at = clock_timestamp() + interval '5 seconds'
   where id = g.id;
  update public.game_rounds set status = 'open' where id = v_new;
  update public.game_rounds set opened_at = clock_timestamp() + interval '5 seconds' where id = v_new;
  update public.games set phase = 'active', state_version = state_version + 1, phase_changed_at = clock_timestamp()
   where id = g.id returning state_version, phase into v_ver, v_phase;
  perform public.broadcast_game(g.id, v_ver, v_phase);

  return public.game_state_json(g.id, 'host') || jsonb_build_object('joinCode', g.join_code);
end $$;
