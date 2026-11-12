-- BringMe! Phase 6: guest joining and the waiting lobby.
-- All three functions are SERVICE-ROLE ONLY: guests have no database role; the
-- Next.js handlers authenticate them (join code / httpOnly token cookie) first.

-- Minimal public facts about a room, looked up by join code.
create or replace function public.public_room_info(p_code text)
returns table (title text, status public.game_status, player_count bigint, max_players integer)
language sql stable security definer set search_path = '' as $$
  select g.title, g.status,
         (select count(*) from public.players p where p.game_id = g.id and p.kicked_at is null),
         g.max_players
  from public.games g
  where g.join_code = upper(p_code)
$$;

-- Join or reconnect, atomically.
--  * p_existing_hash: hash of the token already in the visitor's cookie. If it
--    belongs to a player of THIS game, that player is restored (no duplicate).
--  * New players are inserted through the Phase 2 trigger, which locks the game
--    row, checks lobby/live status and enforces max_players.
--  * Display names are never credentials: identity is only ever the token hash.
create or replace function public.join_game(
  p_code text, p_nickname text, p_token_hash text, p_existing_hash text default null
) returns table (player_id uuid, nickname text, game_id uuid, restored boolean)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_game record;
  v_player record;
  v_id uuid;
begin
  select g.id as gid, g.status as gstatus into v_game
    from public.games g where g.join_code = upper(p_code);
  if not found then
    raise exception 'game_not_found' using errcode = 'P0001';
  end if;

  if p_existing_hash is not null then
    select p.id as pid, p.nickname as pname, p.kicked_at as kicked into v_player
      from public.players p
      where p.game_id = v_game.gid and p.token_hash = p_existing_hash;
    if found then
      if v_player.kicked is not null then
        raise exception 'player_removed' using errcode = 'P0001';
      end if;
      update public.players set last_seen_at = now() where id = v_player.pid;
      return query select v_player.pid, v_player.pname, v_game.gid, true;
      return;
    end if;
  end if;

  if v_game.gstatus not in ('lobby', 'live') then
    raise exception 'game_not_joinable' using errcode = 'P0001';
  end if;

  insert into public.players (game_id, nickname, token_hash)
  values (v_game.gid, p_nickname, p_token_hash)
  returning id into v_id;

  return query select v_id, p_nickname, v_game.gid, false;
end $$;

-- Everything the waiting lobby needs, in one round trip, keyed by token hash.
create or replace function public.player_lobby_state(p_token_hash text)
returns table (
  player_id uuid, nickname text, game_id uuid, join_code text, title text,
  status public.game_status, player_count bigint, max_players integer, kicked boolean
) language sql stable security definer set search_path = '' as $$
  select p.id, p.nickname, g.id, g.join_code, g.title, g.status,
         (select count(*) from public.players x where x.game_id = g.id and x.kicked_at is null),
         g.max_players, p.kicked_at is not null
  from public.players p
  join public.games g on g.id = p.game_id
  where p.token_hash = p_token_hash
$$;

revoke all on function public.public_room_info(text), public.join_game(text, text, text, text),
  public.player_lobby_state(text) from public, anon, authenticated;
grant execute on function public.public_room_info(text), public.join_game(text, text, text, text),
  public.player_lobby_state(text) to service_role;
