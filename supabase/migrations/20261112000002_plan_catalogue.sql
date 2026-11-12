-- BringMe! Game Pass 2/7: plan catalogue + separate PHP / USD prices.
-- Additive only. No behaviour change for existing hosts (entitlement still reads
-- public.subscriptions until 20261112000007). Re-runnable.
--
-- Reuses public.subscription_plans (stable external key = code). Adds:
--   tier / duration_seconds / is_trial / sort_order
--   public.plan_prices: one ACTIVE row per (plan, currency), integer minor units.
-- Legacy price columns (price_cents, currency, and on upgraded projects `price`)
-- are kept untouched and marked deprecated.

-- ------------------------------------------------------------- preconditions ----
do $$
declare
  missing text;
begin
  if to_regclass('public.subscription_plans') is null then
    raise exception 'game_pass_precondition: public.subscription_plans does not exist (apply 20261111000001 first)';
  end if;
  select string_agg(c, ', ') into missing
    from unnest(array['code', 'name', 'is_active', 'max_players_per_game', 'max_active_games', 'max_rounds_per_game']) c
   where not exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = 'subscription_plans' and column_name = c);
  if missing is not null then
    -- This is exactly the 42703 family (p.code / p.max_active_games) from the audit:
    -- the legacy table was kept by CREATE TABLE IF NOT EXISTS.
    raise exception 'game_pass_precondition: subscription_plans lacks [%]; apply 20261110000000_legacy_schema_compat.sql and 20261111000001..12 first', missing;
  end if;
  if not exists (
    select 1 from pg_index i
    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
    where i.indrelid = 'public.subscription_plans'::regclass and i.indisunique and i.indnatts = 1
      and i.indpred is null and a.attname = 'code') then
    raise exception 'game_pass_precondition: no unique key on subscription_plans(code)';
  end if;
end $$;

-- ------------------------------------------------------------- plan columns ----
alter table public.subscription_plans
  add column if not exists tier             smallint,
  add column if not exists duration_seconds integer  not null default 604800,
  add column if not exists is_trial         boolean  not null default false,
  add column if not exists sort_order       smallint not null default 0;

comment on column public.subscription_plans.tier is
  'Catalogue tier (trial 0, starter 1, party 2, pro 3). Passes are ordered by their max_players snapshot; tier is for display and uniqueness.';
comment on column public.subscription_plans.duration_seconds is
  'Length of one pass in exact seconds (604800 = 7 days). Never use interval ''7 days'' (DST-dependent).';
comment on column public.subscription_plans.price_cents is 'DEPRECATED (Game Pass): prices live in public.plan_prices.';
comment on column public.subscription_plans.currency    is 'DEPRECATED (Game Pass): prices live in public.plan_prices.';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'subscription_plans_duration_seconds_check') then
    alter table public.subscription_plans add constraint subscription_plans_duration_seconds_check
      check (duration_seconds between 3600 and 31622400);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'subscription_plans_tier_check') then
    alter table public.subscription_plans add constraint subscription_plans_tier_check
      check (tier is null or tier between 0 and 100);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'subscription_plans_trial_tier_check') then
    alter table public.subscription_plans add constraint subscription_plans_trial_tier_check
      check (is_trial = coalesce(tier = 0, false));
  end if;
end $$;

-- ---------------------------------------------------------------- catalogue ----
-- Insert-if-missing with the audited seed values; for existing rows only the NEW
-- columns are set, so admin-edited limits (open games, rounds, period cap) stay.
-- Pro 200 -> 100 players happens in 20261112000006, AFTER legacy passes snapshot their cap.
insert into public.subscription_plans
  (code, name, description, price_cents, max_active_games, max_players_per_game, max_rounds_per_game,
   tier, is_trial, sort_order, duration_seconds)
values
  ('trial',   'Free Trial', 'Try BringMe! free for 7 days', 0, 1,   3,  5, 0, true,  0, 604800),
  ('starter', 'Starter',    'Small get-togethers',          0, 1,  10,  5, 1, false, 1, 604800),
  ('party',   'Party',      'Regular game nights',          0, 3,  50, 15, 2, false, 2, 604800),
  ('pro',     'Pro',        'Events and communities',       0, 10, 100, 40, 3, false, 3, 604800)
