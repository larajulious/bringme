-- BringMe! Phase 9: live review, server-decided winners, results and archive.
--
-- Rules enforced here (not in the browser):
--   * Submissions are reviewed ONLY through review_submission(): approve / disqualify / undo.
--     Direct client UPDATEs of status are revoked. Decisions lock once the winner is confirmed.
--   * The winner is COMPUTED by announce_winner: the fastest APPROVED submission by the
--     established ranking policy (rank_ms, then server-observed time, then arrival).
--     The host's winner id is only a confirmation of what they saw; a mismatch (late photo,
--     another decision) is refused with `winner_mismatch`.
--   * A round has at most one confirmed winner: winner_* columns are write-once.
--   * Finished games can be archived (archived_at) and expose per-round results.

-- ----------------------------------------------------------------- columns ----
alter table public.game_rounds
  add column if not exists winner_submission_id uuid references public.submissions (id) on delete set null,
  add column if not exists winner_rank_ms integer,
  add column if not exists winner_confirmed_at timestamptz;   -- set even for "no winner": the decision is final
alter table public.games add column if not exists archived_at timestamptz;

-- Hosts can no longer edit review state directly.
revoke update (status, points_awarded) on public.submissions from authenticated;

-- -------------------------------------------------------------- triggers ----
create or replace function public.enforce_round_update()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_status public.game_status;
begin
  if new.id <> old.id or new.game_id <> old.game_id then
    raise exception 'immutable round column' using errcode = '42501';
  end if;
  -- write-once winner: once confirmed (even "no winner") it can never change
  if old.winner_confirmed_at is not null and (
       new.winner_player_id is distinct from old.winner_player_id
    or new.winner_submission_id is distinct from old.winner_submission_id
    or new.winner_rank_ms is distinct from old.winner_rank_ms
    or new.winner_confirmed_at is distinct from old.winner_confirmed_at) then
    raise exception 'winner_already_confirmed' using errcode = 'P0001';
  end if;
  if new.status is distinct from old.status then
    if not ((old.status = 'pending' and new.status = 'open') or (old.status = 'open' and new.status = 'closed')) then
      raise exception 'invalid_round_transition' using errcode = 'P0001';
    end if;
    if new.status = 'open' then
      select status into v_status from public.games where id = new.game_id;
      if v_status <> 'live' then
        raise exception 'game_not_live' using errcode = 'P0001';
      end if;
      new.opened_at := now();
    else
      new.closed_at := now();
    end if;
  elsif old.status <> 'pending'
        and (new.prompt <> old.prompt or new.points <> old.points
             or new.time_limit_seconds <> old.time_limit_seconds or new.round_no <> old.round_no) then
    raise exception 'round_locked' using errcode = 'P0001';
  end if;
  return new;
end $$;

create or replace function public.enforce_submission_update()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_points integer;
  v_confirmed timestamptz;
begin
  if new.id <> old.id or new.game_id <> old.game_id or new.round_id <> old.round_id
     or new.player_id <> old.player_id or new.storage_path <> old.storage_path
     or new.submitted_at <> old.submitted_at then
    raise exception 'immutable submission column' using errcode = '42501';
  end if;
  select points, winner_confirmed_at into v_points, v_confirmed from public.game_rounds where id = old.round_id;
  if new.status is distinct from old.status and v_confirmed is not null then
    raise exception 'review_locked' using errcode = 'P0001';  -- backstop: decisions are final once the winner is official
  end if;
  if new.points_awarded > v_points then
    raise exception 'points exceed round value' using errcode = 'P0001';
  end if;
  if new.status is distinct from old.status then new.reviewed_at := now(); end if;
  return new;
end $$;

-- Game trigger = Phase 7 version + archive support for closed games.
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
    -- closed games are frozen; only archiving (and the version bump that announces it) may change
    if new.title is distinct from old.title or new.max_players is distinct from old.max_players
       or new.phase is distinct from old.phase or new.current_round_id is distinct from old.current_round_id
       or new.countdown_ends_at is distinct from old.countdown_ends_at then
      raise exception 'game_is_closed' using errcode = 'P0001';
    end if;
    if new.archived_at is distinct from old.archived_at and (old.archived_at is not null or old.status <> 'finished') then
      raise exception 'invalid_transition' using errcode = 'P0001';
    end if;
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

-- --------------------------------------------------------------- review ----
-- Approve / disqualify / undo one submission of the CURRENT round of a game you own.
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
    perform public.bump_game_version(g.id);   -- every host/player view re-reads
  end if;
  return public.game_state_json(g.id, 'host');
end $$;


-- ---------------------------------------------------------------- results ----
create or replace function public.game_results_json(p_game uuid, p_player uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'no', r.round_no, 'prompt', r.prompt, 'decided', r.winner_confirmed_at is not null,
      'winnerName', pl.nickname, 'winnerMs', r.winner_rank_ms,
      'isMe', coalesce(p_player is not null and r.winner_player_id = p_player, false),
      'submissions', (select count(*) from public.submissions x where x.round_id = r.id)
    ) order by r.round_no), '[]'::jsonb)
  from public.game_rounds r
  left join public.players pl on pl.id = r.winner_player_id
  where r.game_id = p_game and r.status <> 'pending'
