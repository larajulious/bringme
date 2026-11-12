-- BingoSnap: board drafts and the card editor (Phase 4). Additive; Bring Me is not touched.
--
--  * Drafts: a BingoSnap game can be saved as status 'draft' with empty squares.
--    It counts toward the plan's open-game limit like any game (existing trigger).
--  * A board can be published (draft -> lobby) or started only when COMPLETE: every
--    non-free square has an instruction and no two instructions are the same. A trigger
--    enforces this on every status change, whatever the caller.
--  * Editing is allowed while the game is draft or lobby (before Start game). Once the game
--    starts the board, mode and timer are locked, so every player gets the same challenges.
--  * board_revision: optimistic concurrency for board saves (a second tab can't silently
--    overwrite), independent of state_version, which also moves when players join.
--  * The free centre (odd boards, Traditional only) is never a photo challenge.
-- Revert: supabase/rollback/20261112000017_18_bingosnap_revert.sql (covers this file too).

-- ---------------------------------------------------------------- schema ----
-- Non-free squares may be empty (drafts only; the trigger below guards publishing/starting).
alter table public.bingo_cells drop constraint if exists bingo_cell_free_has_no_challenge;
alter table public.bingo_cells add constraint bingo_cell_free_has_no_challenge check (not is_free or challenge is null);
alter table public.bingo_games add column if not exists board_revision integer not null default 0;

-- null = publishable; otherwise the reason it isn't.
create or replace function public.bingo_board_problem(p_game uuid)
returns text language sql stable security definer set search_path = '' as $$
  select case
    when b.game_id is null then 'board_incomplete'
    when (select count(*) from public.bingo_cells c where c.game_id = p_game) <> b.board_size * b.board_size then 'invalid_board_dimensions'
    when exists (select 1 from public.bingo_cells c where c.game_id = p_game and not c.is_free and c.challenge is null) then 'board_incomplete'
    when (select count(distinct lower(c.challenge)) from public.bingo_cells c where c.game_id = p_game and not c.is_free)
         <> (select count(*) from public.bingo_cells c where c.game_id = p_game and not c.is_free) then 'duplicate_challenge'
    else null
  end
  from (select 1) one left join public.bingo_games b on b.game_id = p_game
$$;

create or replace function public.guard_bingosnap_board_complete()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_problem text;
begin
  if new.game_type = 'bingosnap' and new.status in ('lobby', 'live') and new.status is distinct from old.status then
    v_problem := public.bingo_board_problem(new.id);
    if v_problem is not null then
      raise exception '%', v_problem using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists guard_bingosnap_board_complete on public.games;
create trigger guard_bingosnap_board_complete before update of status on public.games
  for each row execute function public.guard_bingosnap_board_complete();

