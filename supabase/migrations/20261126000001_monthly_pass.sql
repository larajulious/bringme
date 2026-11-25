-- BringMe! Monthly — 30-Day Game Pass.
-- Additive, re-runnable. A ONE-TIME pass like the others (no recurring billing), only longer.
--
-- Nothing else in the database changes: grants read subscription_plans.duration_seconds
-- (apply_payment_event / webhook fulfilment), and the pass queue orders by the max_players
-- snapshot, so this plan slots in between Starter (10) and Party (50):
--   a Party or Pro purchase pre-empts an active Monthly (its unused days resume later);
--   a Monthly bought while Party/Pro is active is queued after it.
-- Tier 4 is for display order and uniqueness only (see 20261112000002).
--
-- Polar: one-time product "BringMe! Monthly — 30-Day Game Pass" with fixed USD 9.99 + PHP 599.00,
-- mapped per deployment by POLAR_PRODUCT_ID_MONTHLY (POLAR_PRODUCT_SETUP.md §1).

insert into public.subscription_plans
  (code, name, description, price_cents, max_active_games, max_players_per_game, max_rounds_per_game,
   max_games_per_period, tier, is_trial, sort_order, duration_seconds, is_active)
values
  ('monthly', 'Monthly', 'A whole month of hosting', 0, 3, 40, 15, null, 4, false, 4, 2592000, true)  -- 30 days, exact seconds
on conflict (code) do nothing;   -- never overwrite admin edits on re-run

-- Prices in minor units: PHP 599.00, USD 9.99. Existing active rows are never overwritten.
insert into public.plan_prices (plan_id, currency, amount_minor)
select p.id, v.currency, v.amount
from (values ('PHP', 59900), ('USD', 999)) as v(currency, amount)
join public.subscription_plans p on p.code = 'monthly'
on conflict (plan_id, currency) where is_active do nothing;
