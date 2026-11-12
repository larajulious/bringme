-- Disposable (temporary) email protection for NEW accounts.
--
-- Enforcement point: the Supabase Auth "Before User Created" hook (public.hook_before_user_created).
-- It runs inside Supabase Auth before a user row exists, for every signup path (our form, direct
-- calls to the Auth API, signInWithOtp with shouldCreateUser), so a rejected signup creates no user
-- and sends no confirmation email. Existing users never reach it: signing in does not create a user.
-- The hook must be switched on once in the Dashboard (see supabase/README.md, "Disposable email protection").
--
-- Data:
--   disposable_email_domains       the ACTIVE blocklist (registrable domains, exact match per label suffix)
--   disposable_email_allowlist     never blocked: 'provider' (major mailbox providers; an update containing one
--                                  is refused as corrupt), 'privacy_relay' (alias services such as Apple Hide My
--                                  Email, DuckDuckGo, SimpleLogin) and 'false_positive' (verified mistakes upstream)
--   disposable_email_list_versions snapshot per applied list (source, commit, count, time) for audit + rollback
--
-- Matching: the email's domain and each parent with >= 2 labels are compared EXACTLY (never substring);
-- at each level the allowlist wins; the most specific hit decides. "x.mailinator.com" is blocked,
-- "bringmailinator.com" is not.
--
-- Privacy: nothing here stores or logs email addresses; the hook only reads the domain.
-- Permissions: browsers (anon/authenticated) can't read the tables or call any function. supabase_auth_admin
-- may only EXECUTE the hook (security definer, so it needs no table access); service_role runs the
-- pre-check, updates and rollback.

