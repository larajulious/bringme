-- BringMe! Phase 3 / migration 1 of 2: new subscription state.
-- Kept in its own file because a new enum value cannot be used in the same
-- transaction that adds it.
alter type public.subscription_status add value if not exists 'suspended';
