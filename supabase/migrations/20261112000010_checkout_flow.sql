-- BringMe! Game Pass 10: secure one-time checkout flow (Phase 5).
-- Additive, re-runnable. Still NO entitlement from checkout: a pass is only ever created by
-- apply_payment_event('order_paid') after the verified webhook (Phase 6).
--
-- Adds:
--   * provider + checkout link/expiry on the order (trusted buyer/plan/price/currency/
--     correlation were already stored: user_id, plan_id, plan_price_id, amount_minor,
--     currency, polar_environment, polar_product_id, polar_checkout_id, metadata order id);
--   * start_checkout_order(): idempotent start. A double click / retry gets the SAME open,
--     still-valid checkout instead of a second order; a request racing an in-flight start
--     is told to wait for it;
--   * attach_verified_checkout() 8-arg version that also stores the checkout URL + expiry;
--   * my_checkout_status(): what the return page may show the host about THEIR checkout.

do $$ begin
  if to_regprocedure('public.create_checkout_order(uuid, text, text, text, text)') is null then
    raise exception 'game_pass_precondition: apply 20261112000001..9 first';
  end if;
end $$;

alter table public.pass_orders
  add column if not exists provider            text not null default 'polar' check (provider in ('polar')),
  add column if not exists checkout_url        text check (checkout_url is null or (checkout_url ~ '^https://' and char_length(checkout_url) <= 2083)),
  add column if not exists checkout_expires_at timestamptz;
comment on column public.pass_orders.checkout_url is 'Polar hosted checkout URL, stored only after verification; reused for double clicks while still valid.';

-- -------------------------------------------------------- verified attach (+url) ----
create or replace function public.attach_verified_checkout(
  p_order uuid, p_checkout_id text, p_product_id text, p_currency text,
  p_amount_minor integer, p_total_minor integer, p_url text, p_expires_at timestamptz
) returns text language plpgsql security definer set search_path = '' as $$
declare
  v_order public.pass_orders%rowtype;
  v_cur text := upper(coalesce(p_currency, ''));
  v_reason text;
begin
  select * into v_order from public.pass_orders where id = p_order for update;
  if not found or v_order.status <> 'pending' or v_order.polar_checkout_id is not null then
    raise exception 'order_not_attachable' using errcode = 'P0001';
  end if;
  v_reason := case
    when p_checkout_id is null or char_length(p_checkout_id) not between 1 and 200 then 'invalid_checkout'
    when exists (select 1 from public.pass_orders where polar_checkout_id = p_checkout_id) then 'checkout_reused'
    when p_url is not null and (p_url !~ '^https://' or char_length(p_url) > 2083) then 'invalid_checkout_url'
    when p_product_id is distinct from v_order.polar_product_id then 'product_mismatch'
    when v_cur <> v_order.currency then 'currency_mismatch'
    when p_amount_minor is distinct from v_order.amount_minor then 'amount_mismatch'
    when p_total_minor is not null and p_total_minor <> v_order.amount_minor then 'total_mismatch'
  end;
  update public.pass_orders
     set polar_checkout_id     = case when v_reason in ('invalid_checkout', 'checkout_reused') then null else p_checkout_id end,
         checkout_url          = case when v_reason is null then p_url end,
         checkout_expires_at   = case when v_reason is null then p_expires_at end,
         checkout_amount_minor = case when p_amount_minor >= 0 then p_amount_minor end,
         checkout_total_minor  = case when p_total_minor >= 0 then p_total_minor end,
         checkout_currency     = case when v_cur ~ '^[A-Z]{3}$' then v_cur end,
         checkout_verified_at  = now(),
         status                = case when v_reason is null then status else 'canceled'::public.order_status end,
         closed_at             = case when v_reason is null then closed_at else now() end,
         review_reason         = case when v_reason is null then review_reason else 'checkout_' || v_reason end
   where id = p_order;
  perform public.log_entitlement_event(v_order.user_id, null, p_order, 'system', null,
    case when v_reason is null then 'checkout_verified' else 'checkout_rejected' end,
    jsonb_build_object('reason', v_reason, 'checkout_currency', v_cur, 'checkout_amount_minor', p_amount_minor,
                       'checkout_total_minor', p_total_minor, 'expected_currency', v_order.currency,
                       'expected_amount_minor', v_order.amount_minor));
  return coalesce(v_reason, 'ok');
end $$;

