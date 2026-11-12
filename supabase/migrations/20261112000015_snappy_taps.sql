-- Homepage "Snappy boops": one global, public tap counter.
--
-- Design
-- * Sharded counter (16 rows, random shard per write) so concurrent writes don't serialise on one hot row;
--   the total is the sum of the shards.
-- * Per-client fixed-window rate limit (300 taps / minute; generous because a whole office can share one IP). The client key is an HMAC of the IP computed
--   on the server (never the raw IP); rows older than a day are purged opportunistically.
-- * Over-limit taps are silently dropped (accepted = 0), so clients have nothing to retry.
-- * Only service_role may execute; browsers reach this through POST /api/snappy, which also batches and
--   throttles requests. Tables have RLS on and no grants: nothing is readable or writable directly.

create table if not exists public.snappy_tap_shards (
  shard smallint primary key check (shard between 0 and 15),
  taps  bigint   not null default 0 check (taps >= 0)
);
insert into public.snappy_tap_shards (shard) select g from generate_series(0, 15) g on conflict (shard) do nothing;

create table if not exists public.snappy_tap_limits (
  client_hash  text        primary key check (client_hash ~ '^[0-9a-f]{64}$'),
  window_start timestamptz not null,
  taps         integer     not null default 0 check (taps >= 0)
);

alter table public.snappy_tap_shards enable row level security;
alter table public.snappy_tap_limits enable row level security;
revoke all on public.snappy_tap_shards, public.snappy_tap_limits from public, anon, authenticated;

create or replace function public.add_snappy_taps(p_client_hash text, p_taps integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c_window constant interval := interval '1 minute';
  c_cap    constant integer  := 300;   -- taps per client (IP) per window; offices share one IP
  c_batch  constant integer  := 40;    -- max taps per request
  v_used    integer;
  v_allowed integer;
  v_total   bigint;
  v_shard   smallint := floor(random() * 16)::smallint;  -- chosen ONCE (random() in a WHERE runs per row)
begin
  if p_client_hash is null or p_client_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_client' using errcode = '22023';
  end if;
  if p_taps is null or p_taps < 1 or p_taps > c_batch then
    raise exception 'invalid_taps' using errcode = '22023';
  end if;

  -- Lock this client's window row (creating or resetting it) and read what's already used.
  insert into public.snappy_tap_limits as l (client_hash, window_start, taps)
  values (p_client_hash, now(), 0)
  on conflict (client_hash) do update
    set window_start = case when l.window_start <= now() - c_window then now() else l.window_start end,
        taps         = case when l.window_start <= now() - c_window then 0     else l.taps end
  returning l.taps into v_used;

  v_allowed := greatest(0, least(p_taps, c_cap - v_used));
  if v_allowed > 0 then
    update public.snappy_tap_limits set taps = taps + v_allowed where client_hash = p_client_hash;
    update public.snappy_tap_shards set taps = taps + v_allowed where shard = v_shard;
  end if;

  if random() < 0.01 then
    delete from public.snappy_tap_limits where window_start < now() - interval '1 day';
  end if;

  select coalesce(sum(taps), 0)::bigint into v_total from public.snappy_tap_shards;
  return jsonb_build_object('accepted', v_allowed, 'total', v_total);
end $$;

create or replace function public.get_snappy_taps()
returns bigint language sql stable security definer set search_path = '' as $$
  select coalesce(sum(taps), 0)::bigint from public.snappy_tap_shards;
$$;

revoke all on function public.add_snappy_taps(text, integer), public.get_snappy_taps() from public, anon, authenticated;
grant execute on function public.add_snappy_taps(text, integer), public.get_snappy_taps() to service_role;
