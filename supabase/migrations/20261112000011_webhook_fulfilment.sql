-- BringMe! Game Pass 11: verified webhook fulfilment (Phase 6).
-- Re-runnable. Replaces apply_payment_event (copied from 20261112000009) with six edits,
-- each marked "Phase 6":
--   1. server-side rejections (organization, Polar paid status, billing reason) -> needs_review
--   2. buyer correlation: Polar customer.external_id must be this order's user
--   3. checkout correlation: the Polar order's checkout must be the one we created
--   4. exact amount (was "at least"): total = price (tax included) or net = price (tax on top)
--   5. Polar's "refunded" status = full refund even when refunded_amount (net) < price (tax incl.)
--   6. a refund already applied, seen again under a new event id, is a duplicate effect
-- The function is still ONE transaction: event row + order update + pass grant/revoke + audit
-- commit together or not at all, so a failed attempt leaves nothing and Polar's retry runs again.

do $$ begin
  if to_regprocedure('public.start_checkout_order(uuid, text, text, text, text)') is null then
    raise exception 'game_pass_precondition: apply 20261112000001..10 first';
  end if;
end $$;

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
        -- Phase 6: checks only the server can make (organization, Polar paid status, billing reason).
        when nullif(p_effect ->> 'reject_reason', '') is not null then left(p_effect ->> 'reject_reason', 60)
        when v_polar is null or char_length(v_polar) > 200 then 'invalid_polar_order_id'
        when exists (select 1 from public.pass_orders where polar_order_id = v_polar and id <> v_order.id) then 'polar_order_reused'
        -- Phase 4: verify against the ORDER's snapshot (environment + product chosen by the server).
        when v_order.polar_environment is not null and (p_effect ->> 'environment') is distinct from v_order.polar_environment then 'environment_mismatch'
        when coalesce(v_order.polar_product_id, v_price.polar_product_id) is null
          or (p_effect ->> 'polar_product_id') is distinct from coalesce(v_order.polar_product_id, v_price.polar_product_id) then 'product_mismatch'
        when v_order.polar_product_id is null and v_price.polar_price_id is not null
          and (p_effect ->> 'polar_price_id') is distinct from v_price.polar_price_id then 'price_mismatch'
        -- Phase 6: the buyer and the checkout must be the ones this order was created for.
        when p_effect ? 'external_customer_id' and (p_effect ->> 'external_customer_id') is distinct from v_order.user_id::text then 'customer_mismatch'
        when v_order.polar_checkout_id is not null and p_effect ? 'polar_checkout_id'
          and (p_effect ->> 'polar_checkout_id') is distinct from v_order.polar_checkout_id then 'checkout_mismatch'
        when v_cur <> v_order.currency then 'currency_mismatch'
        -- Phase 6: exact amount. Polar's total equals the price when tax is included in it; when tax
        -- was added on top, the net (after discounts, before tax) equals the price. Anything else -> review.
        when v_amount is null or (v_amount <> v_order.amount_minor
             and coalesce(case when (p_effect ->> 'net_amount_minor') ~ '^[0-9]{1,12}$' then (p_effect ->> 'net_amount_minor')::bigint end, -1) <> v_order.amount_minor)
          then 'amount_mismatch'
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
    -- Phase 6: the same refund seen again (new event id, e.g. re-derived from Polar's current
    -- state after an out-of-order delivery) is a no-op, not an "unexpected refund".
    if v_order.status = 'refunded' and v_amount is not null and v_amount <= v_order.refunded_amount_minor then
      v_outcome := 'duplicate_effect';
    elsif v_order.status not in ('paid', 'partially_refunded') or v_amount is null or v_amount > v_order.paid_amount_minor then
      perform public.log_entitlement_event(v_order.user_id, null, v_order.id, 'webhook', null, 'order_needs_review',
        jsonb_build_object('reason', 'unexpected_refund', 'refunded_amount_minor', v_amount, 'event_id', p_event_id));
      v_outcome := 'needs_review';
    elsif v_amount <= v_order.refunded_amount_minor then
      v_outcome := 'duplicate_effect';
    -- Phase 6: Polar's own "refunded" status is authoritative for a FULL refund (Polar refunds the
    -- net amount, which is below a tax-inclusive price, so the amounts alone would look partial).
    elsif v_amount >= v_order.paid_amount_minor or coalesce(p_effect ->> 'full', '') = 'true' then
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
