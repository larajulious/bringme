-- Host can REPLAY a round whose photos were stopped too early (e.g. by accident), before its winner is announced.
-- A closed round never reopens (enforce_round_update forbids closed -> open, and photo timing is measured from
-- its opened_at), so the replay is a fresh copy of the round placed right after it:
--   * the stopped round is closed as "no winner" and marked replayed_at (its photos and reviews stay as they were),
--   * a copy with the same item, time limit and points is inserted as the next round (later rounds move down one),
--   * the copy starts straight away with a new 3-2-1 (same rules as start_countdown + start_round).
-- A replayed round does not count toward the plan's round limit, so fixing a mistake never costs a round.

alter table public.game_rounds add column if not exists replayed_at timestamptz;
-- No client grant on the new column: only replay_round() sets it.

-- Round limit: same as 20261112000023, but replayed rounds are not counted.
create or replace function public.enforce_round_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_game record;
  v_ent record;
  v_count integer;
begin
  select * into v_game from public.games where id = new.game_id;
  if v_game.status not in ('draft', 'lobby', 'live') then
    raise exception 'rounds can only be added before the game ends' using errcode = 'P0001';
  end if;
  new.status := 'pending'; new.opened_at := null; new.closed_at := null; new.replayed_at := null;
  if not public.is_admin_user(v_game.owner_id) then
    select * into v_ent from public.entitlement_for(v_game.owner_id);
    if v_ent is null then
      raise exception 'subscription_required' using errcode = 'P0001';
    end if;
    select count(*) into v_count from public.game_rounds where game_id = new.game_id and replayed_at is null;
    if v_count >= v_ent.max_rounds_per_game then
      raise exception 'round_limit_reached' using errcode = 'P0001';
    end if;
  end if;
  return new;
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

  -- 3) Start it: 3-2-1, then the round opens when the countdown ends (as start_countdown + start_round).
  update public.games
     set phase = 'countdown', current_round_id = v_new, countdown_ends_at = clock_timestamp() + interval '3 seconds'
   where id = g.id;
  update public.game_rounds set status = 'open' where id = v_new;
  update public.game_rounds set opened_at = clock_timestamp() + interval '3 seconds' where id = v_new;
  update public.games set phase = 'active', state_version = state_version + 1, phase_changed_at = clock_timestamp()
   where id = g.id returning state_version, phase into v_ver, v_phase;
  perform public.broadcast_game(g.id, v_ver, v_phase);

  return public.game_state_json(g.id, 'host') || jsonb_build_object('joinCode', g.join_code);
end $$;

-- Replayed rounds are invisible to everyone: not counted in "Round n of N", numbered as if they never happened,
-- and left out of the results. Copies of 20261111000011 with only those changes (same signatures, grants kept).
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

create or replace function public.game_results_json(p_game uuid, p_player uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'no', (select count(*) from public.game_rounds x where x.game_id = p_game and x.round_no <= r.round_no and x.replayed_at is null), 'prompt', r.prompt, 'decided', r.winner_confirmed_at is not null,
      'winnerName', pl.nickname, 'winnerMs', r.winner_rank_ms,
      'isMe', coalesce(p_player is not null and r.winner_player_id = p_player, false),
      'submissions', (select count(*) from public.submissions x where x.round_id = r.id)
    ) order by r.round_no), '[]'::jsonb)
  from public.game_rounds r
  left join public.players pl on pl.id = r.winner_player_id
  where r.game_id = p_game and r.status <> 'pending' and r.replayed_at is null
$$;

create or replace function public.game_results(p_game uuid)
returns table (round_no integer, prompt text, winner_name text, winner_ms integer, winner_path text, submissions integer)
language sql stable security invoker set search_path = '' as $$
  select (row_number() over (order by r.round_no))::integer, r.prompt, pl.nickname, r.winner_rank_ms, s.storage_path,
         (select count(*)::integer from public.submissions x where x.round_id = r.id)
  from public.game_rounds r
  left join public.players pl on pl.id = r.winner_player_id
  left join public.submissions s on s.id = r.winner_submission_id
  where r.game_id = p_game and r.status <> 'pending' and r.replayed_at is null
  order by r.round_no
$$;

revoke all on function public.replay_round(uuid, bigint) from public, anon;
grant execute on function public.replay_round(uuid, bigint) to authenticated;
