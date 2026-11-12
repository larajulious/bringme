-- Simplify the homepage "Snappy boops" counter to ONE number (replaces 20261112000015's sharded counter and
-- per-client rate-limit table). No history and no per-visitor data are stored: each request just adds its batch.
--
-- Abuse protection now lives in the API (per-request cap + in-memory per-client limits that are never persisted)
-- and in this function's own bound on a single batch. Only service_role may execute.

create table if not exists public.snappy_counter (
  id   boolean primary key default true check (id),   -- exactly one row
  taps bigint  not null default 0 check (taps >= 0)
);

-- Carry over the existing total once (if the old shards exist), then drop the old objects.
do $$
begin
  if to_regclass('public.snappy_tap_shards') is not null then
    insert into public.snappy_counter (id, taps)
    select true, coalesce(sum(taps), 0) from public.snappy_tap_shards
    on conflict (id) do nothing;
  end if;
end $$;
insert into public.snappy_counter (id, taps) values (true, 0) on conflict (id) do nothing;

drop function if exists public.add_snappy_taps(text, integer);
drop function if exists public.get_snappy_taps();
drop table if exists public.snappy_tap_limits;   -- held HMAC'd client keys: no longer kept at all
drop table if exists public.snappy_tap_shards;

alter table public.snappy_counter enable row level security;
revoke all on public.snappy_counter from public, anon, authenticated;

create or replace function public.add_snappy_taps(p_taps integer)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_total bigint;
begin
  if p_taps is null or p_taps < 1 or p_taps > 500 then
    raise exception 'invalid_taps' using errcode = '22023';
  end if;
  update public.snappy_counter set taps = taps + p_taps where id returning taps into v_total;
  return v_total;
end $$;

create or replace function public.get_snappy_taps()
returns bigint language sql stable security definer set search_path = '' as $$
  select coalesce((select taps from public.snappy_counter where id), 0)::bigint;
$$;

revoke all on function public.add_snappy_taps(integer), public.get_snappy_taps() from public, anon, authenticated;
grant execute on function public.add_snappy_taps(integer), public.get_snappy_taps() to service_role;
