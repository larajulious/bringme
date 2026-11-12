-- BingoSnap (Extra Fun) 4: joining and the lobby. Additive only; Bring Me functions are untouched.
-- Revert (not a migration): supabase/rollback/20261112000017_18_bingosnap_revert.sql
--
-- Joining needs NO new write path: participants join with the existing join_game() (same guest
-- cookie, same token-hash identity, same "restore on refresh") and the existing
-- enforce_player_insert trigger, which locks the game row and checks game_capacity() (the
-- host's current Game Pass cap), so concurrent joins can never pass the limit.
-- This migration adds only reads for the join page and one atomic "start" for the host.

-- ------------------------------------------------------------ room info ----
-- Public facts behind a room code, for the join page (service role only, like public_room_info).
-- Bring Me rooms report only their type, so the existing page handles them unchanged.
-- A draft reveals nothing about its board; challenges are never included.
create or replace function public.bingo_room_info(p_code text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when g.game_type = 'bingosnap' then
           jsonb_build_object(
             'gameType', 'bingosnap',
             'title', g.title,
             'status', g.status,
             'playerCount', (select count(*) from public.players p where p.game_id = g.id and p.kicked_at is null),
             'maxPlayers', public.game_capacity(g.id),
             'board', case when g.status <> 'draft' then jsonb_build_object(
                 'size', b.board_size, 'winMode', b.win_mode, 'freeSpace', b.free_space,
                 'winnerRule', b.winner_rule, 'durationSeconds', b.duration_seconds) end)
         else jsonb_build_object('gameType', g.game_type, 'status', g.status) end
    from public.games g
    left join public.bingo_games b on b.game_id = g.id
   where g.join_code = upper(p_code)
$$;

-- --------------------------------------------------------- player state ----
-- Same as 20261112000018, plus the room code (the lobby URL is checked against it).
create or replace function public.bingo_player_state(p_token_hash text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  p public.players%rowtype;
  v_code text;
begin
  select * into p from public.players where token_hash = p_token_hash;
  if not found then return null; end if;
  select g.join_code into v_code from public.games g where g.id = p.game_id and g.game_type = 'bingosnap';
  if not found then
    raise exception 'wrong_game_type' using errcode = 'P0001';
  end if;
  return public.bingo_state_json(p.game_id, 'player', p.id) || jsonb_build_object('joinCode', v_code);
end $$;

-- ---------------------------------------------------------------- start ----
-- One click, one transaction: start_game (owner, version, >= 1 player, the CURRENT pass must
-- cover everyone: Game Pass D-9) -> start_countdown (3 s) -> start_hunt (opens at the end of
-- the countdown). Every rule stays in bingo_transition(); a refusal at any step changes nothing.
-- Taking the row lock in start_game also closes the lobby atomically: a join racing the start
-- either commits first (and is counted by the pass check) or sees 'live' and is refused.
create or replace function public.bingo_start(p_game uuid, p_expected_version bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v jsonb;
begin
  v := public.bingo_transition(p_game, 'start_game', p_expected_version);
  v := public.bingo_transition(p_game, 'start_countdown', (v ->> 'version')::bigint);
  v := public.bingo_transition(p_game, 'start_hunt', (v ->> 'version')::bigint);
  return v;
end $$;

-- ------------------------------------------------------------ privileges ----
revoke all on function
  public.bingo_room_info(text),
  public.bingo_player_state(text),
  public.bingo_start(uuid, bigint)
  from public, anon, authenticated;
grant execute on function public.bingo_start(uuid, bigint) to authenticated;
grant execute on function public.bingo_room_info(text), public.bingo_player_state(text) to service_role;
