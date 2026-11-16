-- Fix for 20261116000001: closing a LIVE/LOBBY BingoSnap room failed with 'wrong_game_type', because a BingoSnap
-- game's status may only change while the transaction-local flag bingosnap.engine = 'on' (guard_bingosnap_game_state).
-- admin_close_room now sets that flag around its own update, exactly like bingo_transition does. Bring Me is unchanged.
-- Same signature, so grants are kept. Re-runnable. Revert: re-run 20261116000001.

create or replace function public.admin_close_room(p_game uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  g public.games%rowtype;
  v_ver bigint;
  v_phase public.game_phase;
  v_reason text := nullif(btrim(p_reason), '');
begin
  if not public.is_super_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_reason is null or char_length(v_reason) < 3 then
    raise exception 'reason_required' using errcode = 'P0001';
  end if;

  select * into g from public.games where id = p_game for update;
  if not found then
    raise exception 'room_not_found' using errcode = 'P0001';
  end if;
  if g.status not in ('lobby', 'live') then
    raise exception 'room_not_active' using errcode = 'P0001';
  end if;

  update public.game_rounds set status = 'closed' where game_id = g.id and status = 'open';  -- Bring Me only
  perform set_config('bingosnap.engine', 'on', true);   -- BingoSnap: same permission bingo_transition takes
  update public.games set status = 'canceled' where id = g.id   -- trigger: finished_at, phase, version bump
    returning state_version, phase into v_ver, v_phase;
  perform set_config('bingosnap.engine', 'off', true);
  perform public.broadcast_game(g.id, v_ver, v_phase);

  insert into public.admin_audit_events (admin_id, action, target, details)
  values (auth.uid(), 'close_room', g.id::text, jsonb_build_object(
    'title', g.title, 'game_type', g.game_type, 'owner_id', g.owner_id,
    'previous_status', g.status, 'reason', left(v_reason, 200)));
end $$;