on conflict (code) do update
  set tier = excluded.tier, is_trial = excluded.is_trial,
      sort_order = excluded.sort_order, duration_seconds = excluded.duration_seconds;

create unique index if not exists subscription_plans_tier_active
  on public.subscription_plans (tier) where is_active and tier is not null;

-- -------------------------------------------------------------- plan_prices ----
create table if not exists public.plan_prices (
  id               uuid primary key default gen_random_uuid(),
  plan_id          uuid not null references public.subscription_plans (id) on delete restrict,
  currency         text not null check (currency in ('PHP', 'USD')),     -- ISO 4217; both have 2 minor digits
  amount_minor     integer not null check (amount_minor between 0 and 100000000),
  polar_product_id text check (polar_product_id is null or char_length(polar_product_id) between 1 and 200),
  polar_price_id   text check (polar_price_id is null or char_length(polar_price_id) between 1 and 200),
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
comment on table public.plan_prices is
  'Fixed price of a plan in ONE currency (PHP and USD are configured separately, never converted). '
  'Price change = deactivate the old row and insert a new one; orders reference the row they used.';
create unique index if not exists plan_prices_one_active on public.plan_prices (plan_id, currency) where is_active;
create unique index if not exists plan_prices_polar_ref
  on public.plan_prices (polar_product_id, coalesce(polar_price_id, '')) where polar_product_id is not null;
create index if not exists plan_prices_plan_idx on public.plan_prices (plan_id);

-- Zero is allowed only for the trial plan, and the trial plan may only cost zero.
create or replace function public.guard_plan_price()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_trial boolean;
begin
  select is_trial into v_trial from public.subscription_plans where id = new.plan_id;
  if v_trial and new.amount_minor <> 0 then
    raise exception 'trial_price_must_be_zero' using errcode = '23514';
  end if;
  if not v_trial and new.amount_minor = 0 then
    raise exception 'paid_price_must_be_positive' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and (new.plan_id <> old.plan_id or new.currency <> old.currency) then
    raise exception 'plan_price_identity_immutable' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists guard_plan_price on public.plan_prices;
create trigger guard_plan_price before insert or update on public.plan_prices
  for each row execute function public.guard_plan_price();
drop trigger if exists set_updated_at on public.plan_prices;
create trigger set_updated_at before update on public.plan_prices
  for each row execute function public.set_updated_at();

-- Final prices (minor units): PHP 99.00 / 199.00 / 299.00, USD 1.99 / 3.49 / 4.99; trial 0.
-- Existing active rows are never overwritten (an admin may have changed a price).
insert into public.plan_prices (plan_id, currency, amount_minor)
select p.id, v.currency, v.amount
from (values ('trial', 'PHP', 0), ('trial', 'USD', 0),
             ('starter', 'PHP', 9900), ('starter', 'USD', 199),
             ('party', 'PHP', 19900),  ('party', 'USD', 349),
             ('pro', 'PHP', 29900),    ('pro', 'USD', 499)) as v(code, currency, amount)
join public.subscription_plans p on p.code = v.code
on conflict (plan_id, currency) where is_active do nothing;

-- ---------------------------------------------------------- grants / RLS ----
alter table public.plan_prices enable row level security;
revoke all on public.plan_prices from public, anon, authenticated;
grant all on public.plan_prices to service_role;
-- Public pricing page: amounts only (no Polar identifiers).
grant select (id, plan_id, currency, amount_minor, is_active) on public.plan_prices to anon, authenticated;

drop policy if exists plan_prices_select_active on public.plan_prices;
create policy plan_prices_select_active on public.plan_prices for select to anon, authenticated
  using (is_active and exists (select 1 from public.subscription_plans p where p.id = plan_id and p.is_active));
drop policy if exists plan_prices_select_admin on public.plan_prices;
create policy plan_prices_select_admin on public.plan_prices for select to authenticated
  using ((select public.is_super_admin()));

revoke all on function public.guard_plan_price() from public, anon, authenticated;