-- The Phase 4 signature keeps working (no URL stored => never reused).
create or replace function public.attach_verified_checkout(
  p_order uuid, p_checkout_id text, p_product_id text, p_currency text, p_amount_minor integer, p_total_minor integer
) returns text language sql security definer set search_path = '' as $$
  select public.attach_verified_checkout(p_order, p_checkout_id, p_product_id, p_currency, p_amount_minor, p_total_minor,
                                         null::text, null::timestamptz)
$$;

-- ------------------------------------------------------- idempotent start ----
-- Same host + plan + currency + environment + product, still pending:
--   * verified link valid for >= 2 more minutes and created within 30 min  -> reuse it
--   * no link yet and created within 60 s (another request is calling Polar) -> in_flight
-- Otherwise a new order (create_checkout_order: same validation, 3-pending cap, 24 h expiry).
create or replace function public.start_checkout_order(
  p_user uuid, p_plan_code text, p_currency text, p_environment text, p_polar_product_id text
) returns table (order_id uuid, amount_minor integer, currency text, reused boolean, in_flight boolean, checkout_url text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_cur text := upper(btrim(coalesce(p_currency, '')));
  v_o   record;
begin
  perform 1 from public.profiles where id = p_user and role = 'subscriber' for update;
  if found
     and not exists (select 1 from public.profiles where id = p_user and (deactivated_at is not null or hosting_suspended_at is not null)) then
    select o.id, o.amount_minor, o.currency, o.checkout_url, o.checkout_expires_at, o.created_at into v_o
      from public.pass_orders o
      join public.subscription_plans p on p.id = o.plan_id and p.code = p_plan_code and p.is_active
      join public.plan_prices pp on pp.id = o.plan_price_id and pp.is_active and pp.amount_minor = o.amount_minor
     where o.user_id = p_user and o.status = 'pending' and o.currency = v_cur
       and o.polar_environment = p_environment and o.polar_product_id = lower(p_polar_product_id)
       and ((o.checkout_url is not null and o.checkout_expires_at > now() + interval '2 minutes'
             and o.created_at > now() - interval '30 minutes')
         or (o.checkout_url is null and o.polar_checkout_id is null and o.created_at > now() - interval '60 seconds'))
     order by o.created_at desc
     limit 1;
    if v_o.id is not null then
      return query select v_o.id, v_o.amount_minor, v_o.currency, v_o.checkout_url is not null, v_o.checkout_url is null, v_o.checkout_url;
      return;
    end if;
  end if;
  return query select c.order_id, c.amount_minor, c.currency, false, false, null::text
    from public.create_checkout_order(p_user, p_plan_code, p_currency, p_environment, lower(p_polar_product_id)) c;
end $$;

-- ------------------------------------------------------------ host status ----
-- Status of the CALLER's checkout (found by the Polar checkout id in the success URL).
-- Read-only; never grants anything. 'confirmed' requires a paid order AND its pass.
create or replace function public.my_checkout_status(p_checkout_id text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_o record;
  v_pass boolean;
begin
  if auth.uid() is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  select o.id, o.status, o.currency, o.amount_minor, o.polar_environment, o.checkout_url, o.checkout_expires_at,
         p.code as plan_code, p.name as plan_name
    into v_o
    from public.pass_orders o join public.subscription_plans p on p.id = o.plan_id
   where o.polar_checkout_id = p_checkout_id and o.user_id = auth.uid();
  if v_o.id is null then return jsonb_build_object('found', false); end if;
  v_pass := exists (select 1 from public.game_passes g where g.order_id = v_o.id and g.disposition = 'granted');
  return jsonb_build_object(
    'found', true,
    'orderId', v_o.id,
    'status', v_o.status,
    'planCode', v_o.plan_code,
    'planName', v_o.plan_name,
    'currency', v_o.currency,
    'amountMinor', v_o.amount_minor,
    'environment', v_o.polar_environment,
    'passGranted', v_pass,
    -- only offered back while the hosted checkout is still open and unpaid
    'resumeUrl', case when v_o.status = 'pending' and v_o.checkout_expires_at > now() then v_o.checkout_url end
  );
end $$;

revoke all on function
  public.attach_verified_checkout(uuid, text, text, text, integer, integer, text, timestamptz),
  public.attach_verified_checkout(uuid, text, text, text, integer, integer),
  public.start_checkout_order(uuid, text, text, text, text),
  public.my_checkout_status(text)
  from public, anon, authenticated;
grant execute on function
  public.attach_verified_checkout(uuid, text, text, text, integer, integer, text, timestamptz),
  public.attach_verified_checkout(uuid, text, text, text, integer, integer),
  public.start_checkout_order(uuid, text, text, text, text)
  to service_role;
grant execute on function public.my_checkout_status(text) to authenticated;
