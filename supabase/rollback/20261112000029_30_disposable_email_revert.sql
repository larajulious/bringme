-- Removes disposable email protection (migrations 20261112000029 + 000030). NOT a migration.
--
-- FIRST turn the hook off: Dashboard -> Authentication -> Hooks -> "Before User Created" -> disable.
-- If the hook still points at public.hook_before_user_created when it is dropped, Supabase Auth
-- fails every new signup.
--
-- Does not touch auth.users, profiles, passes, orders or any other data. To undo only a bad LIST
-- update, don't run this: use `npm run disposable:update -- --rollback` instead.

begin;
drop function if exists public.hook_before_user_created(jsonb);
drop function if exists public.disposable_email_list_status();
drop function if exists public.rollback_disposable_email_list(bigint);
drop function if exists public.apply_disposable_email_list(text[], text, text, integer, boolean);
drop function if exists public.is_disposable_email(text);
drop function if exists public.is_disposable_email_domain(text);
drop function if exists public.email_domain(text);
drop table if exists public.disposable_email_list_versions;
drop table if exists public.disposable_email_allowlist;
drop table if exists public.disposable_email_domains;
commit;
