-- Stale pending orders no longer block a new purchase (see cleanup comment inside).
create or replace function public.start_checkout_order(
  p_user uuid, p_plan_code text, p_currency text, p_environment text, p_polar_product_id text
) returns table (order_id uuid, amount_minor integer, currency text, reused boolean, in_flight boolean, checkout_url text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_cur text := upper(btrim(coalesce(p_currency, '')));
  v_o   record;
begin
  -- Dead pending orders must never block a host from buying again (3 pending = limit):
  --  * no hosted checkout was ever attached and it is older than 2 minutes (Polar refused / request died),
  --  * the hosted checkout has expired (unpaid),
  --  * it belongs to the other Polar environment (e.g. old sandbox tests).
  -- A live, unexpired checkout is never touched, so a payment in progress is safe.
  update public.pass_orders set status = 'expired', closed_at = now()
   where user_id = p_user and status = 'pending'
     and ((checkout_url is null and polar_checkout_id is null and created_at < now() - interval '2 minutes')
       or (checkout_expires_at is not null and checkout_expires_at < now())
       or (polar_environment is not null and polar_environment <> p_environment));
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

revoke all on function public.start_checkout_order(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.start_checkout_order(uuid, text, text, text, text) to service_role;
