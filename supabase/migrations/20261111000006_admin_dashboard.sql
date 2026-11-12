-- BringMe! Phase 4: Super Admin dashboard support.
-- Adds: per-period game cap on plans, account deactivation, platform settings,
-- richer admin RPCs (overview, search/filter/paginate, plan/expiry control).
-- Incremental: no existing data is dropped or rewritten.

-- ------------------------------------------------------------ new columns ----
alter table public.subscription_plans
  add column if not exists max_games_per_period integer check (max_games_per_period is null or max_games_per_period > 0);
comment on column public.subscription_plans.max_games_per_period is
  'Max games a subscriber may create per subscription period (NULL = unlimited). A period starts when an admin activates the subscription.';

alter table public.profiles add column if not exists deactivated_at timestamptz;

-- ------------------------------------------------------- platform settings ----
create table if not exists public.platform_settings (
  id                    boolean primary key default true check (id),  -- single row
  default_max_players   integer not null default 20 check (default_max_players between 2 and 500),
  max_photo_size_mb     integer not null default 5 check (max_photo_size_mb between 1 and 20),
  photo_retention_days  integer not null default 30 check (photo_retention_days between 1 and 365),
  support_email         text check (support_email is null or support_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  updated_at            timestamptz not null default now()
);
insert into public.platform_settings (id) values (true) on conflict (id) do nothing;

drop trigger if exists set_updated_at on public.platform_settings;
create trigger set_updated_at before update on public.platform_settings
  for each row execute function public.set_updated_at();

-- Photo size limit is enforced by Storage itself: keep the bucket in sync.
create or replace function public.sync_photo_limit()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update storage.buckets set file_size_limit = new.max_photo_size_mb::bigint * 1048576
   where id = 'submissions';
  return new;
end $$;
drop trigger if exists sync_photo_limit on public.platform_settings;
create trigger sync_photo_limit after insert or update of max_photo_size_mb on public.platform_settings
  for each row execute function public.sync_photo_limit();
update public.platform_settings set max_photo_size_mb = max_photo_size_mb;  -- initial sync

-- Used as the DEFAULT for games.max_players (still capped by the owner's plan).
create or replace function public.default_max_players()
returns integer language sql stable security definer set search_path = '' as $$
  select coalesce((select default_max_players from public.platform_settings limit 1), 20)
$$;
alter table public.games alter column max_players set default public.default_max_players();

revoke all on public.platform_settings from public, anon, authenticated;
grant all on public.platform_settings to service_role;
grant select on public.platform_settings to authenticated;   -- writes: service role only
alter table public.platform_settings enable row level security;
drop policy if exists settings_select on public.platform_settings;
create policy settings_select on public.platform_settings for select to authenticated using (true);

revoke all on function public.default_max_players() from public, anon, authenticated;
grant execute on function public.default_max_players() to authenticated, service_role;

-- ------------------------------------------------ entitlement + access state ----
-- Deactivated accounts are never entitled.
create or replace function public.entitlement_for(p_user uuid)
returns table (
  subscription_id uuid, plan_code text,
  max_active_games integer, max_players_per_game integer, max_rounds_per_game integer,
  current_period_end timestamptz
) language sql stable security definer set search_path = '' as $$
  select s.id, p.code, p.max_active_games, p.max_players_per_game, p.max_rounds_per_game, s.current_period_end
  from public.subscriptions s
  join public.subscription_plans p on p.id = s.plan_id
  join public.profiles pr on pr.id = s.user_id and pr.deactivated_at is null
  where s.user_id = p_user
    and s.status in ('trialing', 'active')
    and s.current_period_start <= now()
    and s.current_period_end > now()
  order by s.current_period_end desc
  limit 1
$$;

create or replace function public.access_state_for(p_user uuid)
returns table (state text, plan_code text, current_period_end timestamptz)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_ent record;
  v_sub record;
begin
  if exists (select 1 from public.profiles where id = p_user and deactivated_at is not null) then
    return query select 'deactivated'::text, null::text, null::timestamptz;
    return;
  end if;

  select * into v_ent from public.entitlement_for(p_user);
  if v_ent.subscription_id is not null then
    return query select 'active'::text, v_ent.plan_code, v_ent.current_period_end;
    return;
  end if;

  select s.status, p.code as pcode, s.current_period_end as pend, s.current_period_start as pstart
    into v_sub
  from public.subscriptions s
  join public.subscription_plans p on p.id = s.plan_id
  where s.user_id = p_user
  order by s.created_at desc
  limit 1;

  if not found then
    return query select 'pending'::text, null::text, null::timestamptz;
  elsif v_sub.status = 'suspended' then
    return query select 'suspended'::text, v_sub.pcode, v_sub.pend;
  elsif v_sub.status in ('trialing', 'active') and v_sub.pstart > now() then
    return query select 'pending'::text, v_sub.pcode, v_sub.pend;
  else
    return query select 'expired'::text, v_sub.pcode, v_sub.pend;
  end if;
end $$;

-- ---------------------------------------------- per-period game cap (trigger) ----
create or replace function public.enforce_game_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_ent record;
  v_period record;
  v_active integer;
  v_period_count integer;
begin
  if new.status <> 'draft' then
    raise exception 'games must be created as draft' using errcode = 'P0001';
  end if;
  if not public.is_admin_user(new.owner_id) then
    select * into v_ent from public.entitlement_for(new.owner_id);
    if v_ent is null then
      raise exception 'subscription_required' using errcode = 'P0001';
    end if;
    select count(*) into v_active from public.games
      where owner_id = new.owner_id and status in ('draft', 'lobby', 'live');
    if v_active >= v_ent.max_active_games then
      raise exception 'game_limit_reached' using errcode = 'P0001';
    end if;

    select s.current_period_start as pstart, p.max_games_per_period as pmax into v_period
      from public.subscriptions s join public.subscription_plans p on p.id = s.plan_id
      where s.id = v_ent.subscription_id;
    if v_period.pmax is not null then
      select count(*) into v_period_count from public.games
        where owner_id = new.owner_id and created_at >= v_period.pstart;
      if v_period_count >= v_period.pmax then
        raise exception 'period_game_limit_reached' using errcode = 'P0001';
      end if;
    end if;
    new.max_players := least(new.max_players, v_ent.max_players_per_game);
  end if;
  return new;
end $$;

-- ------------------------------------------------------------- admin RPCs ----
drop function if exists public.admin_list_subscribers();
drop function if exists public.admin_set_subscription(uuid, text, text, integer);

create or replace function public.admin_overview()
returns table (
  total_subscribers bigint, active_subscribers bigint, pending_subscribers bigint,
  expired_subscribers bigint, suspended_subscribers bigint, deactivated_subscribers bigint,
  total_games bigint, completed_games bigint, active_rooms bigint
) language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_super_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    select
      count(*),
      count(*) filter (where a.state = 'active'),
      count(*) filter (where a.state = 'pending'),
      count(*) filter (where a.state = 'expired'),
      count(*) filter (where a.state = 'suspended'),
      count(*) filter (where a.state = 'deactivated'),
      (select count(*) from public.games),
      (select count(*) from public.games where status = 'finished'),
      (select count(*) from public.games where status in ('lobby', 'live'))
    from public.profiles p
    cross join lateral public.access_state_for(p.id) a
    where p.role = 'subscriber';
end $$;

create or replace function public.admin_list_subscribers(
  p_search text default null, p_state text default null,
  p_limit integer default 20, p_offset integer default 0
) returns table (
  user_id uuid, email text, display_name text, joined_at timestamptz,
  state text, plan_code text, current_period_end timestamptz, total_count bigint
) language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_like text;
begin
  if not public.is_super_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_state is not null and p_state not in ('active', 'pending', 'expired', 'suspended', 'deactivated') then
    raise exception 'invalid_state' using errcode = 'P0001';
  end if;
  v_like := case when nullif(btrim(p_search), '') is null then null
                 else '%' || replace(replace(replace(btrim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%' end;
  return query
    with rows as (
      select p.id as uid, p.email as mail, p.display_name as dname, p.created_at as joined,
             a.state as st, a.plan_code as pc, a.current_period_end as pend
      from public.profiles p
      cross join lateral public.access_state_for(p.id) a
      where p.role = 'subscriber'
        and (v_like is null or p.email ilike v_like escape '\' or p.display_name ilike v_like escape '\')
        and (p_state is null or a.state = p_state)
    )
    select uid, mail, dname, joined, st, pc, pend, count(*) over ()
    from rows
    order by joined desc
    limit greatest(1, least(coalesce(p_limit, 20), 100))
    offset greatest(0, coalesce(p_offset, 0));
end $$;

-- Access state of one subscriber (detail page). Admin-only, self-checking.
create or replace function public.admin_subscriber_state(p_user uuid)
returns table (state text, plan_code text, current_period_end timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_super_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query select * from public.access_state_for(p_user);
end $$;

-- Manual subscription control. Service role only: the handler authorizes first.
create or replace function public.admin_set_subscription(
  p_user uuid, p_action text, p_plan_code text default null,
  p_days integer default null, p_expires timestamptz default null
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_plan uuid;
  v_target record;
  v_updated integer;
begin
  if not exists (select 1 from public.profiles where id = p_user and role = 'subscriber') then
    raise exception 'user_not_found' using errcode = 'P0001';
  end if;

  if p_action in ('activate', 'set_plan') then
    select id into v_plan from public.subscription_plans where code = p_plan_code and is_active;
    if v_plan is null then raise exception 'unknown_plan' using errcode = 'P0001'; end if;
  end if;

  -- The user's current (live or suspended) subscription row, if any.
  select id, current_period_start into v_target from public.subscriptions
    where user_id = p_user and status in ('trialing', 'active', 'past_due', 'suspended')
    order by created_at desc limit 1 for update;

  if p_action = 'activate' then
    if exists (select 1 from public.profiles where id = p_user and deactivated_at is not null) then
      raise exception 'account_deactivated' using errcode = 'P0001';
    end if;
    if p_days is null or p_days < 1 or p_days > 366 then
      raise exception 'invalid_days' using errcode = 'P0001';
    end if;
    if v_target.id is null then
      insert into public.subscriptions (user_id, plan_id, status, current_period_start, current_period_end)
      values (p_user, v_plan, 'active', now(), now() + make_interval(days => p_days));
    else
      update public.subscriptions
        set plan_id = v_plan, status = 'active', cancel_at_period_end = false,
            current_period_start = now(), current_period_end = now() + make_interval(days => p_days)
        where id = v_target.id;
    end if;

  elsif p_action = 'set_plan' then
    if v_target.id is null then raise exception 'no_subscription' using errcode = 'P0001'; end if;
    update public.subscriptions set plan_id = v_plan where id = v_target.id;

  elsif p_action = 'set_expiry' then
    if v_target.id is null then raise exception 'no_subscription' using errcode = 'P0001'; end if;
    if p_expires is null or p_expires <= v_target.current_period_start
       or p_expires > now() + interval '5 years' then
      raise exception 'invalid_expiry' using errcode = 'P0001';
    end if;
    update public.subscriptions set current_period_end = p_expires where id = v_target.id;

  elsif p_action = 'suspend' then
    update public.subscriptions set status = 'suspended'
      where user_id = p_user and status in ('trialing', 'active', 'past_due');
    get diagnostics v_updated = row_count;
    if v_updated = 0 then raise exception 'no_live_subscription' using errcode = 'P0001'; end if;

  else
    raise exception 'invalid_action' using errcode = 'P0001';
  end if;
end $$;

-- Account deactivation flag (the handler also bans the auth user so they cannot sign in).
create or replace function public.admin_set_account_active(p_user uuid, p_active boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.profiles
     set deactivated_at = case when p_active then null else now() end
   where id = p_user and role = 'subscriber';
  if not found then raise exception 'user_not_found' using errcode = 'P0001'; end if;
end $$;

revoke all on function
  public.admin_overview(), public.admin_list_subscribers(text, text, integer, integer),
  public.admin_subscriber_state(uuid),
  public.admin_set_subscription(uuid, text, text, integer, timestamptz),
  public.admin_set_account_active(uuid, boolean), public.access_state_for(uuid), public.entitlement_for(uuid)
  from public, anon, authenticated;
grant execute on function public.admin_overview(), public.admin_list_subscribers(text, text, integer, integer),
  public.admin_subscriber_state(uuid) to authenticated;
grant execute on function
  public.admin_set_subscription(uuid, text, text, integer, timestamptz),
  public.admin_set_account_active(uuid, boolean), public.access_state_for(uuid), public.entitlement_for(uuid)
  to service_role;
-- my_access_status() (migration 5) wraps access_state_for and keeps working unchanged.
