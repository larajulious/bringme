-- BingoSnap (Extra Fun) 5: reliable claims. Additive only; Bring Me is untouched.
-- Revert (not a migration): supabase/rollback/20261112000017_18_bingosnap_revert.sql
--
-- 1. Idempotent retries: the client sends a random request id per claim attempt. A repeat of the
--    same request (lost response, double tap, retry, a second tab replaying it) returns the current
--    state instead of creating a second claim or failing with claim_pending.
-- 2. The deadline is judged on ARRIVAL: statement_timestamp() (when the request reached the
--    database), not when the game-row lock was finally obtained. A claim that arrived in time but
--    queued behind others is still accepted; submitted_at (the queue order) is the arrival time too.
--    The 2 s grace (network delay) applies to the natural deadline only. close_hunt shortens
--    hunt_ends_at to the moment the host pressed it, and claims arriving after that are refused at
--    once (as before), while claims that arrived before it, even if they waited on its lock, still count.
-- Unchanged: membership via the token only, removed players, one open claim (unique index),
-- attempts ≤ 5, the pattern check, the 2 s grace, history (one row per attempt).

alter table public.bingo_submissions add column if not exists request_id uuid;
create unique index if not exists bingo_submissions_request
  on public.bingo_submissions (player_id, request_id) where request_id is not null;

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

  perform public.bump_game_version(g.id);
  return public.bingo_state_json(g.id, 'player', p.id);
end $$;

-- The original two-argument entry point keeps working, with the same rules (no replay detection).
create or replace function public.bingo_submit_claim(p_token_hash text, p_cell_ids uuid[])
returns jsonb language sql security definer set search_path = '' as $$
  select public.bingo_submit_claim(p_token_hash, p_cell_ids, null::uuid)
$$;

revoke all on function
  public.bingo_submit_claim(text, uuid[], uuid),
  public.bingo_submit_claim(text, uuid[])
  from public, anon, authenticated;
grant execute on function public.bingo_submit_claim(text, uuid[], uuid), public.bingo_submit_claim(text, uuid[]) to service_role;
