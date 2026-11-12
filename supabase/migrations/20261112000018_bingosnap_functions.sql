-- BingoSnap (Extra Fun) 2/2: engine functions. Additive only; no existing function is redefined.
--
-- Host (authenticated, ownership checked inside):
--   create_bingosnap_game, bingo_transition, bingo_update_settings, bingo_review_submission, bingo_host_state
-- Guest (service role only, identity = the session token HASH from the HttpOnly cookie):
--   bingo_player_state, bingo_submit_claim
-- Everything else is internal (no client EXECUTE).
--
-- Timer: authoritative timestamps on the database clock (bingo_games.hunt_started_at / hunt_ends_at).
-- No cron: an expired hunt is "settled" (phase active -> reviewing) by the next engine call,
-- and snapshots report huntOver from the clock. Claims get a 2 s grace after the deadline.
-- Status vocabulary in snapshots: draft | lobby | active | completed | cancelled
-- (= games.status draft | lobby | live | finished | canceled).

-- ------------------------------------------------------------------ helpers ----
create or replace function public.bingo_center(p_size integer, p_free boolean)
returns integer language sql immutable set search_path = '' as $$
  select case when p_free and p_size % 2 = 1 then (p_size * p_size) / 2 end
$$;

-- Each participant's own order of the challenges: the non-free cells, shuffled by
-- md5(seed || player || cell), placed on the board's non-free positions; the free
-- space stays in the centre. Deterministic, so it never changes for that player.
create or replace function public.bingo_layout(p_game uuid, p_player uuid)
returns table (pos smallint, row_no smallint, col_no smallint, cell_id uuid, challenge text, is_free boolean)
language sql stable security definer set search_path = '' as $$
  with seed as (select b.layout_seed::text s from public.bingo_games b where b.game_id = p_game),
  slots as (
    select c.display_order, c.row_no, c.col_no, row_number() over (order by c.display_order) rn
      from public.bingo_cells c where c.game_id = p_game and not c.is_free),
  shuffled as (
    select c.id, c.challenge,
           row_number() over (order by md5((select s from seed) || p_player::text || c.id::text), c.id) rn
      from public.bingo_cells c where c.game_id = p_game and not c.is_free)
  select sl.display_order, sl.row_no, sl.col_no, sh.id, sh.challenge, false
    from slots sl join shuffled sh on sh.rn = sl.rn
  union all
  select c.display_order, c.row_no, c.col_no, c.id, null::text, true
    from public.bingo_cells c where c.game_id = p_game and c.is_free
  order by 1
$$;

-- Which pattern a set of board positions forms (null = not a legal claim).
-- traditional: EXACTLY one complete row, column or diagonal (the free centre counts
-- as marked and must not be sent). full_card: every non-free position.
create or replace function public.bingo_pattern(
  p_size integer, p_mode public.bingo_win_mode, p_free_pos integer, p_positions integer[]
) returns text language plpgsql immutable set search_path = '' as $$
declare
  v_claim integer[];
  v_line integer[];
  k integer;
begin
  if p_positions is null or cardinality(p_positions) = 0 then return null; end if;
  select array_agg(distinct x order by x) into v_claim from unnest(p_positions) x;
  if cardinality(v_claim) <> cardinality(p_positions) then return null; end if;     -- duplicates
  if p_free_pos is not null and p_free_pos = any (v_claim) then return null; end if;

  if p_mode = 'full_card' then
    select array_agg(x order by x) into v_line
      from generate_series(0, p_size * p_size - 1) x where x is distinct from p_free_pos;
    return case when v_claim = v_line then 'full' end;
  end if;

  for k in 0 .. p_size - 1 loop
    select array_agg(x order by x) into v_line
      from generate_series(k * p_size, k * p_size + p_size - 1) x where x is distinct from p_free_pos;
    if v_claim = v_line then return 'row:' || k; end if;
    select array_agg(x order by x) into v_line
      from (select i * p_size + k x from generate_series(0, p_size - 1) i) s where x is distinct from p_free_pos;
    if v_claim = v_line then return 'col:' || k; end if;
  end loop;
  select array_agg(x order by x) into v_line
    from (select i * p_size + i x from generate_series(0, p_size - 1) i) s where x is distinct from p_free_pos;
  if v_claim = v_line then return 'diag:main'; end if;
  select array_agg(x order by x) into v_line
    from (select i * p_size + (p_size - 1 - i) x from generate_series(0, p_size - 1) i) s where x is distinct from p_free_pos;
  if v_claim = v_line then return 'diag:anti'; end if;
  return null;
