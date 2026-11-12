-- BringMe! Game Pass 13: purchase history, audited plan/price management, revenue (Phase 8).
-- Additive, re-runnable. No change to entitlement or payment behaviour.

do $$ begin
  if to_regprocedure('public.game_capacity(uuid)') is null or to_regclass('public.pass_orders') is null then
    raise exception 'game_pass_precondition: apply 20261112000001..12 first';
  end if;
end $$;

-- --------------------------------------------------------- admin audit log ----
-- Catalogue changes (plans, prices) have no host, so they get their own append-only log.
-- Host-scoped actions (grants, revokes, suspensions) stay in entitlement_events.
create table if not exists public.admin_audit_events (
  id        bigint generated always as identity primary key,
  at        timestamptz not null default now(),
  admin_id  uuid references public.profiles (id) on delete set null,
  action    text not null check (action ~ '^[a-z_]{3,40}$'),
  target    text not null check (char_length(target) between 1 and 200),
  details   jsonb not null default '{}'
);
create index if not exists admin_audit_events_at_idx on public.admin_audit_events (at desc);
drop trigger if exists admin_audit_events_append_only on public.admin_audit_events;
create trigger admin_audit_events_append_only before update or delete on public.admin_audit_events
  for each row execute function public.guard_append_only();
drop trigger if exists admin_audit_events_no_truncate on public.admin_audit_events;
create trigger admin_audit_events_no_truncate before truncate on public.admin_audit_events
  for each statement execute function public.guard_append_only();
alter table public.admin_audit_events enable row level security;
revoke all on public.admin_audit_events from public, anon, authenticated;
grant all on public.admin_audit_events to service_role;
grant select on public.admin_audit_events to authenticated;
drop policy if exists admin_audit_select on public.admin_audit_events;
create policy admin_audit_select on public.admin_audit_events for select to authenticated using ((select public.is_super_admin()));

create or replace function public.admin_log(p_admin uuid, p_action text, p_target text, p_details jsonb default '{}')
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_admin_actor(p_admin);
  insert into public.admin_audit_events (admin_id, action, target, details) values (p_admin, p_action, p_target, coalesce(p_details, '{}'));
end $$;

