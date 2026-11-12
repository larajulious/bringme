-- BringMe! Phase 2 / migration 3 of 3: private photo storage.
-- Bucket is private. Clients (anon/authenticated) can NEVER write to it:
-- guests upload through a server-issued, single-use signed upload URL, and the
-- host reads through short-lived signed URLs created under their own session.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('submissions', 'submissions', false, 5242880,
        array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Read: game owner (by path prefix = game id) or super admin.
-- No INSERT/UPDATE/DELETE policies exist for client roles => denied.
drop policy if exists "submissions_read_owner" on storage.objects;
create policy "submissions_read_owner" on storage.objects for select to authenticated
  using (bucket_id = 'submissions'
         and (public.owns_game_path(name) or (select public.is_super_admin())));
