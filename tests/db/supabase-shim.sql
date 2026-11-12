-- Minimal emulation of the Supabase platform pieces our migrations depend on,
-- so RLS/grants/triggers can be exercised in PGlite without a Supabase project.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  email_confirmed_at timestamptz,   -- NULL until verified (Supabase "Confirm email" ON); tests confirm explicitly
  raw_user_meta_data jsonb not null default '{}'
);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.jwt() returns jsonb language sql stable as
  $$ select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.jwt() to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

create schema storage;
create table storage.buckets (
  id text primary key, name text, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[]
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text, owner uuid
);
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated, service_role;

-- Supabase's default privileges: new public/storage objects are open to the API
-- roles. Migrations must explicitly revoke what they don't want exposed.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
grant all on all tables in schema storage to anon, authenticated, service_role;

-- Realtime (Broadcast) emulation: messages table + send() + topic()
create schema realtime;
create table realtime.messages (
  id bigserial primary key, topic text not null, extension text not null default 'broadcast',
  event text, payload jsonb, private boolean default false, inserted_at timestamptz default now()
);
alter table realtime.messages enable row level security;
create function realtime.topic() returns text language sql stable as
  $$ select nullif(current_setting('realtime.topic', true), '') $$;
create function realtime.send(payload jsonb, event text, topic text, private boolean default true)
returns void language sql as
  $$ insert into realtime.messages (topic, event, payload, private) values (topic, event, payload, private) $$;
grant usage on schema realtime to anon, authenticated, service_role;
grant select, insert on realtime.messages to anon, authenticated, service_role;
grant usage on all sequences in schema realtime to anon, authenticated, service_role;
grant execute on function realtime.topic() to anon, authenticated, service_role;
grant execute on function realtime.send(jsonb, text, text, boolean) to anon, authenticated, service_role;

-- Test-only ledger helpers (Game Pass). Not part of any migration. They use the same
-- transaction-local maintenance switch as the legacy backfill and run as postgres.
create schema test;
-- A pass over an arbitrary [start, end) interval (past or future): fixtures for expiry etc.
create function test.grant_access(p_user uuid, p_plan text, p_start timestamptz, p_end timestamptz)
returns uuid language plpgsql as $$
declare v_pass uuid;
begin
  perform set_config('bringme.ledger_maintenance', 'on', true);
  insert into public.game_passes (user_id, plan_id, source, max_players, duration_seconds, grant_reason)
  select p_user, id, 'admin_grant', max_players_per_game, extract(epoch from (p_end - p_start)), 'test fixture'
  from public.subscription_plans where code = p_plan
  returning id into v_pass;
  if v_pass is null then raise exception 'test.grant_access: unknown plan %', p_plan; end if;
  insert into public.pass_segments (pass_id, user_id, starts_at, ends_at) values (v_pass, p_user, p_start, p_end);
  perform set_config('bringme.ledger_maintenance', 'off', true);
  return v_pass;
end $$;
-- Simulate elapsed time: move every segment of the host p_seconds into the past.
create function test.shift_ledger(p_user uuid, p_seconds numeric)
returns void language plpgsql as $$
declare r record;
begin
  perform set_config('bringme.ledger_maintenance', 'on', true);
  for r in select id from public.pass_segments where user_id = p_user order by starts_at loop
    update public.pass_segments
       set starts_at = starts_at - make_interval(secs => p_seconds::double precision),
           ends_at   = ends_at   - make_interval(secs => p_seconds::double precision)
     where id = r.id;
  end loop;
  perform set_config('bringme.ledger_maintenance', 'off', true);
end $$;
-- End the host's CURRENT segment one second ago (whatever is queued next becomes active).
create function test.end_current(p_user uuid)
returns void language plpgsql as $$
declare v_end timestamptz;
begin
  select ends_at into v_end from public.pass_segments
   where user_id = p_user and starts_at <= now() and now() < ends_at;
  if v_end is null then raise exception 'test.end_current: no running segment'; end if;
  perform test.shift_ledger(p_user, extract(epoch from (v_end - now())) + 1);
end $$;
