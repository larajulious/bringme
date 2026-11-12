-- Host can add rounds to a game that is already live, as long as the plan's round limit allows it.
-- 1) The round-insert trigger (20261111000002) now also accepts 'live' games (limit check unchanged).
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
  new.status := 'pending'; new.opened_at := null; new.closed_at := null;
  if not public.is_admin_user(v_game.owner_id) then
    select * into v_ent from public.entitlement_for(v_game.owner_id);
    if v_ent is null then
      raise exception 'subscription_required' using errcode = 'P0001';
    end if;
    select count(*) into v_count from public.game_rounds where game_id = new.game_id;
    if v_count >= v_ent.max_rounds_per_game then
      raise exception 'round_limit_reached' using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;

-- 2) One call adds the round and notifies everyone (bumps the version so host/presenter screens refresh).
create or replace function public.add_game_round(p_game uuid, p_prompt text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  g public.games%rowtype;
  v_prompt text := btrim(coalesce(p_prompt, ''));
  v_ver bigint;
  v_phase public.game_phase;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  if v_prompt = '' or length(v_prompt) > 200 then
    raise exception 'empty_item' using errcode = 'P0001';
  end if;
  -- Not the owner and not existing look identical.
  select * into g from public.games where id = p_game and owner_id = auth.uid() for update;
  if not found then
    raise exception 'game_not_found' using errcode = 'P0001';
  end if;
  if g.status not in ('lobby', 'live') then
    raise exception 'invalid_transition' using errcode = 'P0001';
  end if;

  insert into public.game_rounds (game_id, round_no, prompt)
  select g.id, coalesce(max(round_no), 0) + 1, v_prompt from public.game_rounds where game_id = g.id;

  update public.games set state_version = state_version + 1
   where id = g.id returning state_version, phase into v_ver, v_phase;
  perform public.broadcast_game(g.id, v_ver, v_phase);

  return public.game_state_json(g.id, 'host') || jsonb_build_object('joinCode', g.join_code);
end $$;

revoke all on function public.add_game_round(uuid, text) from public, anon;
grant execute on function public.add_game_round(uuid, text) to authenticated;
