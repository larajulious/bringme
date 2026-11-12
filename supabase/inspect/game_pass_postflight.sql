-- BringMe! Game Pass — POST-MIGRATION verification. READ-ONLY.
-- Run right after 20261112000007. Expected results are in the comments.

-- Q1. Row counts: identical to preflight P1, except subscription_plans +1 (trial).
select 'profiles' t, count(*) from public.profiles
union all select 'subscription_plans', count(*) from public.subscription_plans
union all select 'subscriptions', count(*) from public.subscriptions
union all select 'games', count(*) from public.games
union all select 'game_rounds', count(*) from public.game_rounds
union all select 'players', count(*) from public.players
union all select 'submissions', count(*) from public.submissions
union all select 'game_passes', count(*) from public.game_passes            -- = subscriptions count
union all select 'pass_segments', count(*) from public.pass_segments;

-- Q2. Final plans: trial 3 / starter 10 / party 50 / pro 100, all 604800 s.
select code, tier, is_trial, max_players_per_game, duration_seconds, max_active_games, max_rounds_per_game, max_games_per_period
from public.subscription_plans where code in ('trial', 'starter', 'party', 'pro') order by tier;

-- Q3. Prices (8 rows): PHP 0/9900/19900/29900, USD 0/199/349/499.
select p.code, pp.currency, pp.amount_minor, to_char(pp.amount_minor / 100.0, 'FM999990.00') as display,
       pp.polar_product_id is not null as purchasable
from public.plan_prices pp join public.subscription_plans p on p.id = pp.plan_id where pp.is_active order by p.tier, pp.currency;

-- Q4. Every subscription mirrored exactly (expect 0 rows).
select s.id from public.subscriptions s
left join public.game_passes g on g.legacy_subscription_id = s.id
where g.id is null and coalesce(s.external_ref, '') not like 'ledger_projection:%';
select s.id from public.subscriptions s
join public.game_passes g on g.legacy_subscription_id = s.id
join public.pass_segments sg on sg.pass_id = g.id
where s.status in ('trialing', 'active', 'suspended') and s.current_period_end > now()
  and (sg.starts_at <> s.current_period_start or sg.ends_at <> s.current_period_end);

-- Q5. The live subscriber is still active on Starter until 2026-12-11 08:26:51 UTC.
select pr.email, a.* from public.profiles pr cross join lateral public.access_state_for(pr.id) a
where pr.role = 'subscriber' order by pr.email;

-- Q6. No overlapping access (expect 0).
select count(*) as overlaps from public.pass_segments a join public.pass_segments b
  on a.user_id = b.user_id and a.id < b.id
 and tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(b.starts_at, b.ends_at, '[)');

-- Q7. No client role can write the new tables (expect all false).
select t, has_table_privilege('authenticated', t, 'INSERT') or has_table_privilege('authenticated', t, 'UPDATE')
       or has_table_privilege('authenticated', t, 'DELETE') or has_table_privilege('anon', t, 'INSERT') as client_can_write
from unnest(array['public.game_passes', 'public.pass_segments', 'public.pass_orders',
                  'public.payment_events', 'public.entitlement_events', 'public.plan_prices']) t;
select relname, relrowsecurity as rls_on from pg_class
where relnamespace = 'public'::regnamespace and relname in
  ('game_passes', 'pass_segments', 'pass_orders', 'payment_events', 'entitlement_events', 'plan_prices');

-- Q8. Functions that must be server-only (expect false for both roles on every row).
select p.proname, has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec
from pg_proc p where p.pronamespace = 'public'::regnamespace
  and p.proname in ('apply_payment_event', 'create_pass_order', 'attach_checkout', 'admin_grant_pass', 'admin_revoke_pass',
                    'admin_set_suspended', 'admin_set_pass_plan', 'admin_set_pass_expiry', 'admin_review_order',
                    'grant_pass', 'revoke_pass', 'replan_passes', 'pass_entitlement', 'game_capacity')
order by 1;

-- Q9. Existing games unchanged (compare with a pre-migration snapshot of the same query).
select id, status, phase, max_players, state_version, created_at from public.games order by created_at;

-- Q10. Audit trail of the migration (one legacy_backfill event per subscription).
select action, actor_kind, count(*) from public.entitlement_events group by 1, 2 order by 1;
