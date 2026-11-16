-- Super Admin: Image Storage Cleanup (Storage Management -> Image Cleanup). Manual only: no schedule, no cron.
--
-- Scope: ONLY objects in the private 'submissions' bucket whose name is a Bring Me photo path
-- '<game>/<round>/<player>.(jpg|png|webp)' where the round and player both belong to that game.
-- BingoSnap photos never reach Storage (on-device only), and no other bucket is read.
--
-- Rules (evaluated NOW, by the database, every time; the app never decides eligibility on its own):
--   unverified path / owner, unknown age, active game (draft/lobby/live), unexpired pass, < 7 days  -> protected
--   7-13 full days                                                                                  -> pending
--   >= 14 full days, owner verified, no unexpired pass, game not active                             -> eligible
-- "Unexpired pass" = a GRANTED pass with a ledger segment ending after now() (current OR queued). Time-based:
-- an expired pass never counts as active because its order was paid. A revoked/forfeited pass never protects.
-- This deliberately protects more than pass_entitlement(): a suspended host's still-running pass, and a pass
-- bought for later, both protect their images.
--
-- Physical deletion happens in the app through the Storage API (service role, server only). This migration
-- never deletes from storage.objects. admin_record_image_cleanup only marks submissions whose object is
-- verifiably gone, and writes the audit event (admin_audit_events, action 'image_cleanup').
--
-- Re-runnable. Revert: supabase/rollback/20261116000003_admin_image_cleanup_revert.sql

alter table public.submissions add column if not exists photo_deleted_at timestamptz;

-- ------------------------------------------------------------------ classifier (internal only) ----
create or replace function public.image_cleanup_classify(p_names text[] default null)
returns table (
  object_name text, bytes bigint, uploaded_at timestamptz, age_days integer,
  game_id uuid, game_title text, game_status public.game_status,
  owner_id uuid, owner_email text, owner_name text, submission_id uuid,
  pass_status text, pass_ends_at timestamptz,
  cleanup_status text, reason text
) language sql stable security definer set search_path = '' as $$
  with o as (
    select ob.name, ob.created_at,
           case when ob.metadata ? 'size' and (ob.metadata->>'size') ~ '^[0-9]{1,15}$'
                then (ob.metadata->>'size')::bigint else 0 end as bytes,
           ob.name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$' as path_ok
    from storage.objects ob
    where ob.bucket_id = 'submissions' and (p_names is null or ob.name = any (p_names))
  ), ids as (  -- CASE guarantees the uuid casts only ever run on a validated path
    select o.*,
           case when o.path_ok then split_part(o.name, '/', 1)::uuid end as g_uuid,
           case when o.path_ok then split_part(o.name, '/', 2)::uuid end as r_uuid,
           case when o.path_ok then split_part(split_part(o.name, '/', 3), '.', 1)::uuid end as p_uuid
    from o
  ), r as (
    select o.*,
           g.id as g_id, g.title as g_title, g.status as g_status, g.owner_id as g_owner,
           pr.id as pr_id, pr.email as pr_email, pr.display_name as pr_name,
           s.id as s_id,
           (g.id is not null and g.game_type = 'bring_me' and pr.id is not null
             and exists (select 1 from public.game_rounds gr where gr.id = o.r_uuid and gr.game_id = g.id)
             and exists (select 1 from public.players pl where pl.id = o.p_uuid and pl.game_id = g.id)
           ) as owner_ok,
           exists (select 1 from public.pass_segments ps join public.game_passes gp on gp.id = ps.pass_id
                    where ps.user_id = pr.id and gp.disposition = 'granted' and ps.ends_at > now()) as pass_active,
           exists (select 1 from public.pass_segments ps where ps.user_id = pr.id) as pass_ever,
           (select max(ps.ends_at) from public.pass_segments ps where ps.user_id = pr.id) as pass_last_end
    from ids o
    left join public.games g on g.id = o.g_uuid
    left join public.profiles pr on pr.id = g.owner_id
    left join public.submissions s on s.game_id = g.id and s.storage_path = o.name
  )
  select r.name, r.bytes, r.created_at,
         case when r.created_at is null then null else floor(extract(epoch from (now() - r.created_at)) / 86400)::integer end,
         r.g_id, r.g_title, r.g_status, r.pr_id, r.pr_email, r.pr_name, r.s_id,
         case when not coalesce(r.owner_ok, false) then 'unknown'
              when r.pass_active then 'active'
              when r.pass_ever then 'expired'
              else 'none' end,
         r.pass_last_end,
         case when not coalesce(r.owner_ok, false) or r.created_at is null
                or r.g_status in ('draft', 'lobby', 'live') or r.pass_active
                or r.created_at > now() - interval '7 days' then 'protected'
              when r.created_at > now() - interval '14 days' then 'pending'
              else 'eligible' end,
         case when not r.path_ok then 'unrecognized_path'
              when not coalesce(r.owner_ok, false) then 'unverified_owner'
              when r.created_at is null then 'unknown_age'
              when r.g_status in ('draft', 'lobby', 'live') then 'active_game'
              when r.pass_active then 'active_pass'
              when r.created_at > now() - interval '7 days' then 'recent'
              when r.created_at > now() - interval '14 days' then 'waiting_period'
              else 'eligible' end
  from r