$$;

-- Host: per-round results with the winners' photo paths (signed by the handler).
create or replace function public.game_results(p_game uuid)
returns table (round_no integer, prompt text, winner_name text, winner_ms integer, winner_path text, submissions integer)
language sql stable security invoker set search_path = '' as $$
  select r.round_no, r.prompt, pl.nickname, r.winner_rank_ms, s.storage_path,
         (select count(*)::integer from public.submissions x where x.round_id = r.id)
  from public.game_rounds r
  left join public.players pl on pl.id = r.winner_player_id
  left join public.submissions s on s.id = r.winner_submission_id
  where r.game_id = p_game and r.status <> 'pending'
  order by r.round_no
$$;

-- Players: the winner's photo path, ONLY while the winner announcement is on screen.
create or replace function public.player_winner_photo(p_token_hash text)
returns text language sql stable security definer set search_path = '' as $$
  select s.storage_path
  from public.players p
  join public.games g on g.id = p.game_id
  join public.game_rounds r on r.id = g.current_round_id
  join public.submissions s on s.id = r.winner_submission_id
  where p.token_hash = p_token_hash and p.kicked_at is null
    and g.phase = 'winner_announced' and r.winner_confirmed_at is not null
$$;

-- ---------------------------------------------------------------- ranking ----
drop function if exists public.round_ranking(uuid, integer);
create or replace function public.round_ranking(p_round uuid, p_near_ms integer default 150)
returns table (
  submission_id uuid, rank integer, player_id uuid, nickname text, status text, rank_ms integer,
  claimed_elapsed_ms integer, server_elapsed_ms integer, timing_status text, timing_flags text[],
  near_tie boolean, is_leader boolean, submitted_at timestamptz, storage_path text
) language sql stable security invoker set search_path = '' as $$
  with ordered as (
    select s.*, pl.nickname as nick,
           row_number() over (order by s.rank_ms, s.server_elapsed_ms, s.submitted_at, s.id) as rn,
           (s.status <> 'rejected') as contender
    from public.submissions s
    join public.players pl on pl.id = s.player_id and pl.kicked_at is null   -- removed players are out
    where s.round_id = p_round
  )
  select o.id, o.rn::integer, o.player_id, o.nick, o.status::text, o.rank_ms, o.claimed_elapsed_ms, o.server_elapsed_ms,
         o.timing_status, o.timing_flags,
         -- close finishes are judged among submissions still in contention (not disqualified)
         case when o.contender then
           coalesce(o.rank_ms - lag(o.rank_ms) over w < p_near_ms, false)
           or coalesce(lead(o.rank_ms) over w - o.rank_ms < p_near_ms, false)
         else false end,
         -- the submission that WOULD win right now: fastest approved
         (o.status = 'approved' and not exists (select 1 from ordered x where x.status = 'approved' and x.rn < o.rn)),
         o.submitted_at, o.storage_path
  from ordered o
  window w as (partition by o.contender order by o.rn)
  order by o.rn
$$;

-- ------------------------------------------------------ snapshots + engine ----
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
      'no', r.round_no,
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
  if g.status = 'finished' then
    v := v || jsonb_build_object('results', public.game_results_json(g.id, p.id));
  end if;
  return v || jsonb_build_object(
    'gameId', g.id,
    'joinCode', g.join_code,
    'me', jsonb_build_object(
      'id', p.id,
      'nickname', p.nickname,
      'kicked', p.kicked_at is not null,
      'hasSubmitted', s.id is not null,
      'submission', case when s.id is null then null
                         else jsonb_build_object('elapsedMs', s.claimed_elapsed_ms, 'rankMs', s.rank_ms, 'timing', s.timing_status,
                              -- the review outcome is only revealed once the winner is official
                              'review', case when (select winner_confirmed_at from public.game_rounds where id = g.current_round_id) is not null
                                             then s.status::text end) end,
      'isWinner', exists (select 1 from public.game_rounds r
                           where r.id = g.current_round_id and r.winner_player_id = p.id)
    )
  );
end $$;

create or replace function public.game_transition(
  p_game uuid, p_action text, p_expected_version bigint, p_winner uuid default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  g public.games%rowtype;
  r public.game_rounds%rowtype;
  v_ver bigint;
  v_phase public.game_phase;
  v_win record;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  if p_action not in ('start_game', 'start_countdown', 'start_round', 'close_submissions',
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

-- ------------------------------------------------------------------ privileges ----
revoke all on function
  public.review_submission(uuid, text), public.game_results_json(uuid, uuid), public.game_results(uuid),
  public.player_winner_photo(text), public.round_ranking(uuid, integer),
  public.game_state_json(uuid, text), public.player_game_state(text), public.game_transition(uuid, text, bigint, uuid)
  from public, anon, authenticated;
grant execute on function public.review_submission(uuid, text), public.game_results(uuid),
  public.round_ranking(uuid, integer), public.game_transition(uuid, text, bigint, uuid) to authenticated;
grant execute on function public.game_results_json(uuid, uuid), public.player_winner_photo(text),
  public.game_state_json(uuid, text), public.player_game_state(text) to service_role;