-- ------------------------------------------------------------- plan editing ----
-- Name, description, capacity, limits and availability. Sold passes keep their snapshot cap.
create or replace function public.admin_update_plan(p_admin uuid, p_plan uuid, p_patch jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_old record;
  v_new record;
begin
  perform public.assert_admin_actor(p_admin);
  select * into v_old from public.subscription_plans where id = p_plan for update;
  if not found then raise exception 'plan_not_found' using errcode = 'P0001'; end if;
  if p_patch ?| array['code', 'id', 'tier', 'is_trial', 'duration_seconds', 'price_cents', 'currency'] then
    raise exception 'field_not_editable' using errcode = 'P0001';
  end if;
  update public.subscription_plans set
    name                 = coalesce(p_patch ->> 'name', name),
    description          = case when p_patch ? 'description' then p_patch ->> 'description' else description end,
    max_players_per_game = coalesce((p_patch ->> 'max_players_per_game')::integer, max_players_per_game),
    max_active_games     = coalesce((p_patch ->> 'max_active_games')::integer, max_active_games),
    max_rounds_per_game  = coalesce((p_patch ->> 'max_rounds_per_game')::integer, max_rounds_per_game),
    max_games_per_period = case when p_patch ? 'max_games_per_period' then (p_patch ->> 'max_games_per_period')::integer else max_games_per_period end,
    is_active            = coalesce((p_patch ->> 'is_active')::boolean, is_active)
  where id = p_plan
  returning * into v_new;
  perform public.admin_log(p_admin, 'plan_updated', v_old.code, jsonb_build_object(
    'before', jsonb_build_object('name', v_old.name, 'max_players_per_game', v_old.max_players_per_game, 'is_active', v_old.is_active,
                                 'max_active_games', v_old.max_active_games, 'max_rounds_per_game', v_old.max_rounds_per_game),
    'after',  jsonb_build_object('name', v_new.name, 'max_players_per_game', v_new.max_players_per_game, 'is_active', v_new.is_active,
                                 'max_active_games', v_new.max_active_games, 'max_rounds_per_game', v_new.max_rounds_per_game)));
end $$;

-- A local price change NEVER touches Polar. The old row is kept (orders reference it) and a new
-- active row is inserted; checkout for that price stays blocked until Polar charges the same
-- amount (price-sync check in the app, POLAR_PRODUCT_SETUP.md).
create or replace function public.admin_set_plan_price(p_admin uuid, p_plan uuid, p_currency text, p_amount_minor integer)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_cur text := upper(btrim(coalesce(p_currency, '')));
  v_old record;
  v_id uuid;
  v_code text;
begin
  perform public.assert_admin_actor(p_admin);
  if v_cur not in ('PHP', 'USD') then raise exception 'invalid_currency' using errcode = 'P0001'; end if;
  if p_amount_minor is null or p_amount_minor < 0 or p_amount_minor > 100000000 then raise exception 'invalid_price' using errcode = 'P0001'; end if;
  select code into v_code from public.subscription_plans where id = p_plan for update;
  if not found then raise exception 'plan_not_found' using errcode = 'P0001'; end if;
  select * into v_old from public.plan_prices where plan_id = p_plan and currency = v_cur and is_active;
  if v_old.id is not null and v_old.amount_minor = p_amount_minor then return v_old.id; end if;
  if v_old.id is not null then update public.plan_prices set is_active = false where id = v_old.id; end if;
  insert into public.plan_prices (plan_id, currency, amount_minor, polar_product_id, polar_price_id)
  values (p_plan, v_cur, p_amount_minor, v_old.polar_product_id, v_old.polar_price_id)
  returning id into v_id;   -- the trial-zero / paid-positive trigger still applies
  perform public.admin_log(p_admin, 'plan_price_changed', v_code, jsonb_build_object(
    'currency', v_cur, 'before_minor', v_old.amount_minor, 'after_minor', p_amount_minor));
  return v_id;
end $$;

-- --------------------------------------------------------- purchase history ----
create or replace function public.purchase_history_for(p_user uuid)
returns table (
  order_id uuid, ordered_at timestamptz, plan_code text, plan_name text, currency text,
  amount_minor integer, paid_amount_minor integer, refunded_amount_minor integer,
  status public.order_status, environment text, paid_at timestamptz,
  pass_id uuid, pass_state text, activated_at timestamptz, expires_at timestamptz
) language sql stable security definer set search_path = '' as $$
  select o.id, o.created_at, pl.code, pl.name, o.currency, o.amount_minor, o.paid_amount_minor, o.refunded_amount_minor,
         o.status, o.polar_environment, o.paid_at,
         t.pass_id, t.state, t.first_start, t.last_end
  from public.pass_orders o
  join public.subscription_plans pl on pl.id = o.plan_id
  left join lateral (select * from public.pass_timeline_for(p_user) x where x.order_id = o.id) t on true
  where o.user_id = p_user
  order by o.created_at desc
$$;

create or replace function public.my_purchase_history()
returns table (
  order_id uuid, ordered_at timestamptz, plan_code text, plan_name text, currency text,
  amount_minor integer, paid_amount_minor integer, refunded_amount_minor integer,
  status public.order_status, environment text, paid_at timestamptz,
  pass_id uuid, pass_state text, activated_at timestamptz, expires_at timestamptz
) language sql stable security definer set search_path = '' as $$
  select * from public.purchase_history_for(auth.uid())
$$;

create or replace function public.admin_purchase_history(p_user uuid)
returns table (
  order_id uuid, ordered_at timestamptz, plan_code text, plan_name text, currency text,
  amount_minor integer, paid_amount_minor integer, refunded_amount_minor integer,
  status public.order_status, environment text, paid_at timestamptz,
  pass_id uuid, pass_state text, activated_at timestamptz, expires_at timestamptz
) language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_super_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return query select * from public.purchase_history_for(p_user);
end $$;

-- ------------------------------------------------------------------ revenue ----
-- One row per (environment, currency): amounts are NEVER added across currencies or across
-- sandbox/production. Gross = what Polar charged on paid orders (may include tax added on top);
-- refunds = refunded amounts; net = gross - refunds. Complimentary access is counted separately.
create or replace function public.admin_revenue()
returns table (
  environment text, currency text, paid_orders bigint, refunded_orders bigint,
  gross_minor bigint, refunds_minor bigint, net_minor bigint, needs_review bigint
) language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_super_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return query
    select coalesce(o.polar_environment, 'unknown'), o.currency,
           count(*) filter (where o.status in ('paid', 'refunded', 'partially_refunded')),
           count(*) filter (where o.status in ('refunded', 'partially_refunded')),
           coalesce(sum(o.paid_amount_minor) filter (where o.status in ('paid', 'refunded', 'partially_refunded')), 0)::bigint,
           coalesce(sum(o.refunded_amount_minor) filter (where o.status in ('refunded', 'partially_refunded')), 0)::bigint,
           (coalesce(sum(o.paid_amount_minor) filter (where o.status in ('paid', 'refunded', 'partially_refunded')), 0)
            - coalesce(sum(o.refunded_amount_minor) filter (where o.status in ('refunded', 'partially_refunded')), 0))::bigint,
           count(*) filter (where o.status = 'needs_review')
      from public.pass_orders o
     group by 1, 2
     order by 1, 2;
end $$;

-- Passes by source (purchases vs complimentary vs trials), no money involved.
create or replace function public.admin_pass_counts()
returns table (source public.pass_source, passes bigint, active_now bigint, granted_days numeric)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_super_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return query
    select g.source, count(*), count(*) filter (where public.current_pass_id(g.user_id) = g.id),
           round(sum(g.duration_seconds) / 86400.0, 1)
      from public.game_passes g group by 1 order by 1;
end $$;

-- ---------------------------------------------------------------- privileges ----
revoke all on function public.admin_log(uuid, text, text, jsonb), public.admin_update_plan(uuid, uuid, jsonb),
  public.admin_set_plan_price(uuid, uuid, text, integer), public.purchase_history_for(uuid),
  public.my_purchase_history(), public.admin_purchase_history(uuid), public.admin_revenue(), public.admin_pass_counts()
  from public, anon, authenticated;
grant execute on function public.my_purchase_history(), public.admin_purchase_history(uuid),
  public.admin_revenue(), public.admin_pass_counts() to authenticated;
grant execute on function public.admin_log(uuid, text, text, jsonb), public.admin_update_plan(uuid, uuid, jsonb),
  public.admin_set_plan_price(uuid, uuid, text, integer), public.purchase_history_for(uuid) to service_role;