$$;

-- --------------------------------------------------------------------------- admin reads ----
create or replace function public.admin_image_summary()
returns table (
  total_count bigint, total_bytes bigint, pending_count bigint, pending_bytes bigint,
  eligible_count bigint, eligible_bytes bigint, protected_count bigint, protected_bytes bigint
) language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_super_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    select count(*), coalesce(sum(c.bytes), 0)::bigint,
           count(*) filter (where c.cleanup_status = 'pending'), coalesce(sum(c.bytes) filter (where c.cleanup_status = 'pending'), 0)::bigint,
           count(*) filter (where c.cleanup_status = 'eligible'), coalesce(sum(c.bytes) filter (where c.cleanup_status = 'eligible'), 0)::bigint,
           count(*) filter (where c.cleanup_status = 'protected'), coalesce(sum(c.bytes) filter (where c.cleanup_status = 'protected'), 0)::bigint
    from public.image_cleanup_classify(null) c;
end $$;

-- p_owner: an owner id, or text matched against the owner's email / display name.
create or replace function public.admin_list_images(
  p_status text default null, p_from timestamptz default null, p_to timestamptz default null,
  p_owner text default null, p_limit integer default 25, p_offset integer default 0
) returns table (
  object_name text, bytes bigint, uploaded_at timestamptz, age_days integer,
  game_id uuid, game_title text, game_status public.game_status,
  owner_id uuid, owner_email text, owner_name text, submission_id uuid,
  pass_status text, pass_ends_at timestamptz, cleanup_status text, reason text, total_count bigint
) language plpgsql stable security definer set search_path = '' as $$
declare
  v_owner text := nullif(btrim(p_owner), '');
begin
  if not public.is_super_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    select c.*, count(*) over ()
    from public.image_cleanup_classify(null) c
    where (p_status is null or c.cleanup_status = p_status)
      and (p_from is null or c.uploaded_at >= p_from)
      and (p_to is null or c.uploaded_at < p_to)
      and (v_owner is null
           or c.owner_id::text = lower(v_owner)
           or c.owner_email ilike '%' || replace(replace(v_owner, '%', ''), '_', '\_') || '%'
           or c.owner_name ilike '%' || replace(replace(v_owner, '%', ''), '_', '\_') || '%')
    order by c.uploaded_at asc nulls first, c.object_name
    limit least(greatest(p_limit, 1), 200) offset greatest(p_offset, 0);
end $$;

-- Eligible images only, re-evaluated now. p_names = revalidate exactly these (the delete route calls this
-- immediately before each Storage batch); null = the oldest eligible images (preview).
create or replace function public.admin_image_cleanup_candidates(p_names text[] default null, p_limit integer default 500)
returns table (
  object_name text, bytes bigint, uploaded_at timestamptz, age_days integer,
  game_id uuid, game_title text, game_status public.game_status,
  owner_id uuid, owner_email text, owner_name text, pass_status text, pass_ends_at timestamptz
) language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_super_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    select c.object_name, c.bytes, c.uploaded_at, c.age_days, c.game_id, c.game_title, c.game_status,
           c.owner_id, c.owner_email, c.owner_name, c.pass_status, c.pass_ends_at
    from public.image_cleanup_classify(p_names) c
    where c.cleanup_status = 'eligible'
    order by c.uploaded_at asc, c.object_name
    limit least(greatest(p_limit, 1), 1000);
end $$;

