-- BringMe! Game Pass 4/7: payment side (orders + webhook inbox).
-- New, empty tables => no behaviour change. Re-runnable. Polar checkout itself is
-- NOT implemented here (Phase 3); these tables only hold verified evidence.

do $$ begin
  if to_regclass('public.game_passes') is null or to_regclass('public.plan_prices') is null then
    raise exception 'game_pass_precondition: apply 20261112000002 and 20261112000003 first';
  end if;
end $$;

-- -------------------------------------------------------------- pass_orders ----
create table if not exists public.pass_orders (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references public.profiles (id) on delete restrict,
  plan_id               uuid not null references public.subscription_plans (id) on delete restrict,
  plan_price_id         uuid not null references public.plan_prices (id) on delete restrict,
  currency              text not null check (currency in ('PHP', 'USD')),          -- snapshot
  amount_minor          integer not null check (amount_minor > 0),                -- snapshot (expected)
  status                public.order_status not null default 'pending',
  polar_checkout_id     text check (polar_checkout_id is null or char_length(polar_checkout_id) between 1 and 200),
  polar_order_id        text check (polar_order_id is null or char_length(polar_order_id) between 1 and 200),
  polar_customer_id     text check (polar_customer_id is null or char_length(polar_customer_id) between 1 and 200),
  paid_amount_minor     integer check (paid_amount_minor is null or paid_amount_minor >= 0),   -- evidence
  paid_currency         text check (paid_currency is null or paid_currency ~ '^[A-Z]{3}$'),     -- evidence
  refunded_amount_minor integer not null default 0 check (refunded_amount_minor >= 0),
  review_reason         text check (review_reason is null or char_length(review_reason) <= 500),
  created_at            timestamptz not null default now(),
  paid_at               timestamptz,
  closed_at             timestamptz,
  updated_at            timestamptz not null default now(),
  constraint pass_orders_polar_checkout_key unique (polar_checkout_id),
  constraint pass_orders_polar_order_key unique (polar_order_id),
  constraint pass_orders_paid_evidence check (
    status not in ('paid', 'refunded', 'partially_refunded')
    or (paid_at is not null and polar_order_id is not null and paid_amount_minor is not null and paid_currency is not null)),
  constraint pass_orders_refund_le_paid check (refunded_amount_minor <= coalesce(paid_amount_minor, 0))
);
comment on table public.pass_orders is
  'One checkout attempt and its PAYMENT state. Only the transition to paid creates a pass (game_passes.order_id).';
create index if not exists pass_orders_user_idx on public.pass_orders (user_id, created_at desc);
create index if not exists pass_orders_pending_idx on public.pass_orders (user_id) where status = 'pending';

-- Monotonic, audited state machine (GAME_PASS_DESIGN.md §2.1). Late "paid" evidence
-- for an expired/canceled order goes to needs_review: real money is never ignored.
create or replace function public.guard_pass_order()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'orders_are_never_deleted' using errcode = '42501';
  end if;
  if new.id <> old.id or new.user_id <> old.user_id or new.plan_id <> old.plan_id
     or new.plan_price_id <> old.plan_price_id or new.currency <> old.currency
     or new.amount_minor <> old.amount_minor or new.created_at <> old.created_at then
    raise exception 'immutable order column' using errcode = '42501';
  end if;
  if old.polar_checkout_id is not null and new.polar_checkout_id is distinct from old.polar_checkout_id then
    raise exception 'polar_checkout_id_immutable' using errcode = '42501';
  end if;
  if old.polar_order_id is not null and new.polar_order_id is distinct from old.polar_order_id then
    raise exception 'polar_order_id_immutable' using errcode = '42501';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'pending'            and new.status in ('paid', 'failed', 'expired', 'canceled', 'needs_review'))
    or (old.status in ('expired', 'canceled', 'failed') and new.status = 'needs_review')
    or (old.status = 'needs_review'       and new.status in ('paid', 'canceled'))
    or (old.status = 'paid'               and new.status in ('refunded', 'partially_refunded'))
    or (old.status = 'partially_refunded' and new.status = 'refunded')) then
    raise exception 'invalid_order_transition' using errcode = 'P0001';
  end if;
  if new.refunded_amount_minor < old.refunded_amount_minor then
    raise exception 'refund_amount_cannot_decrease' using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists guard_pass_order on public.pass_orders;
create trigger guard_pass_order before update or delete on public.pass_orders
  for each row execute function public.guard_pass_order();
drop trigger if exists pass_orders_no_truncate on public.pass_orders;
create trigger pass_orders_no_truncate before truncate on public.pass_orders
  for each statement execute function public.guard_append_only();

-- ------------------------------------------------- foreign keys into orders ----
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'game_passes_order_fkey') then
    alter table public.game_passes add constraint game_passes_order_fkey
      foreign key (order_id) references public.pass_orders (id) on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'entitlement_events_order_fkey') then
    alter table public.entitlement_events add constraint entitlement_events_order_fkey
      foreign key (order_id) references public.pass_orders (id) on delete restrict;
  end if;
end $$;

-- ----------------------------------------------------------- payment_events ----
-- Verified webhook inbox. (provider, event_id) is the idempotency key: the insert and
-- every effect of the event happen in ONE transaction (apply_payment_event), so a
-- failed attempt leaves no row and the provider's retry is processed normally.
create table if not exists public.payment_events (
  id            bigint generated always as identity primary key,
  provider      text not null default 'polar' check (provider in ('polar')),
  event_id      text not null check (char_length(event_id) between 1 and 200),
  event_type    text not null check (char_length(event_type) between 1 and 100),
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  outcome       text check (outcome in ('applied', 'duplicate_effect', 'ignored', 'unmatched', 'needs_review')),
  order_id      uuid references public.pass_orders (id) on delete restrict,
  payload       jsonb not null,
  constraint payment_events_provider_event_key unique (provider, event_id)
);
create index if not exists payment_events_order_idx on public.payment_events (order_id);

-- ---------------------------------------------------------- grants / RLS ----
alter table public.pass_orders    enable row level security;
alter table public.payment_events enable row level security;
revoke all on public.pass_orders, public.payment_events from public, anon, authenticated;
grant all on public.pass_orders, public.payment_events to service_role;
-- Hosts see their own orders' payment state; never Polar identifiers or review notes.
grant select (id, user_id, plan_id, currency, amount_minor, status, refunded_amount_minor, created_at, paid_at, closed_at)
  on public.pass_orders to authenticated;
drop policy if exists orders_select_own on public.pass_orders;
create policy orders_select_own on public.pass_orders for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists orders_select_admin on public.pass_orders;
create policy orders_select_admin on public.pass_orders for select to authenticated using ((select public.is_super_admin()));
-- payment_events: service role only (RLS on, no client policy, no client grant).

revoke all on function public.guard_pass_order() from public, anon, authenticated;
