-- Revert of 20261116000003_admin_image_cleanup.sql (NOT a migration). Audit entries already written are kept.
-- Images already deleted from Storage cannot be restored; photo_deleted_at is dropped with the column.
drop function if exists public.admin_image_cleanup_history(integer);
drop function if exists public.admin_record_image_cleanup(integer, integer, jsonb);
drop function if exists public.admin_image_cleanup_candidates(text[], integer);
drop function if exists public.admin_list_images(text, timestamptz, timestamptz, text, integer, integer);
drop function if exists public.admin_image_summary();
drop function if exists public.image_cleanup_classify(text[]);
alter table public.submissions drop column if exists photo_deleted_at;
