-- Super Admin: Capacity & health (/admin/health). One read-only snapshot of how close the platform is to the
-- Supabase plan limits that hurt players mid-game: Realtime connections (estimated from open rooms), database size,
-- storage used and Postgres connections, plus the busiest moment of the last 7 days and the open rooms themselves.
-- Read-only; re-checks is_super_admin(). The thresholds and advice live in the app (lib/admin/utilization.ts).
--
-- Connection estimate per open room = players not removed + host console + presenter + each TV link.
-- players.last_seen_at is only touched on (re)join, so it can't tell who is online right now: the estimate counts
-- everyone in an open room, which errs on the safe (higher) side.

create or replace function public.admin_utilization()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v jsonb;
begin
  if not public.is_super_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  with open_rooms as (
    select g.id, g.title, g.join_code, g.status::text as status, g.phase::text as phase, g.game_type::text as game_type,
           g.max_players, greatest(g.created_at, g.started_at, g.phase_changed_at, g.updated_at) as last_activity,
           (select count(*) from public.players p where p.game_id = g.id and p.kicked_at is null)::int as players,
           (select count(*) from public.game_screens s where s.game_id = g.id)::int as tvs
      from public.games g
     where g.status in ('lobby', 'live')
  ),
  -- Busiest moment of the last 7 days: each player is "connected" from joining until the game ended (or they were
  -- removed); each room adds its host console + presenter while it has players. Sampled at every join.
  recent_games as (
    select g.id,
           case when g.status in ('lobby', 'live') then now()
                else coalesce(g.finished_at, g.phase_changed_at, g.updated_at) end as end_at
      from public.games g
     where g.status <> 'draft'
       and coalesce(g.finished_at, g.phase_changed_at, g.updated_at, now()) > now() - interval '7 days'
  ),
  spans as (
    select p.game_id, p.joined_at as s, least(rg.end_at, coalesce(p.kicked_at, 'infinity'::timestamptz)) as e
      from public.players p join recent_games rg on rg.id = p.game_id
  ),
  room_spans as (select game_id, min(s) as s, max(e) as e from spans group by game_id),
  samples as (
    select t.at,
           (select count(*) from spans x where x.s <= t.at and x.e > t.at)
           + 2 * (select count(*) from room_spans r where r.s <= t.at and r.e > t.at) as conns
      from (select distinct s as at from spans where s > now() - interval '7 days') t
  ),
  peak as (select at, conns from samples order by conns desc, at desc limit 1),
  photo_minutes as (
    select date_trunc('minute', s.submitted_at) as m, count(*) as n
      from public.submissions s where s.submitted_at > now() - interval '7 days' group by 1
  )
  select jsonb_build_object(
    'checked_at', now(),
    'open_rooms', (select count(*) from open_rooms),
    'live_rooms', (select count(*) from open_rooms where status = 'live'),
    'players_in_rooms', (select coalesce(sum(players), 0) from open_rooms),
    'est_connections', (select coalesce(sum(players + 2 + tvs), 0) from open_rooms),
    'peak_7d_connections', coalesce((select conns from peak), 0),
    'peak_7d_at', (select at from peak),
    'photos_last_5m', (select count(*) from public.submissions s where s.submitted_at > now() - interval '5 minutes'),
    'peak_photos_per_minute_7d', coalesce((select max(n) from photo_minutes), 0),
    'db_bytes', pg_database_size(current_database()),
    'storage_bytes', (select coalesce(sum((o.metadata ->> 'size')::bigint), 0) from storage.objects o),
    'db_connections', (select count(*) from pg_catalog.pg_stat_activity),
    'db_max_connections', current_setting('max_connections')::int,
    'rooms', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', r.id, 'title', r.title, 'join_code', r.join_code, 'status', r.status, 'phase', r.phase,
               'game_type', r.game_type, 'players', r.players, 'max_players', r.max_players, 'tvs', r.tvs,
               'idle_minutes', floor(extract(epoch from now() - r.last_activity) / 60)::int)
             order by r.players desc, r.last_activity desc)
        from (select * from open_rooms order by players desc, last_activity desc limit 50) r
    ), '[]'::jsonb)
  ) into v;
  return v;
end $$;

revoke all on function public.admin_utilization() from public, anon;
grant execute on function public.admin_utilization() to authenticated;
