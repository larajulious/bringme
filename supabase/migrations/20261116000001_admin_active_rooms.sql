-- Super Admin: list active rooms (lobby / live) with their host, and force-close one.
-- Both functions run under the admin's own session and re-check is_super_admin() themselves.
-- Closing = the same 'cancel' transition a host can do (status -> canceled, open rounds closed, every connected
-- screen told via broadcast_game), plus an entry in admin_audit_events.
-- Revert (not a migration): supabase/rollback/20261116000001_admin_active_rooms_revert.sql

create or replace function public.admin_list_active_rooms()
returns table (
  game_id uuid, title text, game_type public.game_type, status public.game_status, phase public.game_phase,
  join_code text, created_at timestamptz, started_at timestamptz,
  owner_id uuid, owner_email text, owner_name text, player_count bigint
) language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_super_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    select g.id, g.title, g.game_type, g.status, g.phase, g.join_code, g.created_at, g.started_at,
           p.id, p.email, p.display_name,
           (select count(*) from public.players pl where pl.game_id = g.id and pl.kicked_at is null)
    from public.games g
    join public.profiles p on p.id = g.owner_id
    where g.status in ('lobby', 'live')
    order by coalesce(g.started_at, g.created_at) desc
    limit 500;
end $$;

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

revoke all on function public.admin_list_active_rooms(), public.admin_close_room(uuid, text) from public, anon;
grant execute on function public.admin_list_active_rooms(), public.admin_close_room(uuid, text) to authenticated;
