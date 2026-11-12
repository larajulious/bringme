-- BringMe! Phase 3 / migration 2 of 2: access state + manual activation.
--
-- Access states shown to a subscriber (derived, single source of truth):
--   active    unexpired trialing/active subscription (entitled)
--   pending   no subscription yet (new signups start here)
--   suspended latest subscription was suspended by an admin
--   expired   latest subscription ended / was cancelled / is not yet valid
-- Only `active` may create or start games (enforced by Phase 2 triggers).

create or replace function public.access_state_for(p_user uuid)
returns table (state text, plan_code text, current_period_end timestamptz)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_ent record;
  v_sub record;
begin
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

-- What the signed-in subscriber may see about their own access.
create or replace function public.my_access_status()
returns table (state text, plan_code text, current_period_end timestamptz)
language sql stable security definer set search_path = '' as $$
  select * from public.access_state_for(auth.uid())
$$;

-- Admin console list. The role check is inside the function, so it is safe to
-- expose to `authenticated`.
create or replace function public.admin_list_subscribers()
returns table (
  user_id uuid, email text, display_name text, joined_at timestamptz,
  state text, plan_code text, current_period_end timestamptz
) language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  if not public.is_super_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    select p.id, p.email, p.display_name, p.created_at, a.state, a.plan_code, a.current_period_end
    from public.profiles p
    cross join lateral public.access_state_for(p.id) a
    where p.role = 'subscriber'
    order by p.created_at desc
    limit 200;
end $$;

-- Manual activation / suspension. Callable ONLY by the service role: the Next.js
-- handler authorizes the caller as super admin first (requireSuperAdmin).
create or replace function public.admin_set_subscription(
  p_user uuid, p_action text, p_plan_code text default null, p_days integer default null
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_plan uuid;
  v_target uuid;
  v_updated integer;
begin
  if not exists (select 1 from public.profiles where id = p_user and role = 'subscriber') then
    raise exception 'user_not_found' using errcode = 'P0001';
  end if;

  if p_action = 'activate' then
    select id into v_plan from public.subscription_plans where code = p_plan_code and is_active;
    if v_plan is null then raise exception 'unknown_plan' using errcode = 'P0001'; end if;
    if p_days is null or p_days < 1 or p_days > 366 then
      raise exception 'invalid_days' using errcode = 'P0001';
    end if;

    -- Reuse the user's current (live or suspended) row; otherwise start a new one
    -- so expired rows stay as history.
    select id into v_target from public.subscriptions
      where user_id = p_user and status in ('trialing', 'active', 'past_due', 'suspended')
      order by created_at desc limit 1 for update;
    if v_target is null then
      insert into public.subscriptions (user_id, plan_id, status, current_period_start, current_period_end)
      values (p_user, v_plan, 'active', now(), now() + make_interval(days => p_days));
    else
      update public.subscriptions
        set plan_id = v_plan, status = 'active', cancel_at_period_end = false,
            current_period_start = now(), current_period_end = now() + make_interval(days => p_days)
        where id = v_target;
    end if;

  elsif p_action = 'suspend' then
    update public.subscriptions set status = 'suspended'
      where user_id = p_user and status in ('trialing', 'active', 'past_due');
    get diagnostics v_updated = row_count;
    if v_updated = 0 then raise exception 'no_live_subscription' using errcode = 'P0001'; end if;

  else
    raise exception 'invalid_action' using errcode = 'P0001';
  end if;
end $$;

revoke all on function public.access_state_for(uuid), public.my_access_status(),
  public.admin_list_subscribers(), public.admin_set_subscription(uuid, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.my_access_status(), public.admin_list_subscribers() to authenticated;
grant execute on function public.access_state_for(uuid), public.admin_set_subscription(uuid, text, text, integer)
  to service_role;