-- ------------------------------------------------------------------------ record a run ----
-- Called after the Storage API calls. The DATABASE decides what was deleted: an attempted object counts as
-- deleted only if it is no longer in storage.objects; otherwise it is a failure (with the API's reason).
-- Only then are submission references marked. Also repairs references left unmarked by an earlier run that
-- failed between deleting and recording (object gone, game ended, photo >= 14 days old), so retries are safe.
-- p_attempted: [{ "name": text, "bytes": int, "error": text|null }]
create or replace function public.admin_record_image_cleanup(p_evaluated integer, p_skipped integer, p_attempted jsonb)
returns table (run_id bigint, deleted integer, failed integer, bytes_recovered bigint, references_updated integer, failed_items jsonb)
language plpgsql security definer set search_path = '' as $$
declare
  v_deleted text[];
  v_bytes bigint;
  v_failed jsonb;
  v_marked integer;
  v_repaired integer;
  v_id bigint;
begin
  if not public.is_super_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if jsonb_typeof(coalesce(p_attempted, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_attempted, '[]'::jsonb)) > 1000 then
    raise exception 'invalid_attempted' using errcode = 'P0001';
  end if;

  with a as (
    select x->>'name' as name, coalesce((x->>'bytes')::bigint, 0) as bytes, nullif(left(x->>'error', 80), '') as err,
           exists (select 1 from storage.objects ob where ob.bucket_id = 'submissions' and ob.name = x->>'name') as present
    from jsonb_array_elements(coalesce(p_attempted, '[]'::jsonb)) x
  )
  select coalesce(array_agg(a.name) filter (where not a.present), '{}'),
         coalesce(sum(a.bytes) filter (where not a.present), 0)::bigint,
         coalesce(jsonb_agg(jsonb_build_object('name', a.name, 'reason', coalesce(a.err, 'not_removed'))) filter (where a.present), '[]')
    into v_deleted, v_bytes, v_failed
  from a;

  update public.submissions s set photo_deleted_at = now()
   where s.storage_path = any (v_deleted) and s.photo_deleted_at is null;
  get diagnostics v_marked = row_count;

  update public.submissions s set photo_deleted_at = now()
    from public.games g
   where g.id = s.game_id and g.status not in ('draft', 'lobby', 'live')
     and s.photo_deleted_at is null and s.submitted_at <= now() - interval '14 days'
     and not exists (select 1 from storage.objects ob where ob.bucket_id = 'submissions' and ob.name = s.storage_path);
  get diagnostics v_repaired = row_count;

  insert into public.admin_audit_events (admin_id, action, target, details)
  values (auth.uid(), 'image_cleanup', 'storage:submissions', jsonb_build_object(
    'evaluated', greatest(coalesce(p_evaluated, 0), 0),
    'deleted', cardinality(v_deleted),
    'skipped', greatest(coalesce(p_skipped, 0), 0),
    'failed', jsonb_array_length(v_failed),
    'bytes_recovered', v_bytes,
    'references_updated', v_marked + v_repaired,
    'failure_reasons', (select coalesce(jsonb_object_agg(k, n), '{}') from (
        select f->>'reason' as k, count(*) as n from jsonb_array_elements(v_failed) f group by 1) t),
    'failed_items', (select coalesce(jsonb_agg(f), '[]') from (select f from jsonb_array_elements(v_failed) f limit 50) t)))
  returning id into v_id;

  return query select v_id, cardinality(v_deleted), jsonb_array_length(v_failed), v_bytes, v_marked + v_repaired,
    (select coalesce(jsonb_agg(f), '[]') from (select f from jsonb_array_elements(v_failed) f limit 100) t);
end $$;

create or replace function public.admin_image_cleanup_history(p_limit integer default 20)
returns table (id bigint, at timestamptz, admin_id uuid, admin_email text, details jsonb)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_super_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    select e.id, e.at, e.admin_id, p.email, e.details
    from public.admin_audit_events e left join public.profiles p on p.id = e.admin_id
    where e.action = 'image_cleanup'
    order by e.at desc
    limit least(greatest(p_limit, 1), 100);
end $$;

revoke all on function public.image_cleanup_classify(text[]) from public, anon, authenticated, service_role;
revoke all on function
  public.admin_image_summary(), public.admin_list_images(text, timestamptz, timestamptz, text, integer, integer),
  public.admin_image_cleanup_candidates(text[], integer), public.admin_record_image_cleanup(integer, integer, jsonb),
  public.admin_image_cleanup_history(integer)
  from public, anon;
grant execute on function
  public.admin_image_summary(), public.admin_list_images(text, timestamptz, timestamptz, text, integer, integer),
  public.admin_image_cleanup_candidates(text[], integer), public.admin_record_image_cleanup(integer, integer, jsonb),
  public.admin_image_cleanup_history(integer)
  to authenticated;