end $$;

-- Verified claims of participants still in the game, earliest received first.
create or replace function public.bingo_ranking(p_game uuid)
returns table (rank integer, submission_id uuid, player_id uuid, nickname text, submitted_at timestamptz, pattern text)
language sql stable security definer set search_path = '' as $$
  select (row_number() over (order by s.submitted_at, s.id))::integer, s.id, s.player_id, p.nickname, s.submitted_at, s.pattern
    from public.bingo_submissions s
    join public.players p on p.id = s.player_id and p.kicked_at is null
   where s.game_id = p_game and s.status = 'verified'
   order by s.submitted_at, s.id
$$;

-- Move an expired hunt to review. Caller holds the game row lock and the engine flag.
create or replace function public.bingo_settle(p_game uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.games g
     set phase = 'reviewing', state_version = g.state_version + 1, phase_changed_at = clock_timestamp()
    from public.bingo_games b
   where g.id = p_game and b.game_id = g.id and g.status = 'live' and g.phase = 'active'
     and clock_timestamp() > b.hunt_ends_at + interval '2 seconds';
  return found;
end $$;

create or replace function public.bingo_results_json(p_game uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'winnerRule', b.winner_rule,
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object('rank', r.rank, 'playerId', r.player_id, 'nickname', r.nickname,
                                          'submittedAt', r.submitted_at, 'pattern', r.pattern) order by r.rank)
        from public.bingo_ranking(p_game) r
       where b.winner_rule = 'ranked' or r.rank = 1), '[]'::jsonb))
  from public.bingo_games b where b.game_id = p_game
$$;

