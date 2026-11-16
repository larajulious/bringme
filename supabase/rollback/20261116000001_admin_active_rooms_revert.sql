-- Revert of 20261116000001_admin_active_rooms.sql (NOT a migration). Audit entries already written are kept.
drop function if exists public.admin_close_room(uuid, text);
drop function if exists public.admin_list_active_rooms();