-- ----------------------------------------------------------------- saving ----
-- Create (p_game null) or update a BingoSnap board; optionally publish it (draft -> lobby).
-- p_cells: one entry per board position, row-major (length = size²); '' / null = empty square;
--          the free centre's entry must be empty. Positions are implicit, so none can repeat.
-- Drafts may be incomplete and contain duplicates; lobby games and publishing need a complete board.
create or replace function public.bingo_save_board(
  p_game uuid, p_expected_revision integer, p_title text, p_board_size integer, p_win_mode text,
  p_free_space boolean, p_duration_seconds integer, p_winner_rule text, p_cells text[], p_publish boolean default false
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  g public.games%rowtype;
  b public.bingo_games%rowtype;
  v_id uuid;
  v_title text := coalesce(nullif(btrim(p_title), ''), 'BingoSnap');
  v_free boolean := coalesce(p_free_space, false);
  v_items text[];
  v_center integer;
  v_pos integer;
  v_problem text;
  v_status public.game_status;
  v_ver bigint;
  v_phase public.game_phase;
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
  if p_cells is null or cardinality(p_cells) <> p_board_size * p_board_size then
    raise exception 'invalid_board_dimensions' using errcode = 'P0001';
  end if;
  select array_agg(nullif(btrim(t.c), '') order by t.o) into v_items from unnest(p_cells) with ordinality t(c, o);
  if exists (select 1 from unnest(v_items) c where char_length(c) > 120) then
    raise exception 'invalid_challenge' using errcode = 'P0001';
  end if;
  v_center := public.bingo_center(p_board_size, v_free);
  if v_center is not null and v_items[v_center + 1] is not null then
    raise exception 'free_cell_not_editable' using errcode = 'P0001';
  end if;

  if p_game is null then
    -- New draft: the EXISTING games triggers check the Game Pass and the open-game / period limits.
    insert into public.games (owner_id, title, game_type)
    values (auth.uid(), v_title, 'bingosnap')
    returning public.games.id into v_id;
    insert into public.bingo_games (game_id, board_size, win_mode, free_space, winner_rule, duration_seconds)
    values (v_id, p_board_size, p_win_mode::public.bingo_win_mode, v_free,
            coalesce(p_winner_rule, 'ranked')::public.bingo_winner_rule, p_duration_seconds);
    v_status := 'draft';
  else
    select * into g from public.games
     where id = p_game and owner_id = auth.uid() and game_type = 'bingosnap' for update;
    if not found then raise exception 'game_not_found' using errcode = 'P0001'; end if;
    if g.status not in ('draft', 'lobby') then
      raise exception 'board_locked' using errcode = 'P0001';   -- started (or closed): same board for everyone
    end if;
    select * into b from public.bingo_games where game_id = g.id for update;
    if p_expected_revision is null or b.board_revision <> p_expected_revision then
      raise exception 'stale_board' using errcode = 'P0001';
    end if;
    v_id := g.id;
    v_status := g.status;
    if g.title is distinct from v_title then
      update public.games set title = v_title where id = g.id;
    end if;
    update public.bingo_games
       set board_size = p_board_size, win_mode = p_win_mode::public.bingo_win_mode, free_space = v_free,
           winner_rule = coalesce(p_winner_rule, 'ranked')::public.bingo_winner_rule,
           duration_seconds = p_duration_seconds, board_revision = board_revision + 1
     where game_id = g.id;
    -- No claims can exist before the game starts, so the squares are simply rewritten.
    delete from public.bingo_cells where game_id = g.id;
  end if;

  for v_pos in 0 .. p_board_size * p_board_size - 1 loop
    insert into public.bingo_cells (game_id, row_no, col_no, display_order, challenge, is_free)
    values (v_id, v_pos / p_board_size, v_pos % p_board_size, v_pos,
            case when v_pos is not distinct from v_center then null else v_items[v_pos + 1] end,
            v_pos is not distinct from v_center);   -- v_center is null when there is no free centre
  end loop;

  if p_publish or v_status = 'lobby' then
    v_problem := public.bingo_board_problem(v_id);
    if v_problem is not null then
      raise exception '%', v_problem using errcode = 'P0001';   -- nothing above is kept
    end if;
  end if;

  if p_publish and v_status = 'draft' then
    perform set_config('bingosnap.engine', 'on', true);
    update public.games set status = 'lobby' where id = v_id;   -- existing trigger re-checks the Game Pass
    perform set_config('bingosnap.engine', 'off', true);
    select state_version, phase into v_ver, v_phase from public.games where id = v_id;
    perform public.broadcast_game(v_id, v_ver, v_phase);
  else
    perform public.bump_game_version(v_id);
  end if;

  return public.bingo_state_json(v_id, 'host')
      || jsonb_build_object('boardRevision', (select board_revision from public.bingo_games where game_id = v_id));
end $$;

-- Host snapshot now also carries the board revision (for saving).
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
  return public.bingo_state_json(p_game, p_view)
      || jsonb_build_object('boardRevision', (select board_revision from public.bingo_games where game_id = p_game));
end $$;

-- --------------------------------------------------------------- privileges ----
revoke all on function
  public.bingo_board_problem(uuid),
  public.guard_bingosnap_board_complete(),
  public.bingo_save_board(uuid, integer, text, integer, text, boolean, integer, text, text[], boolean)
  from public, anon, authenticated;
grant execute on function
  public.bingo_save_board(uuid, integer, text, integer, text, boolean, integer, text, text[], boolean)
  to authenticated;
-- bingo_host_state keeps its grants (create or replace keeps privileges).