create table if not exists public.disposable_email_domains (
  domain text primary key
    check (length(domain) <= 253 and domain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$')
);

create table if not exists public.disposable_email_allowlist (
  domain     text primary key
    check (length(domain) <= 253 and domain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'),
  kind       text not null check (kind in ('provider', 'privacy_relay', 'false_positive')),
  reason     text not null check (length(btrim(reason)) > 0),
  created_at timestamptz not null default now()
);

create table if not exists public.disposable_email_list_versions (
  id           bigint generated always as identity primary key,
  source       text not null,
  source_ref   text,                       -- upstream commit / checksum
  domain_count integer not null check (domain_count >= 0),
  domains      text[] not null,            -- snapshot used by rollback
  is_active    boolean not null default false,
  applied_at   timestamptz not null default now()
);
create unique index if not exists disposable_email_list_versions_one_active
  on public.disposable_email_list_versions (is_active) where is_active;

alter table public.disposable_email_domains enable row level security;
alter table public.disposable_email_allowlist enable row level security;
alter table public.disposable_email_list_versions enable row level security;
revoke all on public.disposable_email_domains, public.disposable_email_allowlist, public.disposable_email_list_versions
  from public, anon, authenticated;

-- ---------------------------------------------------------------- lookups

create or replace function public.email_domain(p_email text)
returns text language sql immutable set search_path = '' as $$
  select nullif(rtrim(lower(btrim(substring(p_email from '@([^@]*)$'))), '.'), '');
$$;

create or replace function public.is_disposable_email_domain(p_domain text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  v_labels text[];
  v_candidate text;
begin
  v_labels := string_to_array(nullif(rtrim(lower(btrim(coalesce(p_domain, ''))), '.'), ''), '.');
  if v_labels is null then return false; end if;
  for i in 1 .. coalesce(array_length(v_labels, 1), 0) - 1 loop
    v_candidate := array_to_string(v_labels[i:], '.');
    if exists (select 1 from public.disposable_email_allowlist a where a.domain = v_candidate) then return false; end if;
    if exists (select 1 from public.disposable_email_domains d where d.domain = v_candidate) then return true; end if;
  end loop;
  return false;
end $$;

create or replace function public.is_disposable_email(p_email text)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_disposable_email_domain(public.email_domain(p_email));
$$;

-- ---------------------------------------------------------------- Auth hook

-- Supabase Auth -> Hooks -> "Before User Created" -> Postgres -> public.hook_before_user_created.
-- Returns {} to allow, or an error object (Auth then answers 400 with this message and creates nothing).
create or replace function public.hook_before_user_created(event jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if public.is_disposable_email(event -> 'user' ->> 'email') then
    return jsonb_build_object('error', jsonb_build_object(
      'http_code', 400,
      'message', 'Temporary email addresses aren''t supported. Please use a permanent email address to continue.'));
  end if;
  return '{}'::jsonb;
end $$;

-- ---------------------------------------------------------------- maintenance (service role only)

-- Validates and activates a new list atomically. Any failed check raises, leaving the active list untouched.
create or replace function public.apply_disposable_email_list(
  p_domains      text[],
  p_source       text,
  p_source_ref   text    default null,
  p_min_count    integer default 1000,
  p_allow_shrink boolean default false
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_clean    text[];
  v_count    integer;
  v_bad      integer;
  v_current  integer;
  v_missing  text;
  v_provider text;
  v_id       bigint;
begin
  perform pg_advisory_xact_lock(hashtext('public.disposable_email_list'));
  if p_source is null or btrim(p_source) = '' then
    raise exception 'invalid_source' using errcode = '22023';
  end if;

  select coalesce(array_agg(distinct d order by d), '{}') into v_clean
  from (select rtrim(lower(btrim(x)), '.') as d from unnest(coalesce(p_domains, '{}')) as x) s
  where d <> '';
  v_count := coalesce(array_length(v_clean, 1), 0);

  select count(*) into v_bad from unnest(v_clean) as d
  where not (length(d) <= 253 and d ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$');
  if v_bad > 0 then
    raise exception 'invalid_domains: % entries', v_bad using errcode = '22023';
  end if;
  if v_count < greatest(coalesce(p_min_count, 1000), 1) then
    raise exception 'list_too_small: % domains (minimum %)', v_count, greatest(coalesce(p_min_count, 1000), 1) using errcode = '22023';
  end if;
  select s into v_missing
  from unnest(array['mailinator.com', 'guerrillamail.com', 'yopmail.com', '10minutemail.com']) as s
  where not (s = any (v_clean)) limit 1;
  if v_missing is not null then
    raise exception 'missing_sentinel: %', v_missing using errcode = '22023';
  end if;
  select a.domain into v_provider from public.disposable_email_allowlist a
  where a.kind = 'provider' and a.domain = any (v_clean) order by a.domain limit 1;
  if v_provider is not null then
    raise exception 'contains_provider: %', v_provider using errcode = '22023';
  end if;
  select count(*) into v_current from public.disposable_email_domains;
  if not coalesce(p_allow_shrink, false) and v_current > 0 and v_count < v_current * 0.8 then
    raise exception 'list_shrank: % -> % domains', v_current, v_count using errcode = '22023';
  end if;

  update public.disposable_email_list_versions set is_active = false where is_active;
  insert into public.disposable_email_list_versions (source, source_ref, domain_count, domains, is_active)
  values (btrim(p_source), nullif(btrim(coalesce(p_source_ref, '')), ''), v_count, v_clean, true)
  returning id into v_id;

  -- Readers (the hook) keep seeing the previous list until this transaction commits.
  delete from public.disposable_email_domains;
  insert into public.disposable_email_domains (domain) select unnest(v_clean);

  -- Keep the active version and the four most recent others for rollback.
  delete from public.disposable_email_list_versions v
  where not v.is_active
    and v.id not in (select id from public.disposable_email_list_versions where not is_active order by id desc limit 4);

  return jsonb_build_object('version', v_id, 'domains', v_count, 'previous_domains', v_current);
end $$;

-- Re-activates a stored snapshot: the given version, or by default the newest version before the active one.
create or replace function public.rollback_disposable_email_list(p_version_id bigint default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_active bigint;
  v_target public.disposable_email_list_versions;
begin
  perform pg_advisory_xact_lock(hashtext('public.disposable_email_list'));
  select id into v_active from public.disposable_email_list_versions where is_active;
  if p_version_id is null then
    select * into v_target from public.disposable_email_list_versions
    where not is_active and (v_active is null or id < v_active) order by id desc limit 1;
  else
    select * into v_target from public.disposable_email_list_versions where id = p_version_id;
  end if;
  if v_target.id is null then
    raise exception 'version_not_found' using errcode = 'P0002';
  end if;

  update public.disposable_email_list_versions set is_active = false where is_active;
  update public.disposable_email_list_versions set is_active = true where id = v_target.id;
  delete from public.disposable_email_domains;
  insert into public.disposable_email_domains (domain) select distinct unnest(v_target.domains);

  return jsonb_build_object('version', v_target.id, 'domains', v_target.domain_count, 'previous_version', v_active);
end $$;

create or replace function public.disposable_email_list_status()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'active', (select jsonb_build_object('version', id, 'source', source, 'source_ref', source_ref,
                                         'domains', domain_count, 'applied_at', applied_at)
               from public.disposable_email_list_versions where is_active),
    'live_domains', (select count(*) from public.disposable_email_domains),
    'allowlist', (select count(*) from public.disposable_email_allowlist),
    'providers', (select coalesce(jsonb_agg(domain order by domain), '[]') from public.disposable_email_allowlist where kind = 'provider'),
    'versions', (select coalesce(jsonb_agg(jsonb_build_object('version', id, 'source_ref', source_ref, 'domains', domain_count,
                                                              'applied_at', applied_at, 'active', is_active) order by id desc), '[]')
                 from public.disposable_email_list_versions));
$$;

-- ---------------------------------------------------------------- grants

revoke all on function
  public.email_domain(text),
  public.is_disposable_email_domain(text),
  public.is_disposable_email(text),
  public.hook_before_user_created(jsonb),
  public.apply_disposable_email_list(text[], text, text, integer, boolean),
  public.rollback_disposable_email_list(bigint),
  public.disposable_email_list_status()
from public, anon, authenticated;

grant execute on function
  public.is_disposable_email(text),
  public.apply_disposable_email_list(text[], text, text, integer, boolean),
  public.rollback_disposable_email_list(bigint),
  public.disposable_email_list_status()
to service_role;

-- supabase_auth_admin exists on every Supabase project (guarded so local tooling without it still works).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    grant usage on schema public to supabase_auth_admin;
    grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;
  end if;
end $$;
