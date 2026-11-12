-- BringMe! Game Pass 9: Polar product / regional price mapping (Phase 4).
-- Additive, re-runnable. No behaviour change for existing data (no orders exist yet).
--
-- Why: Polar product ids differ between SANDBOX and PRODUCTION, while this database may be
-- shared by both deployments. So the product map lives in server env vars (per deployment),
-- and every order SNAPSHOTS what it was created for: environment + Polar product id. The
-- webhook (apply_payment_event) and the checkout check verify against that snapshot, never
-- against client input. plan_prices stays the source of truth for the AMOUNTS (PHP and USD
-- set independently, minor units); plan_prices.polar_product_id is no longer used for new
-- orders (kept for history / the legacy create_pass_order path).
--
-- Checkout safety (POLAR_PRODUCT_SETUP.md): Polar chooses the checkout currency itself
-- (geolocation, default-currency fallback). The server records what Polar's checkout
-- response says it will charge; anything other than the exact price the host was shown
-- cancels the order before the host is ever redirected (no silent USD for a PHP price).

do $$ begin
  if to_regprocedure('public.apply_payment_event(text, text, text, jsonb, jsonb)') is null then
    raise exception 'game_pass_precondition: apply 20261112000001..8 first';
  end if;
end $$;

-- ------------------------------------------------------------- order snapshot ----
alter table public.pass_orders
  add column if not exists polar_environment       text check (polar_environment is null or polar_environment in ('sandbox', 'production')),
  add column if not exists polar_product_id        text check (polar_product_id is null or char_length(polar_product_id) between 1 and 200),
  add column if not exists checkout_amount_minor   integer check (checkout_amount_minor is null or checkout_amount_minor >= 0),
  add column if not exists checkout_total_minor    integer check (checkout_total_minor is null or checkout_total_minor >= 0),
  add column if not exists checkout_currency       text check (checkout_currency is null or checkout_currency ~ '^[A-Z]{3}$'),
  add column if not exists checkout_verified_at    timestamptz;
comment on column public.pass_orders.polar_environment is 'Polar environment the checkout was created in (sandbox | production). Webhooks from the other one never pay it.';
comment on column public.pass_orders.polar_product_id  is 'Polar product the server chose for this plan + environment (from env config), snapshotted at order time.';
comment on column public.pass_orders.checkout_amount_minor is 'What Polar''s checkout response said it will charge (minor units) — must equal amount_minor.';
comment on column public.plan_prices.polar_product_id  is 'DEPRECATED for new orders (Phase 4): product ids are per environment and come from server env vars; see pass_orders.polar_product_id.';