-- ---------------------------------------------------------------- snapshots ----
-- viewer: 'host' | 'presenter' (both: the signed-in owner) | 'player' (p_player required).
-- Players see their OWN layout (only once the hunt has started) and their OWN claims;
-- other participants' claims only as announced results.
create or replace function public.bingo_state_json(p_game uuid, p_viewer text, p_player uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  g public.games%rowtype;
  b public.bingo_games%rowtype;
  p public.players%rowtype;
  v jsonb;
  v_now timestamptz := clock_timestamp();
  v_started boolean;
  v_attempts integer;
  v_open boolean;
begin
  select * into g from public.games where id = p_game and game_type = 'bingosnap';
  if not found then return null; end if;
  select * into b from public.bingo_games where game_id = p_game;
  v_started := b.hunt_started_at is not null and b.hunt_started_at <= v_now;

  v := jsonb_build_object(
    'gameId', g.id,
    'gameType', 'bingosnap',
    'title', g.title,
    'version', g.state_version,
    'serverNow', v_now,
    'status', case g.status when 'draft' then 'draft' when 'lobby' then 'lobby' when 'live' then 'active'
                            when 'finished' then 'completed' else 'cancelled' end,
    'lifecycle', g.status,
    'phase', g.phase,
    'countdownEndsAt', g.countdown_ends_at,
    'playerCount', (select count(*) from public.players x where x.game_id = g.id and x.kicked_at is null),
    'maxPlayers', public.game_capacity(g.id),
    'archivedAt', g.archived_at,
    'board', jsonb_build_object(
      'size', b.board_size, 'winMode', b.win_mode, 'winnerRule', b.winner_rule, 'freeSpace', b.free_space,
      'durationSeconds', b.duration_seconds, 'huntStartedAt', b.hunt_started_at, 'huntEndsAt', b.hunt_ends_at,
      'huntOver', b.hunt_ends_at is not null and v_now > b.hunt_ends_at, 'resultsAt', b.results_at),
    'counts', (select jsonb_build_object(
        'pending', count(*) filter (where s.status = 'pending'),
        'verified', count(*) filter (where s.status = 'verified'),
        'rejected', count(*) filter (where s.status = 'rejected'))
      from public.bingo_submissions s join public.players x on x.id = s.player_id and x.kicked_at is null
      where s.game_id = g.id),
    'results', case when b.results_at is not null then public.bingo_results_json(g.id) end
  );

  if p_viewer in ('host', 'presenter') then
    return v || jsonb_build_object(
      'joinCode', g.join_code,
      -- the presenter (a public screen) gets the challenges only once the hunt starts
      'cells', case when p_viewer = 'host' or v_started then (
        select jsonb_agg(jsonb_build_object('id', c.id, 'row', c.row_no, 'col', c.col_no, 'order', c.display_order,
                                            'challenge', c.challenge, 'isFree', c.is_free) order by c.display_order)
          from public.bingo_cells c where c.game_id = g.id) end,
      'players', (select coalesce(jsonb_agg(jsonb_build_object(
            'id', x.id, 'nickname', x.nickname, 'joinedAt', x.joined_at,
            'state', case when x.kicked_at is null then 'active' else 'removed' end) order by x.joined_at, x.id), '[]'::jsonb)
          from public.players x where x.game_id = g.id and (p_viewer = 'host' or x.kicked_at is null)),
      'submissions', (select coalesce(jsonb_agg(jsonb_build_object(
            'id', s.id, 'playerId', s.player_id, 'nickname', x.nickname, 'playerRemoved', x.kicked_at is not null,
            'attempt', s.attempt_no, 'status', s.status, 'pattern', s.pattern,
            'submittedAt', s.submitted_at, 'validatedAt', s.validated_at,
            'rejectionReason', case when p_viewer = 'host' then s.rejection_reason end,
            'cells', case when p_viewer = 'host' then (
                select jsonb_agg(jsonb_build_object('id', c.id, 'challenge', c.challenge) order by c.display_order)
                  from public.bingo_cells c where c.id = any (s.cell_ids)) end,
            'rank', r.rank) order by s.submitted_at, s.id), '[]'::jsonb)
          from public.bingo_submissions s
          join public.players x on x.id = s.player_id
          left join public.bingo_ranking(g.id) r on r.submission_id = s.id
         where s.game_id = g.id and (p_viewer = 'host' or x.kicked_at is null))
    );
  end if;

  if p_viewer = 'player' then
    select * into p from public.players where id = p_player and game_id = g.id;
    if not found then return null; end if;
    select count(*), bool_or(s.status in ('pending', 'verified')) into v_attempts, v_open
      from public.bingo_submissions s where s.player_id = p.id;
    return v || jsonb_build_object('me', jsonb_build_object(
      'id', p.id,
      'nickname', p.nickname,
      'joinedAt', p.joined_at,
      'state', case when p.kicked_at is null then 'active' else 'removed' end,
      'layout', case when v_started and p.kicked_at is null then (
          select jsonb_agg(jsonb_build_object('pos', l.pos, 'row', l.row_no, 'col', l.col_no, 'cellId', l.cell_id,
                                              'challenge', l.challenge, 'isFree', l.is_free) order by l.pos)
            from public.bingo_layout(g.id, p.id) l) end,
      'submissions', (select coalesce(jsonb_agg(jsonb_build_object(
            'id', s.id, 'attempt', s.attempt_no, 'status', s.status, 'pattern', s.pattern, 'cellIds', to_jsonb(s.cell_ids),
            'submittedAt', s.submitted_at, 'validatedAt', s.validated_at, 'rejectionReason', s.rejection_reason)
            order by s.attempt_no), '[]'::jsonb)
          from public.bingo_submissions s where s.player_id = p.id),
      'attemptsLeft', 5 - v_attempts,
      'canClaim', p.kicked_at is null and g.status = 'live' and g.phase = 'active' and v_started
                  and v_now <= b.hunt_ends_at + interval '2 seconds' and not coalesce(v_open, false) and v_attempts < 5
    ));
  end if;
  return null;
end $$;

-- --------------------------------------------------------------- creation ----
-- Runs as the signed-in host. The games insert goes through the EXISTING triggers:
-- Game Pass required, open-game and per-period limits, room capacity = pass cap.
create or replace function public.create_bingosnap_game(
  p_title text, p_board_size integer, p_win_mode text, p_free_space boolean,
  p_duration_seconds integer, p_winner_rule text, p_challenges text[]
) returns table (game_id uuid, code text)
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_code text;
  v_title text := coalesce(nullif(btrim(p_title), ''), 'BingoSnap');
  v_free boolean := coalesce(p_free_space, false);
  v_items text[];
  v_needed integer;
  v_center integer;
  v_i integer := 0;
  v_pos integer;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  if char_length(v_title) > 80 then raise exception 'invalid_title' using errcode = 'P0001'; end if;
  if p_board_size is null or p_board_size not in (3, 4, 5) then
    raise exception 'invalid_board_size' using errcode = 'P0001';
  end if;
  if p_win_mode is null or p_win_mode not in ('traditional', 'full_card') then
    raise exception 'invalid_win_mode' using errcode = 'P0001';
  end if;
  if coalesce(p_winner_rule, 'ranked') not in ('ranked', 'first') then
    raise exception 'invalid_winner_rule' using errcode = 'P0001';
  end if;
  if v_free and (p_board_size % 2 = 0 or p_win_mode <> 'traditional') then
    raise exception 'free_space_not_allowed' using errcode = 'P0001';
  end if;
  if p_duration_seconds is null or p_duration_seconds not between 180 and 7200 then
    raise exception 'invalid_duration' using errcode = 'P0001';
  end if;

  select array_agg(btrim(t.c) order by t.o) into v_items from unnest(p_challenges) with ordinality t(c, o);
  v_needed := p_board_size * p_board_size - case when v_free then 1 else 0 end;
  if coalesce(cardinality(v_items), 0) <> v_needed then
    raise exception 'wrong_challenge_count' using errcode = 'P0001';
  end if;
  if exists (select 1 from unnest(v_items) c where c is null or c = '' or char_length(c) > 120) then
    raise exception 'invalid_challenge' using errcode = 'P0001';
  end if;
  if (select count(distinct lower(c)) from unnest(v_items) c) <> v_needed then
    raise exception 'duplicate_challenge' using errcode = 'P0001';
  end if;

  insert into public.games (owner_id, title, game_type)
  values (auth.uid(), v_title, 'bingosnap')
  returning public.games.id, public.games.join_code into v_id, v_code;

  insert into public.bingo_games (game_id, board_size, win_mode, free_space, winner_rule, duration_seconds)
  values (v_id, p_board_size, p_win_mode::public.bingo_win_mode, v_free,
          coalesce(p_winner_rule, 'ranked')::public.bingo_winner_rule, p_duration_seconds);

  v_center := public.bingo_center(p_board_size, v_free);
  for v_pos in 0 .. p_board_size * p_board_size - 1 loop
    if v_pos = v_center then
      insert into public.bingo_cells (game_id, row_no, col_no, display_order, challenge, is_free)
      values (v_id, v_pos / p_board_size, v_pos % p_board_size, v_pos, null, true);
    else
      v_i := v_i + 1;
      insert into public.bingo_cells (game_id, row_no, col_no, display_order, challenge, is_free)
      values (v_id, v_pos / p_board_size, v_pos % p_board_size, v_pos, v_items[v_i], false);
    end if;
  end loop;

  perform set_config('bingosnap.engine', 'on', true);
  update public.games set status = 'lobby' where id = v_id;   -- existing trigger re-checks the pass
  perform set_config('bingosnap.engine', 'off', true);

  return query select v_id, v_code;
end $$;

-- ------------------------------------------------------------ state machine ----
-- The ONLY way to change a BingoSnap game's status/phase. Same conventions as
-- game_transition: owner + row lock + required expected version (stale_state).
create or replace function public.bingo_transition(
  p_game uuid, p_action text, p_expected_version bigint, p_winner_submission uuid default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  g public.games%rowtype;
  b public.bingo_games%rowtype;
  v_now timestamptz;
  v_cap integer;
  v_lead record;
  v_ver bigint;
  v_phase public.game_phase;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  if p_action is null or p_action not in ('start_game', 'start_countdown', 'start_hunt', 'close_hunt',
                                          'announce_results', 'end_game', 'cancel', 'archive') then
    raise exception 'invalid_action' using errcode = 'P0001';
  end if;

  select * into g from public.games
   where id = p_game and owner_id = auth.uid() and game_type = 'bingosnap' for update;
  if not found then
    raise exception 'game_not_found' using errcode = 'P0001';
  end if;
  if p_expected_version is null or g.state_version <> p_expected_version then
    raise exception 'stale_state' using errcode = 'P0001';
  end if;
  select * into b from public.bingo_games where game_id = g.id for update;

  perform set_config('bingosnap.engine', 'on', true);
  if public.bingo_settle(g.id) then
    select * into g from public.games where id = g.id;
  end if;
  v_now := clock_timestamp();

  if p_action = 'start_game' then
    if g.status <> 'lobby' then raise exception 'invalid_transition' using errcode = 'P0001'; end if;
    if not exists (select 1 from public.players where game_id = g.id and kicked_at is null) then
      raise exception 'no_players' using errcode = 'P0001';
    end if;
    -- Same rule as Bring Me (Game Pass D-9): the CURRENT pass must cover everyone in the room.
    if not public.is_admin_user(g.owner_id) then
      select e.max_players_per_game into v_cap from public.pass_entitlement(g.owner_id) e;
      if v_cap is null then
        raise exception 'subscription_required' using errcode = 'P0001';
      end if;
      v_cap := least(g.max_players, v_cap);
      if (select count(*) from public.players where game_id = g.id and kicked_at is null) > v_cap then
        raise exception 'player_limit_exceeded' using errcode = 'P0001';
      end if;
      update public.games set status = 'live', max_players = v_cap where id = g.id;
    else
      update public.games set status = 'live' where id = g.id;
    end if;

  elsif p_action = 'start_countdown' then
    if g.status <> 'live' or g.phase <> 'lobby' then
      raise exception 'invalid_transition' using errcode = 'P0001';
    end if;
    -- D-10: no entitlement re-check once live; the game may finish after the pass ends.
    update public.games set phase = 'countdown', countdown_ends_at = v_now + interval '3 seconds' where id = g.id;

  elsif p_action = 'start_hunt' then
    if g.phase <> 'countdown' then raise exception 'invalid_transition' using errcode = 'P0001'; end if;
    update public.bingo_games
       set hunt_started_at = greatest(v_now, g.countdown_ends_at),
           hunt_ends_at = greatest(v_now, g.countdown_ends_at) + make_interval(secs => b.duration_seconds)
     where game_id = g.id;
    update public.games set phase = 'active' where id = g.id;

  elsif p_action = 'close_hunt' then
    if g.phase <> 'active' then raise exception 'invalid_transition' using errcode = 'P0001'; end if;
    if v_now < b.hunt_started_at then raise exception 'hunt_not_started' using errcode = 'P0001'; end if;
    update public.bingo_games set hunt_ends_at = least(hunt_ends_at, v_now) where game_id = g.id;
    update public.games set phase = 'reviewing' where id = g.id;

  elsif p_action = 'announce_results' then
    if g.status <> 'live' or g.phase <> 'reviewing' then
      raise exception 'invalid_transition' using errcode = 'P0001';
    end if;
    -- Computed here, never taken from the caller: p_winner_submission only CONFIRMS what the host saw.
    select r.submission_id, r.submitted_at into v_lead from public.bingo_ranking(g.id) r where r.rank = 1;
    if p_winner_submission is distinct from v_lead.submission_id then
      raise exception 'winner_mismatch' using errcode = 'P0001';
    end if;
    -- A claim received before the leader is still unreviewed: it could still take first place.
    if exists (select 1 from public.bingo_submissions s
                 join public.players x on x.id = s.player_id and x.kicked_at is null
                where s.game_id = g.id and s.status = 'pending'
                  and (v_lead.submission_id is null
                       or (s.submitted_at, s.id) < (v_lead.submitted_at, v_lead.submission_id))) then
      raise exception 'earlier_claim_pending' using errcode = 'P0001';
    end if;
    update public.bingo_games set results_at = v_now where game_id = g.id;
    update public.games set phase = 'winner_announced' where id = g.id;

  elsif p_action = 'end_game' then
    if g.status <> 'live' then raise exception 'invalid_transition' using errcode = 'P0001'; end if;
    update public.bingo_games set results_at = coalesce(results_at, v_now) where game_id = g.id;
    update public.games set status = 'finished' where id = g.id;

  elsif p_action = 'cancel' then
    if g.status not in ('draft', 'lobby', 'live') then
      raise exception 'invalid_transition' using errcode = 'P0001';
    end if;
    update public.games set status = 'canceled' where id = g.id;

  elsif p_action = 'archive' then
    if g.status <> 'finished' or g.archived_at is not null then
      raise exception 'invalid_transition' using errcode = 'P0001';
    end if;
    update public.games set archived_at = v_now where id = g.id;
  end if;

  select state_version, phase into v_ver, v_phase from public.games where id = g.id;
  if v_ver = g.state_version then
    update public.games set state_version = state_version + 1, phase_changed_at = clock_timestamp()
     where id = g.id returning state_version, phase into v_ver, v_phase;
  end if;
  perform set_config('bingosnap.engine', 'off', true);
  perform public.broadcast_game(g.id, v_ver, v_phase);
  return public.bingo_state_json(g.id, 'host');
end $$;

-- Winner rule (Ranked / First wins) may change until the hunt starts.
create or replace function public.bingo_update_settings(p_game uuid, p_expected_version bigint, p_winner_rule text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  g public.games%rowtype;
  b public.bingo_games%rowtype;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  if p_winner_rule is null or p_winner_rule not in ('ranked', 'first') then
    raise exception 'invalid_winner_rule' using errcode = 'P0001';
  end if;
  select * into g from public.games
   where id = p_game and owner_id = auth.uid() and game_type = 'bingosnap' for update;
  if not found then raise exception 'game_not_found' using errcode = 'P0001'; end if;
  if p_expected_version is null or g.state_version <> p_expected_version then
    raise exception 'stale_state' using errcode = 'P0001';
  end if;
  select * into b from public.bingo_games where game_id = g.id for update;
  if g.status not in ('draft', 'lobby', 'live') or b.hunt_started_at is not null then
    raise exception 'settings_locked' using errcode = 'P0001';
  end if;
  update public.bingo_games set winner_rule = p_winner_rule::public.bingo_winner_rule where game_id = g.id;
  perform public.bump_game_version(g.id);
  return public.bingo_state_json(g.id, 'host');
end $$;

-- ------------------------------------------------------------------- claims ----
-- Service role only. The participant is derived from the session token hash, never
-- from the request, so a participant can only ever claim for themselves.
-- Only cell ids are accepted: there is no parameter that could carry a photo.
create or replace function public.bingo_submit_claim(p_token_hash text, p_cell_ids uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  p public.players%rowtype;
  g public.games%rowtype;
  b public.bingo_games%rowtype;
  v_now timestamptz;
  v_attempts integer;
  v_positions integer[];
  v_cells uuid[];
  v_free integer;
  v_pattern text;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_session' using errcode = 'P0001';
  end if;
  select * into p from public.players where token_hash = p_token_hash;
  if not found then raise exception 'invalid_session' using errcode = 'P0001'; end if;

  -- Serialise all claims of this game (and against close_hunt / announce / end).
  select * into g from public.games where id = p.game_id for update;
  if g.game_type <> 'bingosnap' then raise exception 'wrong_game_type' using errcode = 'P0001'; end if;
  if p.kicked_at is not null then raise exception 'player_removed' using errcode = 'P0001'; end if;
  select * into b from public.bingo_games where game_id = g.id;

  perform set_config('bingosnap.engine', 'on', true);
  if public.bingo_settle(g.id) then
    select * into g from public.games where id = g.id;
  end if;
  perform set_config('bingosnap.engine', 'off', true);
  v_now := clock_timestamp();

  if g.status <> 'live' or g.phase in ('lobby', 'countdown') or b.hunt_started_at is null or v_now < b.hunt_started_at then
    if g.status in ('finished', 'canceled') then raise exception 'hunt_over' using errcode = 'P0001'; end if;
    raise exception 'hunt_not_active' using errcode = 'P0001';
  end if;
  if g.phase <> 'active' or v_now > b.hunt_ends_at + interval '2 seconds' then
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

  insert into public.bingo_submissions (game_id, player_id, attempt_no, cell_ids, pattern, submitted_at)
  values (g.id, p.id, v_attempts + 1, v_cells, v_pattern, v_now);

  perform public.bump_game_version(g.id);
  return public.bingo_state_json(g.id, 'player', p.id);
end $$;

-- ------------------------------------------------------------------- review ----
-- Owner only, while the game is live and results aren't frozen. Decisions are
-- state-checked (double clicks return already_reviewed instead of acting twice).
create or replace function public.bingo_review_submission(p_submission uuid, p_decision text, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s public.bingo_submissions%rowtype;
  g public.games%rowtype;
  b public.bingo_games%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_kicked timestamptz;
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
  perform public.bingo_settle(g.id);
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

  perform public.bump_game_version(g.id);
  return public.bingo_state_json(g.id, 'host');
end $$;

-- ----------------------------------------------------------------- readers ----
create or replace function public.bingo_host_state(p_game uuid, p_view text default 'host')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  if p_view is null or p_view not in ('host', 'presenter') then
    raise exception 'invalid_view' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.games where id = p_game and owner_id = auth.uid() and game_type = 'bingosnap') then
    raise exception 'game_not_found' using errcode = 'P0001';
  end if;
  return public.bingo_state_json(p_game, p_view);
end $$;

-- null = no such session. wrong_game_type = the session belongs to a Bring Me game.
create or replace function public.bingo_player_state(p_token_hash text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  p public.players%rowtype;
begin
  select * into p from public.players where token_hash = p_token_hash;
  if not found then return null; end if;
  if not exists (select 1 from public.games where id = p.game_id and game_type = 'bingosnap') then
    raise exception 'wrong_game_type' using errcode = 'P0001';
  end if;
  return public.bingo_state_json(p.game_id, 'player', p.id);
end $$;

-- --------------------------------------------------------------- privileges ----
revoke all on function
  public.bingo_center(integer, boolean),
  public.bingo_layout(uuid, uuid),
  public.bingo_pattern(integer, public.bingo_win_mode, integer, integer[]),
  public.bingo_ranking(uuid),
  public.bingo_settle(uuid),
  public.bingo_results_json(uuid),
  public.bingo_state_json(uuid, text, uuid),
  public.create_bingosnap_game(text, integer, text, boolean, integer, text, text[]),
  public.bingo_transition(uuid, text, bigint, uuid),
  public.bingo_update_settings(uuid, bigint, text),
  public.bingo_submit_claim(text, uuid[]),
  public.bingo_review_submission(uuid, text, text),
  public.bingo_host_state(uuid, text),
  public.bingo_player_state(text)
  from public, anon, authenticated;
grant execute on function
  public.create_bingosnap_game(text, integer, text, boolean, integer, text, text[]),
  public.bingo_transition(uuid, text, bigint, uuid),
  public.bingo_update_settings(uuid, bigint, text),
  public.bingo_review_submission(uuid, text, text),
  public.bingo_host_state(uuid, text)
  to authenticated;
grant execute on function public.bingo_submit_claim(text, uuid[]), public.bingo_player_state(text) to service_role;
