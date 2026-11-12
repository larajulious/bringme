-- BringMe! Game Pass 1/7: enum types (own file; see GAME_PASS_DESIGN.md §4.2).
-- No behaviour change. Re-runnable: duplicate types are skipped.

do $$ begin
  create type public.pass_source as enum ('trial', 'purchase', 'admin_grant', 'legacy_subscription');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.pass_disposition as enum ('granted', 'revoked', 'forfeited');
exception when duplicate_object then null; end $$;

-- Payment state of one checkout attempt. Separate from entitlement on purpose:
-- an expired PASS is a consumed paid order, never a failed payment.
do $$ begin
  create type public.order_status as enum (
    'pending', 'paid', 'failed', 'expired', 'canceled', 'needs_review', 'refunded', 'partially_refunded');
exception when duplicate_object then null; end $$;
