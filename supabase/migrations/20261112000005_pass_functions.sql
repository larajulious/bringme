-- BringMe! Game Pass 5/7: ledger functions.
-- Defines functions only; nothing existing calls them until 20261112000007, so there
-- is no behaviour change. Re-runnable (CREATE OR REPLACE, unchanged signatures).
--
-- Lock order everywhere (deadlock-free): pass_orders row -> profiles row -> segments.
-- All entitlement writes for one host are serialised by the profiles row lock; the
-- exclusion constraint on pass_segments proves the result has no overlap.

do $$ begin
  if to_regclass('public.pass_orders') is null then
    raise exception 'game_pass_precondition: apply 20261112000004 first';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'auth' and table_name = 'users' and column_name = 'email_confirmed_at') then
    raise exception 'game_pass_precondition: auth.users.email_confirmed_at is missing (trial eligibility needs it)';
  end if;
end $$;

-- ------------------------------------------------------------------ helpers ----
create or replace function public.log_entitlement_event(
  p_user uuid, p_pass uuid, p_order uuid, p_actor_kind text, p_actor uuid, p_action text, p_details jsonb default '{}'
) returns void language sql security definer set search_path = '' as $$
  insert into public.entitlement_events (user_id, pass_id, order_id, actor_kind, actor_id, action, details)
  values (p_user, p_pass, p_order, p_actor_kind, p_actor, p_action, coalesce(p_details, '{}'))
$$;

-- Seconds of a pass already used before p_at (exact to the microsecond).
create or replace function public.pass_consumed_seconds(p_pass uuid, p_at timestamptz)
returns numeric language sql stable security definer set search_path = '' as $$
  select coalesce(sum(extract(epoch from (least(ends_at, p_at) - starts_at))), 0)
  from public.pass_segments where pass_id = p_pass and starts_at < p_at
$$;

create or replace function public.pass_remaining_seconds(p_pass uuid, p_at timestamptz)
returns numeric language sql stable security definer set search_path = '' as $$
  select greatest(p.duration_seconds - public.pass_consumed_seconds(p.id, p_at), 0)
  from public.game_passes p where p.id = p_pass
$$;

