-- BringMe! Game Pass 12: close the last capacity bypass (Phase 7). Re-runnable.
--
-- Audit finding: hosts may UPDATE players.kicked_at (column grant, used to remove players).
-- Setting it back to NULL ("un-remove") re-admitted a player WITHOUT the capacity check that
-- every join gets, so a full 3-player trial room could reach 4 by: remove A, B joins, restore A.
--
-- Now restoring a removed player is treated like a join: the game row is locked (serialises
-- with concurrent joins, same lock as enforce_player_insert), closed games refuse it, and the
-- room must have a free slot under game_capacity() (= the owner's CURRENT pass cap).
-- Every other rule of the previous enforce_player_update (20261111000002) is unchanged.

do $$ begin
  if to_regprocedure('public.game_capacity(uuid)') is null then
    raise exception 'game_pass_precondition: apply 20261112000001..11 first';
  end if;
end $$;

create or replace function public.enforce_player_update()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_game  record;
  v_count integer;
begin
  if new.id <> old.id or new.game_id <> old.game_id
     or new.token_hash <> old.token_hash or new.nickname <> old.nickname then
    raise exception 'immutable player column' using errcode = '42501';
  end if;

  if old.kicked_at is not null and new.kicked_at is null then
    select * into v_game from public.games where id = new.game_id for update;
    if v_game.status not in ('lobby', 'live') then
      raise exception 'game_not_joinable' using errcode = 'P0001';
    end if;
    select count(*) into v_count from public.players
     where game_id = new.game_id and kicked_at is null and id <> new.id;
    if v_count >= public.game_capacity(new.game_id) then
      raise exception 'game_full' using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;

revoke all on function public.enforce_player_update() from public, anon, authenticated;
