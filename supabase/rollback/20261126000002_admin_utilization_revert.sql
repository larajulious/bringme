-- Revert of 20261126000002_admin_utilization.sql (NOT a migration). Read-only function; nothing else to undo.
drop function if exists public.admin_utilization();