-- The pass whose segment contains now() (ignores suspension/deactivation).
create or replace function public.current_pass_id(p_user uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select s.pass_id from public.pass_segments s
  join public.game_passes p on p.id = s.pass_id and p.disposition = 'granted'
  where s.user_id = p_user and s.starts_at <= now() and now() < s.ends_at
  limit 1
$$;

create or replace function public.assert_admin_actor(p_admin uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  -- Handlers authorize with requireSuperAdmin() first; this re-checks the actor they pass.
  -- NULL = legacy console shim (admin_set_subscription), audited with no actor id.
  if p_admin is not null and not public.is_admin_user(p_admin) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end $$;

-- Lobby capacity follows the pass. No-op until the cutover (20261112000007) replaces it,
-- because before cutover the game triggers still read the legacy subscription.
-- p_old_cap = the host's player cap before the change (NULL = had no access).
create or replace function public.sync_lobby_capacity(p_user uuid, p_old_cap integer)
returns void language plpgsql security definer set search_path = '' as $$
begin
  return;
end $$;

-- ---------------------------------------------------------------- replan ----
-- Re-lays every unused pass of the host back to back from now(), ordered by
-- max_players DESC (higher tier first), then seq ASC (FIFO). Truncates the running
-- segment at now(); never touches time before now() (guard trigger enforces it).
create or replace function public.replan_passes(p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  t        timestamptz := now();
  v_cursor timestamptz := now();
  r        record;
  v_cont   bigint;
  v_old_cap integer;
begin
  perform 1 from public.profiles where id = p_user for update;
  select e.max_players_per_game into v_old_cap from public.pass_entitlement(p_user) e;

  update public.pass_segments set ends_at = t where user_id = p_user and starts_at < t and ends_at > t;
  delete from public.pass_segments where user_id = p_user and starts_at >= t;

  for r in
    select p.id, public.pass_remaining_seconds(p.id, t) as rem
    from public.game_passes p
    where p.user_id = p_user and p.disposition = 'granted'
    order by p.max_players desc, p.seq asc
  loop
    continue when r.rem <= 0;
    v_cont := null;
    if v_cursor = t then   -- the pass that was running may simply continue (no fragmenting)
      select id into v_cont from public.pass_segments
       where pass_id = r.id and ends_at = t and starts_at < t limit 1;
    end if;
    if v_cont is not null then
      update public.pass_segments set ends_at = v_cursor + make_interval(secs => r.rem::double precision) where id = v_cont;
    else
      insert into public.pass_segments (pass_id, user_id, starts_at, ends_at)
      values (r.id, p_user, v_cursor, v_cursor + make_interval(secs => r.rem::double precision));
    end if;
    v_cursor := v_cursor + make_interval(secs => r.rem::double precision);
  end loop;

  perform public.sync_lobby_capacity(p_user, v_old_cap);
end $$;

-- ------------------------------------------------------------ grant / revoke ----
create or replace function public.grant_pass(
  p_user uuid, p_plan uuid, p_source public.pass_source, p_duration numeric,
  p_order uuid, p_actor_kind text, p_actor uuid, p_reason text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_plan   record;
  v_pass   uuid;
  v_before uuid;
  v_after  uuid;
  r        record;
begin
  if p_source = 'legacy_subscription' then
    raise exception 'legacy_passes_come_from_backfill' using errcode = 'P0001';
  end if;
  perform 1 from public.profiles where id = p_user for update;
  if not found then raise exception 'user_not_found' using errcode = 'P0001'; end if;
  select id, code, max_players_per_game into v_plan from public.subscription_plans where id = p_plan;
  if not found then raise exception 'unknown_plan' using errcode = 'P0001'; end if;
  if p_duration is null or p_duration <= 0 then raise exception 'invalid_duration' using errcode = 'P0001'; end if;

  v_before := public.current_pass_id(p_user);
  insert into public.game_passes (user_id, plan_id, source, order_id, max_players, duration_seconds, granted_by, grant_reason)
  values (p_user, p_plan, p_source, p_order, v_plan.max_players_per_game, p_duration,
          case when p_actor_kind = 'admin' then p_actor end, p_reason)
  returning id into v_pass;
  perform public.log_entitlement_event(p_user, v_pass, p_order, p_actor_kind, p_actor,
    case when p_source = 'trial' then 'trial_started' else 'pass_granted' end,
    jsonb_build_object('plan', v_plan.code, 'source', p_source, 'max_players', v_plan.max_players_per_game,
                       'duration_seconds', p_duration));

  -- Rule 4: a paid pass ends the free trial (unused trial time is not kept).
  if p_source = 'purchase' then
    for r in select id from public.game_passes
              where user_id = p_user and source = 'trial' and disposition = 'granted'
                and public.pass_remaining_seconds(id, now()) > 0 loop
      update public.game_passes set disposition = 'forfeited', ended_at = now(), end_reason = 'paid_pass_purchased'
       where id = r.id;
      perform public.log_entitlement_event(p_user, r.id, p_order, p_actor_kind, p_actor, 'trial_forfeited', '{}');
    end loop;
  end if;

  perform public.replan_passes(p_user);

  v_after := public.current_pass_id(p_user);
  if v_before is not null and v_before is distinct from v_after
     and exists (select 1 from public.game_passes where id = v_before and disposition = 'granted') then
    perform public.log_entitlement_event(p_user, v_before, null, p_actor_kind, p_actor, 'pass_preempted',
      jsonb_build_object('by', v_pass, 'remaining_seconds', public.pass_remaining_seconds(v_before, now())));
  end if;
  return v_pass;
end $$;

create or replace function public.revoke_pass(p_pass uuid, p_reason text, p_actor_kind text, p_actor uuid, p_order uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
begin
  select user_id into v_user from public.game_passes where id = p_pass;
  if v_user is null then raise exception 'pass_not_found' using errcode = 'P0001'; end if;
  perform 1 from public.profiles where id = v_user for update;
  update public.game_passes set disposition = 'revoked', ended_at = now(), end_reason = left(p_reason, 200)
   where id = p_pass and disposition = 'granted';
  if not found then raise exception 'pass_not_revocable' using errcode = 'P0001'; end if;
  perform public.log_entitlement_event(v_user, p_pass, p_order, p_actor_kind, p_actor, 'pass_revoked',
    jsonb_build_object('reason', p_reason, 'unused_seconds', public.pass_remaining_seconds(p_pass, now())));
  perform public.replan_passes(v_user);
end $$;

-- ------------------------------------------------------------- resolution ----
-- GAME_PASS_DESIGN.md §5.1. At most one row (exclusion constraint). Pure time: no writes.
create or replace function public.pass_entitlement(p_user uuid)
returns table (
  pass_id uuid, plan_id uuid, plan_code text, source public.pass_source,
  max_players_per_game integer, max_active_games integer, max_rounds_per_game integer, max_games_per_period integer,
  activated_at timestamptz, current_period_end timestamptz, access_until timestamptz, payment_status public.order_status
) language sql stable security definer set search_path = '' as $$
  with recursive seg as (
    select s.pass_id, s.ends_at
    from public.pass_segments s
    join public.game_passes p on p.id = s.pass_id and p.disposition = 'granted'
    join public.profiles pr on pr.id = s.user_id and pr.deactivated_at is null and pr.hosting_suspended_at is null
    where s.user_id = p_user and s.starts_at <= now() and now() < s.ends_at
  ), chain as (
    select ends_at from seg
    union
    select s.ends_at from public.pass_segments s join chain c on s.user_id = p_user and s.starts_at = c.ends_at
  )
  select p.id, p.plan_id, pl.code, p.source, p.max_players,
         pl.max_active_games, pl.max_rounds_per_game, pl.max_games_per_period,
         (select min(x.starts_at) from public.pass_segments x where x.pass_id = p.id),
         seg.ends_at, (select max(c.ends_at) from chain c), o.status
  from seg
  join public.game_passes p on p.id = seg.pass_id
  join public.subscription_plans pl on pl.id = p.plan_id
  left join public.pass_orders o on o.id = p.order_id
$$;

-- --------------------------------------------------------------------- trial ----
create or replace function public.trial_eligibility(p_user uuid)
returns table (eligible boolean, reason text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_p record;
  v_confirmed timestamptz;
begin
  select pr.role, pr.deactivated_at, pr.hosting_suspended_at into v_p from public.profiles pr where pr.id = p_user;
  if not found or v_p.role <> 'subscriber' then return query select false, 'not_subscriber'::text; return; end if;
  if v_p.deactivated_at is not null then return query select false, 'deactivated'::text; return; end if;
  if v_p.hosting_suspended_at is not null then return query select false, 'suspended'::text; return; end if;
  select u.email_confirmed_at into v_confirmed from auth.users u where u.id = p_user;
  if v_confirmed is null then return query select false, 'email_unconfirmed'::text; return; end if;
  if exists (select 1 from public.game_passes g where g.user_id = p_user and g.source = 'trial') then
    return query select false, 'trial_already_used'::text; return;
  end if;
  if exists (select 1 from public.game_passes g where g.user_id = p_user and g.source in ('purchase', 'legacy_subscription')) then
    return query select false, 'has_paid_history'::text; return;
  end if;
  return query select true, null::text;
end $$;

create or replace function public.my_trial_eligibility()
returns table (eligible boolean, reason text)
language sql stable security definer set search_path = '' as $$
  select * from public.trial_eligibility(auth.uid())
$$;

-- Rule 1/2: once, when first validly issued; never via session changes (rows are permanent).
create or replace function public.start_trial()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_el   record;
  v_plan record;
  v_pass uuid;
begin
  if v_user is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  perform 1 from public.profiles where id = v_user for update;
  select * into v_el from public.trial_eligibility(v_user);
  if not v_el.eligible then raise exception '%', v_el.reason using errcode = 'P0001'; end if;
  select id, duration_seconds into v_plan from public.subscription_plans
   where is_trial and is_active order by tier limit 1;
  if not found then raise exception 'trial_unavailable' using errcode = 'P0001'; end if;
  begin
    v_pass := public.grant_pass(v_user, v_plan.id, 'trial', v_plan.duration_seconds, null, 'host', v_user, null);
  exception when unique_violation then
    raise exception 'trial_already_used' using errcode = 'P0001';
  end;
  return jsonb_build_object('passId', v_pass);
end $$;

-- ------------------------------------------------------------------ timeline ----
create or replace function public.pass_timeline_for(p_user uuid)
returns table (
  pass_id uuid, seq bigint, plan_code text, plan_name text, source public.pass_source, max_players integer,
  duration_seconds numeric, consumed_seconds numeric, remaining_seconds numeric, state text,
  first_start timestamptz, last_end timestamptz, disposition public.pass_disposition, ended_at timestamptz,
  end_reason text, order_id uuid, order_status public.order_status, created_at timestamptz
) language sql stable security definer set search_path = '' as $$
  select p.id, p.seq, pl.code, pl.name, p.source, p.max_players, p.duration_seconds,
         c.consumed, greatest(p.duration_seconds - c.consumed, 0),
         case
           when p.disposition <> 'granted' then p.disposition::text
           when exists (select 1 from public.pass_segments s where s.pass_id = p.id
                         and s.starts_at <= now() and now() < s.ends_at) then 'active'
           when p.duration_seconds - c.consumed <= 0 then 'consumed'
           when c.consumed > 0 then 'paused'
           else 'queued'
         end,
         (select min(s.starts_at) from public.pass_segments s where s.pass_id = p.id),
         (select max(s.ends_at) from public.pass_segments s where s.pass_id = p.id),
         p.disposition, p.ended_at, p.end_reason, p.order_id, o.status, p.created_at
  from public.game_passes p
  join public.subscription_plans pl on pl.id = p.plan_id
  left join public.pass_orders o on o.id = p.order_id
  cross join lateral (select public.pass_consumed_seconds(p.id, now()) as consumed) c
  where p.user_id = p_user
  order by p.seq desc
$$;

create or replace function public.my_pass_timeline()
returns table (
  pass_id uuid, seq bigint, plan_code text, plan_name text, source public.pass_source, max_players integer,
  duration_seconds numeric, consumed_seconds numeric, remaining_seconds numeric, state text,
  first_start timestamptz, last_end timestamptz, disposition public.pass_disposition, ended_at timestamptz,
  end_reason text, order_id uuid, order_status public.order_status, created_at timestamptz
) language sql stable security definer set search_path = '' as $$
  select * from public.pass_timeline_for(auth.uid())
$$;

create or replace function public.admin_pass_timeline(p_user uuid)
returns table (
  pass_id uuid, seq bigint, plan_code text, plan_name text, source public.pass_source, max_players integer,
  duration_seconds numeric, consumed_seconds numeric, remaining_seconds numeric, state text,
  first_start timestamptz, last_end timestamptz, disposition public.pass_disposition, ended_at timestamptz,
  end_reason text, order_id uuid, order_status public.order_status, created_at timestamptz
) language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_super_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  return query select * from public.pass_timeline_for(p_user);
end $$;

-- --------------------------------------------------------------- admin tools ----
create or replace function public.admin_grant_pass(
  p_admin uuid, p_user uuid, p_plan_code text, p_days integer, p_reason text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_plan uuid;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  perform public.assert_admin_actor(p_admin);
  if not exists (select 1 from public.profiles where id = p_user and role = 'subscriber') then
    raise exception 'user_not_found' using errcode = 'P0001';
  end if;
  select id into v_plan from public.subscription_plans where code = p_plan_code and is_active;
  if v_plan is null then raise exception 'unknown_plan' using errcode = 'P0001'; end if;
  if exists (select 1 from public.profiles where id = p_user and deactivated_at is not null) then
    raise exception 'account_deactivated' using errcode = 'P0001';
  end if;
  if p_days is null or p_days < 1 or p_days > 366 then raise exception 'invalid_days' using errcode = 'P0001'; end if;
  if v_reason is null or char_length(v_reason) > 500 then raise exception 'reason_required' using errcode = 'P0001'; end if;

  perform 1 from public.profiles where id = p_user for update;
  -- Same as the legacy "activate": granting access lifts an admin suspension.
  update public.profiles set hosting_suspended_at = null where id = p_user and hosting_suspended_at is not null;
  if found then
    perform public.log_entitlement_event(p_user, null, null, 'admin', p_admin, 'admin_unsuspend', jsonb_build_object('via', 'grant'));
  end if;
  return public.grant_pass(p_user, v_plan, 'admin_grant', p_days::numeric * 86400, null, 'admin', p_admin, v_reason);
end $$;

create or replace function public.admin_revoke_pass(p_admin uuid, p_pass uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  perform public.assert_admin_actor(p_admin);
  if v_reason is null or char_length(v_reason) > 200 then raise exception 'reason_required' using errcode = 'P0001'; end if;
  perform public.revoke_pass(p_pass, v_reason, 'admin', p_admin);
end $$;

create or replace function public.admin_set_suspended(p_admin uuid, p_user uuid, p_suspended boolean, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_admin_actor(p_admin);
  if not exists (select 1 from public.profiles where id = p_user and role = 'subscriber') then
    raise exception 'user_not_found' using errcode = 'P0001';
  end if;
  perform 1 from public.profiles where id = p_user for update;
  if p_suspended then
    if public.current_pass_id(p_user) is null
       or exists (select 1 from public.profiles where id = p_user and hosting_suspended_at is not null) then
      raise exception 'no_live_subscription' using errcode = 'P0001';
    end if;
    update public.profiles set hosting_suspended_at = now() where id = p_user;
    perform public.log_entitlement_event(p_user, null, null, 'admin', p_admin, 'admin_suspend', jsonb_build_object('reason', p_reason));
  else
    update public.profiles set hosting_suspended_at = null where id = p_user and hosting_suspended_at is not null;
    if found then
      perform public.log_entitlement_event(p_user, null, null, 'admin', p_admin, 'admin_unsuspend', jsonb_build_object('reason', p_reason));
    end if;
  end if;
end $$;

-- Manual/legacy passes only: what was SOLD is never changed (paid_pass_immutable).
create or replace function public.admin_set_pass_plan(p_admin uuid, p_user uuid, p_plan_code text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_plan record;
  v_pass record;
begin
  perform public.assert_admin_actor(p_admin);
  if not exists (select 1 from public.profiles where id = p_user and role = 'subscriber') then
    raise exception 'user_not_found' using errcode = 'P0001';
  end if;
  select id, code, max_players_per_game into v_plan from public.subscription_plans where code = p_plan_code and is_active;
  if not found then raise exception 'unknown_plan' using errcode = 'P0001'; end if;
  perform 1 from public.profiles where id = p_user for update;
  select id, source into v_pass from public.game_passes where id = public.current_pass_id(p_user);
  if not found then raise exception 'no_subscription' using errcode = 'P0001'; end if;
  if v_pass.source not in ('admin_grant', 'legacy_subscription') then
    raise exception 'paid_pass_immutable' using errcode = 'P0001';
  end if;
  update public.game_passes set plan_id = v_plan.id, max_players = v_plan.max_players_per_game where id = v_pass.id;
  perform public.log_entitlement_event(p_user, v_pass.id, null, 'admin', p_admin, 'admin_set_plan', jsonb_build_object('plan', v_plan.code));
  perform public.replan_passes(p_user);
end $$;

create or replace function public.admin_set_pass_expiry(p_admin uuid, p_user uuid, p_expires timestamptz)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_pass record;
  v_start timestamptz;
  v_new numeric;
begin
  perform public.assert_admin_actor(p_admin);
  if not exists (select 1 from public.profiles where id = p_user and role = 'subscriber') then
    raise exception 'user_not_found' using errcode = 'P0001';
  end if;
  perform 1 from public.profiles where id = p_user for update;
  select id, source into v_pass from public.game_passes where id = public.current_pass_id(p_user);
  if not found then raise exception 'no_subscription' using errcode = 'P0001'; end if;
  if v_pass.source not in ('admin_grant', 'legacy_subscription') then
    raise exception 'paid_pass_immutable' using errcode = 'P0001';
  end if;
  select min(starts_at) into v_start from public.pass_segments where pass_id = v_pass.id;
  if p_expires is null or p_expires <= v_start or p_expires > now() + interval '5 years' then
    raise exception 'invalid_expiry' using errcode = 'P0001';
  end if;
  -- New length = time already used + time from now until the requested end.
  v_new := public.pass_consumed_seconds(v_pass.id, now()) + greatest(extract(epoch from (p_expires - now())), 0);
  update public.game_passes set duration_seconds = v_new where id = v_pass.id;
  perform public.log_entitlement_event(p_user, v_pass.id, null, 'admin', p_admin, 'admin_set_expiry',
    jsonb_build_object('expires', p_expires, 'duration_seconds', v_new));
  perform public.replan_passes(p_user);
end $$;

-- -------------------------------------------------------------------- orders ----
create or replace function public.create_pass_order(p_user uuid, p_plan_code text, p_currency text)
returns table (order_id uuid, amount_minor integer, currency text, polar_product_id text, polar_price_id text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_cur   text := upper(btrim(coalesce(p_currency, '')));
  v_plan  record;
  v_price record;
  v_id    uuid;
  r       record;
begin
  if not exists (select 1 from public.profiles where id = p_user and role = 'subscriber') then
    raise exception 'user_not_found' using errcode = 'P0001';
  end if;
  if v_cur not in ('PHP', 'USD') then raise exception 'invalid_currency' using errcode = 'P0001'; end if;
  perform 1 from public.profiles where id = p_user for update;
  if exists (select 1 from public.profiles where id = p_user and deactivated_at is not null) then
    raise exception 'account_deactivated' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.profiles where id = p_user and hosting_suspended_at is not null) then
    raise exception 'account_suspended' using errcode = 'P0001';
  end if;
  select id, code, is_trial into v_plan from public.subscription_plans where code = p_plan_code and is_active;
  if not found then raise exception 'unknown_plan' using errcode = 'P0001'; end if;
  if v_plan.is_trial then raise exception 'plan_not_purchasable' using errcode = 'P0001'; end if;
  select pp.id, pp.amount_minor, pp.polar_product_id, pp.polar_price_id into v_price
    from public.plan_prices pp where pp.plan_id = v_plan.id and pp.currency = v_cur and pp.is_active;
  if not found or v_price.polar_product_id is null or v_price.amount_minor <= 0 then
    raise exception 'plan_not_purchasable' using errcode = 'P0001';
  end if;

  -- Abandoned checkouts (24 h) grant nothing and stop counting against the limit.
  for r in select o.id from public.pass_orders o
            where o.user_id = p_user and o.status = 'pending' and o.created_at < now() - interval '24 hours' loop
    update public.pass_orders set status = 'expired', closed_at = now() where id = r.id;
    perform public.log_entitlement_event(p_user, null, r.id, 'system', null, 'order_expired', jsonb_build_object('reason', 'abandoned'));
  end loop;
  if (select count(*) from public.pass_orders o where o.user_id = p_user and o.status = 'pending') >= 3 then
    raise exception 'too_many_pending_orders' using errcode = 'P0001';
  end if;

  insert into public.pass_orders (user_id, plan_id, plan_price_id, currency, amount_minor)
  values (p_user, v_plan.id, v_price.id, v_cur, v_price.amount_minor)
  returning id into v_id;
  perform public.log_entitlement_event(p_user, null, v_id, 'host', p_user, 'order_created',
    jsonb_build_object('plan', v_plan.code, 'currency', v_cur, 'amount_minor', v_price.amount_minor));
  return query select v_id, v_price.amount_minor, v_cur, v_price.polar_product_id, v_price.polar_price_id;
end $$;

create or replace function public.attach_checkout(p_order uuid, p_checkout_id text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.pass_orders set polar_checkout_id = p_checkout_id
   where id = p_order and status = 'pending' and polar_checkout_id is null;
  if not found then raise exception 'order_not_attachable' using errcode = 'P0001'; end if;
end $$;

-- ------------------------------------------------------------ webhook effects ----
-- p_effect is the normalized instruction produced by the server AFTER signature
-- verification (Phase 3). Shapes:
--   {"kind":"ignore"}
--   {"kind":"order_paid","order_id":uuid,"polar_order_id":..,"polar_product_id":..,"polar_price_id":..,
--    "polar_customer_id":..,"currency":"PHP","amount_minor":9900}
--   {"kind":"order_failed"|"order_expired"|"order_canceled","order_id":uuid}
--   {"kind":"order_refunded","order_id"|"polar_order_id":..,"refunded_amount_minor":<cumulative>}
--   {"kind":"order_disputed","order_id"|"polar_order_id":..}
-- Returns: duplicate | applied | duplicate_effect | ignored | unmatched | needs_review.
-- The event row and all effects commit together; any error rolls back both (provider retries).
create or replace function public.apply_payment_event(
  p_provider text, p_event_id text, p_event_type text, p_payload jsonb, p_effect jsonb
) returns text language plpgsql security definer set search_path = '' as $$
declare
  v_event   bigint;
  v_kind    text := coalesce(p_effect ->> 'kind', 'ignore');
  v_order   public.pass_orders%rowtype;
  v_price   record;
  v_outcome text;
  v_reason  text;
  v_ref     text := p_effect ->> 'order_id';
  v_polar   text := nullif(p_effect ->> 'polar_order_id', '');
  v_amount  bigint;
  v_cur     text := upper(coalesce(p_effect ->> 'currency', ''));
  v_pass    uuid;
  v_dur     numeric;
begin
  insert into public.payment_events (provider, event_id, event_type, payload)
  values (coalesce(p_provider, 'polar'), p_event_id, p_event_type, coalesce(p_payload, '{}'))
  on conflict (provider, event_id) do nothing
  returning id into v_event;
  if v_event is null then return 'duplicate'; end if;

  if v_kind not in ('order_paid', 'order_failed', 'order_expired', 'order_canceled', 'order_refunded', 'order_disputed') then
    update public.payment_events set processed_at = now(), outcome = 'ignored' where id = v_event;
    return 'ignored';
  end if;

  if v_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select * into v_order from public.pass_orders where id = v_ref::uuid for update;
  end if;
  if v_order.id is null and v_polar is not null then
    select * into v_order from public.pass_orders where polar_order_id = v_polar for update;
  end if;
  if v_order.id is null and nullif(p_effect ->> 'polar_checkout_id', '') is not null then
    select * into v_order from public.pass_orders where polar_checkout_id = p_effect ->> 'polar_checkout_id' for update;
  end if;
  if v_order.id is null then
    update public.payment_events set processed_at = now(), outcome = 'unmatched' where id = v_event;
    return 'unmatched';
  end if;
  perform 1 from public.profiles where id = v_order.user_id for update;
  update public.payment_events set order_id = v_order.id where id = v_event;

  if v_kind = 'order_paid' then
    v_amount := case when (p_effect ->> 'amount_minor') ~ '^[0-9]{1,12}$' then (p_effect ->> 'amount_minor')::bigint end;
    if v_order.status in ('paid', 'refunded', 'partially_refunded') then
      if v_order.polar_order_id = v_polar then
        v_outcome := 'duplicate_effect';
      else
        v_outcome := 'needs_review';
        perform public.log_entitlement_event(v_order.user_id, null, v_order.id, 'webhook', null, 'order_needs_review',
          jsonb_build_object('reason', 'second_payment_for_order', 'polar_order_id', left(v_polar, 200)));
      end if;
    else
      select * into v_price from public.plan_prices where id = v_order.plan_price_id;
      v_reason := case
        when v_polar is null or char_length(v_polar) > 200 then 'invalid_polar_order_id'
        when exists (select 1 from public.pass_orders where polar_order_id = v_polar and id <> v_order.id) then 'polar_order_reused'
        when v_price.polar_product_id is null or (p_effect ->> 'polar_product_id') is distinct from v_price.polar_product_id then 'product_mismatch'
        when v_price.polar_price_id is not null and (p_effect ->> 'polar_price_id') is distinct from v_price.polar_price_id then 'price_mismatch'
        when v_cur <> v_order.currency then 'currency_mismatch'
        when v_amount is null or v_amount < v_order.amount_minor then 'amount_mismatch'
        when v_order.status <> 'pending' then 'order_was_' || v_order.status::text
      end;
      update public.pass_orders
         set polar_order_id    = case when v_reason in ('invalid_polar_order_id', 'polar_order_reused') then polar_order_id
                                      else coalesce(polar_order_id, v_polar) end,
             polar_customer_id = coalesce(polar_customer_id, left(nullif(p_effect ->> 'polar_customer_id', ''), 200)),
             paid_amount_minor = case when v_amount between 0 and 2147483647 then v_amount::integer end,
             paid_currency     = case when v_cur ~ '^[A-Z]{3}$' then v_cur end,
             paid_at           = coalesce(paid_at, now()),
             status            = case when v_reason is null then 'paid'::public.order_status else 'needs_review'::public.order_status end,
             review_reason     = v_reason
       where id = v_order.id;
      if v_reason is null then
        select duration_seconds into v_dur from public.subscription_plans where id = v_order.plan_id;
        v_pass := public.grant_pass(v_order.user_id, v_order.plan_id, 'purchase', v_dur, v_order.id, 'webhook', null, null);
        perform public.log_entitlement_event(v_order.user_id, v_pass, v_order.id, 'webhook', null, 'order_paid',
          jsonb_build_object('amount_minor', v_amount, 'currency', v_cur, 'event_id', p_event_id));
        v_outcome := 'applied';
      else
        perform public.log_entitlement_event(v_order.user_id, null, v_order.id, 'webhook', null, 'order_needs_review',
          jsonb_build_object('reason', v_reason, 'event_id', p_event_id));
        v_outcome := 'needs_review';
      end if;
    end if;

  elsif v_kind in ('order_failed', 'order_expired', 'order_canceled') then
    if v_order.status = 'pending' then
      update public.pass_orders
         set status = (case v_kind when 'order_failed' then 'failed' when 'order_expired' then 'expired' else 'canceled' end)::public.order_status,
             closed_at = now()
       where id = v_order.id;
      perform public.log_entitlement_event(v_order.user_id, null, v_order.id, 'webhook', null, v_kind, jsonb_build_object('event_id', p_event_id));
      v_outcome := 'applied';
    else
      v_outcome := 'ignored';   -- monotonic: a late "expired" never undoes a payment
    end if;

  elsif v_kind = 'order_refunded' then
    v_amount := case when (p_effect ->> 'refunded_amount_minor') ~ '^[0-9]{1,12}$' then (p_effect ->> 'refunded_amount_minor')::bigint end;
    if v_order.status not in ('paid', 'partially_refunded') or v_amount is null or v_amount > v_order.paid_amount_minor then
      perform public.log_entitlement_event(v_order.user_id, null, v_order.id, 'webhook', null, 'order_needs_review',
        jsonb_build_object('reason', 'unexpected_refund', 'refunded_amount_minor', v_amount, 'event_id', p_event_id));
      v_outcome := 'needs_review';
    elsif v_amount <= v_order.refunded_amount_minor then
      v_outcome := 'duplicate_effect';
    elsif v_amount >= v_order.paid_amount_minor then
      -- D-15: full refund revokes the unused time; used time stays as history.
      update public.pass_orders set status = 'refunded', refunded_amount_minor = v_amount, closed_at = now() where id = v_order.id;
      perform public.log_entitlement_event(v_order.user_id, null, v_order.id, 'webhook', null, 'order_refunded',
        jsonb_build_object('refunded_amount_minor', v_amount, 'event_id', p_event_id));
      select id into v_pass from public.game_passes where order_id = v_order.id and disposition = 'granted';
      if v_pass is not null then perform public.revoke_pass(v_pass, 'refunded', 'webhook', null, v_order.id); end if;
      v_outcome := 'applied';
    else
      update public.pass_orders set status = 'partially_refunded', refunded_amount_minor = v_amount,
             review_reason = 'partial_refund' where id = v_order.id;
      perform public.log_entitlement_event(v_order.user_id, null, v_order.id, 'webhook', null, 'order_partially_refunded',
        jsonb_build_object('refunded_amount_minor', v_amount, 'event_id', p_event_id));
      v_outcome := 'applied';
    end if;

  elsif v_kind = 'order_disputed' then
    select id into v_pass from public.game_passes where order_id = v_order.id and disposition = 'granted';
    update public.pass_orders set review_reason = 'disputed' where id = v_order.id;
    perform public.log_entitlement_event(v_order.user_id, v_pass, v_order.id, 'webhook', null, 'order_disputed',
      jsonb_build_object('event_id', p_event_id));
    if v_pass is not null then perform public.revoke_pass(v_pass, 'disputed', 'webhook', null, v_order.id); end if;
    v_outcome := 'applied';
  end if;

  update public.payment_events set processed_at = now(), outcome = v_outcome where id = v_event;
  return v_outcome;
end $$;

-- Admin decision on an order held for review (evidence already stored by the webhook).
create or replace function public.admin_review_order(p_admin uuid, p_order uuid, p_decision text, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_order public.pass_orders%rowtype;
  v_dur numeric;
  v_pass uuid;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  perform public.assert_admin_actor(p_admin);
  if v_reason is null or char_length(v_reason) > 500 then raise exception 'reason_required' using errcode = 'P0001'; end if;
  select * into v_order from public.pass_orders where id = p_order for update;
  if not found or v_order.status <> 'needs_review' then raise exception 'order_not_in_review' using errcode = 'P0001'; end if;
  perform 1 from public.profiles where id = v_order.user_id for update;
  if p_decision = 'approve' then
    if v_order.polar_order_id is null or v_order.paid_amount_minor is null or v_order.paid_currency is null then
      raise exception 'no_payment_evidence' using errcode = 'P0001';
    end if;
    update public.pass_orders set status = 'paid', review_reason = left('approved: ' || v_reason, 500) where id = p_order;
    select duration_seconds into v_dur from public.subscription_plans where id = v_order.plan_id;
    v_pass := public.grant_pass(v_order.user_id, v_order.plan_id, 'purchase', v_dur, p_order, 'admin', p_admin, null);
    perform public.log_entitlement_event(v_order.user_id, v_pass, p_order, 'admin', p_admin, 'order_paid', jsonb_build_object('review', v_reason));
  elsif p_decision = 'reject' then
    update public.pass_orders set status = 'canceled', closed_at = now(), review_reason = left('rejected: ' || v_reason, 500) where id = p_order;
    perform public.log_entitlement_event(v_order.user_id, null, p_order, 'admin', p_admin, 'order_canceled', jsonb_build_object('review', v_reason));
  else
    raise exception 'invalid_decision' using errcode = 'P0001';
  end if;
end $$;

-- ------------------------------------------------------------------ privileges ----
revoke all on function
  public.log_entitlement_event(uuid, uuid, uuid, text, uuid, text, jsonb),
  public.pass_consumed_seconds(uuid, timestamptz), public.pass_remaining_seconds(uuid, timestamptz),
  public.current_pass_id(uuid), public.assert_admin_actor(uuid), public.sync_lobby_capacity(uuid, integer),
  public.replan_passes(uuid), public.grant_pass(uuid, uuid, public.pass_source, numeric, uuid, text, uuid, text),
  public.revoke_pass(uuid, text, text, uuid, uuid), public.pass_entitlement(uuid), public.trial_eligibility(uuid),
  public.my_trial_eligibility(), public.start_trial(), public.pass_timeline_for(uuid), public.my_pass_timeline(),
  public.admin_pass_timeline(uuid), public.admin_grant_pass(uuid, uuid, text, integer, text),
  public.admin_revoke_pass(uuid, uuid, text), public.admin_set_suspended(uuid, uuid, boolean, text),
  public.admin_set_pass_plan(uuid, uuid, text), public.admin_set_pass_expiry(uuid, uuid, timestamptz),
  public.create_pass_order(uuid, text, text), public.attach_checkout(uuid, text),
  public.apply_payment_event(text, text, text, jsonb, jsonb), public.admin_review_order(uuid, uuid, text, text)
  from public, anon, authenticated;

-- Host-facing (self-scoped by auth.uid(); admin_pass_timeline re-checks super_admin).
grant execute on function public.start_trial(), public.my_trial_eligibility(), public.my_pass_timeline(),
  public.admin_pass_timeline(uuid) to authenticated;
-- Server-only (handlers authorize first: requireSuperAdmin / verified webhook / requireRole).
grant execute on function
  public.pass_entitlement(uuid), public.trial_eligibility(uuid), public.pass_timeline_for(uuid),
  public.admin_grant_pass(uuid, uuid, text, integer, text), public.admin_revoke_pass(uuid, uuid, text),
  public.admin_set_suspended(uuid, uuid, boolean, text), public.admin_set_pass_plan(uuid, uuid, text),
  public.admin_set_pass_expiry(uuid, uuid, timestamptz), public.create_pass_order(uuid, text, text),
  public.attach_checkout(uuid, text), public.apply_payment_event(text, text, text, jsonb, jsonb),
  public.admin_review_order(uuid, uuid, text, text)
  to service_role;