-- immutability of the snapshot (in addition to guard_pass_order's existing rules)
create or replace function public.guard_order_snapshot()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (old.polar_environment is not null and new.polar_environment is distinct from old.polar_environment)
     or (old.polar_product_id is not null and new.polar_product_id is distinct from old.polar_product_id)
     or (old.checkout_verified_at is not null and (new.checkout_amount_minor is distinct from old.checkout_amount_minor
         or new.checkout_currency is distinct from old.checkout_currency or new.checkout_total_minor is distinct from old.checkout_total_minor)) then
    raise exception 'order_snapshot_immutable' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists guard_order_snapshot on public.pass_orders;
create trigger guard_order_snapshot before update on public.pass_orders
  for each row execute function public.guard_order_snapshot();

-- --------------------------------------------------------------- create order ----
-- The server passes the environment and the product id it resolved from ITS env config for
-- this plan; the host only chooses (plan code, currency). Amount comes from plan_prices.
create or replace function public.create_checkout_order(
  p_user uuid, p_plan_code text, p_currency text, p_environment text, p_polar_product_id text
) returns table (order_id uuid, amount_minor integer, currency text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_cur   text := upper(btrim(coalesce(p_currency, '')));
  v_plan  record;
  v_price record;
  v_id    uuid;
  r       record;
begin
  if p_environment is null or p_environment not in ('sandbox', 'production') then
    raise exception 'invalid_environment' using errcode = 'P0001';
  end if;
  if p_polar_product_id is null or p_polar_product_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'plan_not_purchasable' using errcode = 'P0001';
  end if;
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
  select pp.id, pp.amount_minor into v_price
    from public.plan_prices pp where pp.plan_id = v_plan.id and pp.currency = v_cur and pp.is_active;
  if not found or v_price.amount_minor <= 0 then
    raise exception 'plan_not_purchasable' using errcode = 'P0001';
  end if;

  for r in select o.id from public.pass_orders o
            where o.user_id = p_user and o.status = 'pending' and o.created_at < now() - interval '24 hours' loop
    update public.pass_orders set status = 'expired', closed_at = now() where id = r.id;
    perform public.log_entitlement_event(p_user, null, r.id, 'system', null, 'order_expired', jsonb_build_object('reason', 'abandoned'));
  end loop;
  if (select count(*) from public.pass_orders o where o.user_id = p_user and o.status = 'pending') >= 3 then
    raise exception 'too_many_pending_orders' using errcode = 'P0001';
  end if;

  insert into public.pass_orders (user_id, plan_id, plan_price_id, currency, amount_minor, polar_environment, polar_product_id)
  values (p_user, v_plan.id, v_price.id, v_cur, v_price.amount_minor, p_environment, p_polar_product_id)
  returning id into v_id;
  perform public.log_entitlement_event(p_user, null, v_id, 'host', p_user, 'order_created',
    jsonb_build_object('plan', v_plan.code, 'currency', v_cur, 'amount_minor', v_price.amount_minor,
                       'environment', p_environment, 'polar_product_id', p_polar_product_id));
  return query select v_id, v_price.amount_minor, v_cur;
end $$;

-- ------------------------------------------------------------ verify checkout ----
-- Records Polar's checkout response and accepts it ONLY if Polar will charge exactly the
-- order's price, in the order's currency, for the order's product. Otherwise the order is
-- canceled (audited) and the host must not be redirected. Returns 'ok' or the reason.
create or replace function public.attach_verified_checkout(
  p_order uuid, p_checkout_id text, p_product_id text, p_currency text,
  p_amount_minor integer, p_total_minor integer
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
    when p_product_id is distinct from v_order.polar_product_id then 'product_mismatch'
    when v_cur <> v_order.currency then 'currency_mismatch'
    when p_amount_minor is distinct from v_order.amount_minor then 'amount_mismatch'
    when p_total_minor is not null and p_total_minor <> v_order.amount_minor then 'total_mismatch'
  end;
  update public.pass_orders
     set polar_checkout_id     = case when v_reason in ('invalid_checkout', 'checkout_reused') then null else p_checkout_id end,
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

-- Closes an order whose checkout was never handed to the host (Polar request failed, or the
-- response failed verification). The URL is only returned after verification, so the host
-- can't be paying it; a late payment would still land in needs_review, never as a pass.
create or replace function public.cancel_unstarted_order(p_order uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
begin
  update public.pass_orders set status = 'canceled', closed_at = now(), review_reason = left('checkout_' || coalesce(p_reason, 'error'), 500)
   where id = p_order and status = 'pending'
   returning user_id into v_user;
  if v_user is not null then
    perform public.log_entitlement_event(v_user, null, p_order, 'system', null, 'order_canceled', jsonb_build_object('reason', p_reason));
  end if;
end $$;

-- ------------------------------------------------- webhook: verify the snapshot ----
-- apply_payment_event from 20261112000005 with ONE edit: product/environment are checked
-- against the order's snapshot (falling back to plan_prices for orders made without one).
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
        -- Phase 4: verify against the ORDER's snapshot (environment + product chosen by the server).
        when v_order.polar_environment is not null and (p_effect ->> 'environment') is distinct from v_order.polar_environment then 'environment_mismatch'
        when coalesce(v_order.polar_product_id, v_price.polar_product_id) is null
          or (p_effect ->> 'polar_product_id') is distinct from coalesce(v_order.polar_product_id, v_price.polar_product_id) then 'product_mismatch'
        when v_order.polar_product_id is null and v_price.polar_price_id is not null
          and (p_effect ->> 'polar_price_id') is distinct from v_price.polar_price_id then 'price_mismatch'
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

revoke all on function public.guard_order_snapshot(),
  public.create_checkout_order(uuid, text, text, text, text),
  public.attach_verified_checkout(uuid, text, text, text, integer, integer),
  public.cancel_unstarted_order(uuid, text)
  from public, anon, authenticated;
grant execute on function public.create_checkout_order(uuid, text, text, text, text),
  public.attach_verified_checkout(uuid, text, text, text, integer, integer),
  public.cancel_unstarted_order(uuid, text)
  to service_role;
