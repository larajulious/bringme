-- BringMe! Game Pass 14: admin plan edits synchronised to Polar. Additive, re-runnable.
--
-- Order of operations (lib/billing/product-sync.ts): a sync JOB is recorded (previous + requested
-- configuration) -> Polar is PATCHed -> Polar is re-read and verified -> only then the local plan
-- name / players / prices are applied in ONE transaction (admin_finish_plan_sync). Polar and
-- Supabase can't share a transaction, so a job can end "polar_applied" (Polar updated, local save
-- failed) and is retried; a retry compares first and never adds a second price to Polar.

do $$ begin
  if to_regprocedure('public.admin_set_plan_price(uuid, uuid, text, integer)') is null then
    raise exception 'game_pass_precondition: apply 20261112000001..13 first';
  end if;
end $$;

-- ---------------------------------------------------------- per-env sync state ----
create table if not exists public.plan_polar_state (
  plan_id           uuid not null references public.subscription_plans (id) on delete restrict,
  environment       text not null check (environment in ('sandbox', 'production')),
  polar_product_id  text not null check (char_length(polar_product_id) between 1 and 200),
  status            text not null check (status in ('in_sync', 'out_of_sync', 'sync_failed', 'polar_ahead')),
  polar_name        text,
  php_price_id      text, php_minor integer,
  usd_price_id      text, usd_minor integer,
  polar_modified_at timestamptz,
  last_synced_at    timestamptz,
  last_checked_at   timestamptz,
  last_error        text check (last_error is null or char_length(last_error) <= 500),
  details           jsonb not null default '{}',
  updated_at        timestamptz not null default now(),
  primary key (plan_id, environment)
);

-- ------------------------------------------------------------------- sync jobs ----
create table if not exists public.plan_sync_jobs (
  id           uuid primary key default gen_random_uuid(),
  plan_id      uuid not null references public.subscription_plans (id) on delete restrict,
  environment  text check (environment is null or environment in ('sandbox', 'production')),   -- null = local only (no Polar product)
  polar_product_id text,
  requested    jsonb not null,           -- {name, max_players, php_minor, usd_minor}
  previous     jsonb not null,           -- same shape, local values when the job started
  status       text not null default 'pending' check (status in ('pending', 'polar_applied', 'synced', 'failed', 'superseded')),
  stage        text,                     -- fetch | validate | polar_update | verify | local_save
  last_error   text check (last_error is null or char_length(last_error) <= 500),
  polar_result jsonb,                    -- verified product summary (ids + amounts), never secrets
  attempts     integer not null default 1,
  created_by   uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  completed_at timestamptz
);
-- At most ONE unfinished job per plan + environment: concurrent admin edits can't interleave.
create unique index if not exists plan_sync_jobs_one_open
  on public.plan_sync_jobs (plan_id, coalesce(environment, 'local')) where status in ('pending', 'polar_applied', 'failed');
create index if not exists plan_sync_jobs_plan_idx on public.plan_sync_jobs (plan_id, created_at desc);

alter table public.plan_polar_state enable row level security;
alter table public.plan_sync_jobs enable row level security;
revoke all on public.plan_polar_state, public.plan_sync_jobs from public, anon, authenticated;
grant all on public.plan_polar_state, public.plan_sync_jobs to service_role;
grant select on public.plan_polar_state, public.plan_sync_jobs to authenticated;
drop policy if exists plan_polar_state_admin on public.plan_polar_state;
create policy plan_polar_state_admin on public.plan_polar_state for select to authenticated using ((select public.is_super_admin()));
drop policy if exists plan_sync_jobs_admin on public.plan_sync_jobs;
create policy plan_sync_jobs_admin on public.plan_sync_jobs for select to authenticated using ((select public.is_super_admin()));

-- ------------------------------------------------------------------ begin / retry ----
create or replace function public.admin_begin_plan_sync(
  p_admin uuid, p_plan uuid, p_environment text, p_product_id text, p_requested jsonb
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_plan record;
  v_open record;
  v_id uuid;
begin
  perform public.assert_admin_actor(p_admin);
  select * into v_plan from public.subscription_plans where id = p_plan for update;
  if not found then raise exception 'plan_not_found' using errcode = 'P0001'; end if;
  if v_plan.is_trial then raise exception 'trial_is_internal' using errcode = 'P0001'; end if;
  select * into v_open from public.plan_sync_jobs
   where plan_id = p_plan and coalesce(environment, 'local') = coalesce(p_environment, 'local')
     and status in ('pending', 'polar_applied', 'failed') for update;
  if v_open.id is not null then
    -- a stuck or failed job is replaced by the new request (recorded); a live one blocks
    if v_open.status = 'pending' and v_open.updated_at > now() - interval '2 minutes' then
      raise exception 'sync_in_progress' using errcode = 'P0001';
    end if;
    update public.plan_sync_jobs set status = 'superseded', updated_at = now(), completed_at = now() where id = v_open.id;
  end if;
  insert into public.plan_sync_jobs (plan_id, environment, polar_product_id, requested, previous, created_by)
  values (p_plan, p_environment, p_product_id, p_requested, jsonb_build_object(
      'name', v_plan.name, 'max_players', v_plan.max_players_per_game,
      'php_minor', (select amount_minor from public.plan_prices where plan_id = p_plan and currency = 'PHP' and is_active),
      'usd_minor', (select amount_minor from public.plan_prices where plan_id = p_plan and currency = 'USD' and is_active)),
    p_admin)
  returning id into v_id;
  perform public.admin_log(p_admin, 'plan_sync_started', v_plan.code, jsonb_build_object('job', v_id, 'environment', p_environment, 'requested', p_requested));
  return v_id;
end $$;

create or replace function public.admin_retry_plan_sync(p_admin uuid, p_job uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_job record;
begin
  perform public.assert_admin_actor(p_admin);
  select * into v_job from public.plan_sync_jobs where id = p_job for update;
  if not found or v_job.status not in ('failed', 'polar_applied', 'pending') then
    raise exception 'job_not_retryable' using errcode = 'P0001';
  end if;
  if v_job.status = 'pending' and v_job.updated_at > now() - interval '2 minutes' then
    raise exception 'sync_in_progress' using errcode = 'P0001';
  end if;
  update public.plan_sync_jobs set status = 'pending', attempts = attempts + 1, stage = null, updated_at = now() where id = p_job;
  return jsonb_build_object('id', v_job.id, 'plan_id', v_job.plan_id, 'environment', v_job.environment,
                            'polar_product_id', v_job.polar_product_id, 'requested', v_job.requested);
end $$;

create or replace function public.admin_fail_plan_sync(p_admin uuid, p_job uuid, p_stage text, p_error text, p_polar jsonb default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_job record;
  v_status text := case when p_stage = 'local_save' then 'polar_applied' else 'failed' end;
begin
  perform public.assert_admin_actor(p_admin);
  update public.plan_sync_jobs set status = v_status, stage = p_stage, last_error = left(p_error, 500),
         polar_result = coalesce(p_polar, polar_result), updated_at = now()
   where id = p_job and status = 'pending'
   returning * into v_job;
  if v_job.id is null then return; end if;
  if v_job.environment is not null then
    insert into public.plan_polar_state (plan_id, environment, polar_product_id, status, last_error, last_checked_at)
    values (v_job.plan_id, v_job.environment, v_job.polar_product_id,
            case when v_status = 'polar_applied' then 'polar_ahead' else 'sync_failed' end, left(p_error, 500), now())
    on conflict (plan_id, environment) do update
      set status = excluded.status, last_error = excluded.last_error, last_checked_at = now(), updated_at = now();
  end if;
  perform public.admin_log(p_admin, 'plan_sync_failed', (select code from public.subscription_plans where id = v_job.plan_id),
    jsonb_build_object('job', p_job, 'stage', p_stage, 'error', left(p_error, 200)));
end $$;

-- ------------------------------------------------------------------- finish ----
-- Applies the requested configuration LOCALLY, atomically, only after Polar was verified
-- (p_polar = verified summary {product_id, name, modified_at, prices:{PHP:{id,amount},USD:{id,amount}}}),
-- or immediately for a local-only job (no Polar product mapped; p_polar null).
create or replace function public.admin_finish_plan_sync(p_admin uuid, p_job uuid, p_polar jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_job record;
  v_req jsonb;
begin
  perform public.assert_admin_actor(p_admin);
  select * into v_job from public.plan_sync_jobs where id = p_job for update;
  if not found or v_job.status <> 'pending' then raise exception 'job_not_pending' using errcode = 'P0001'; end if;
  if v_job.environment is not null and p_polar is null then raise exception 'polar_result_required' using errcode = 'P0001'; end if;
  v_req := v_job.requested;
  if v_job.environment is not null and (
       (p_polar #>> '{prices,PHP,amount}')::integer is distinct from (v_req ->> 'php_minor')::integer
    or (p_polar #>> '{prices,USD,amount}')::integer is distinct from (v_req ->> 'usd_minor')::integer
    or (p_polar ->> 'name') is distinct from (v_req ->> 'name')) then
    raise exception 'polar_result_does_not_match_request' using errcode = 'P0001';
  end if;

  perform public.admin_update_plan(p_admin, v_job.plan_id, jsonb_build_object(
    'name', v_req ->> 'name', 'max_players_per_game', (v_req ->> 'max_players')::integer));
  perform public.admin_set_plan_price(p_admin, v_job.plan_id, 'PHP', (v_req ->> 'php_minor')::integer);
  perform public.admin_set_plan_price(p_admin, v_job.plan_id, 'USD', (v_req ->> 'usd_minor')::integer);

  if v_job.environment is not null then
    insert into public.plan_polar_state (plan_id, environment, polar_product_id, status, polar_name,
        php_price_id, php_minor, usd_price_id, usd_minor, polar_modified_at, last_synced_at, last_checked_at, last_error, details)
    values (v_job.plan_id, v_job.environment, v_job.polar_product_id, 'in_sync', p_polar ->> 'name',
        p_polar #>> '{prices,PHP,id}', (p_polar #>> '{prices,PHP,amount}')::integer,
        p_polar #>> '{prices,USD,id}', (p_polar #>> '{prices,USD,amount}')::integer,
        nullif(p_polar ->> 'modified_at', '')::timestamptz, now(), now(), null, '{}')
    on conflict (plan_id, environment) do update set
        polar_product_id = excluded.polar_product_id, status = 'in_sync', polar_name = excluded.polar_name,
        php_price_id = excluded.php_price_id, php_minor = excluded.php_minor,
        usd_price_id = excluded.usd_price_id, usd_minor = excluded.usd_minor,
        polar_modified_at = greatest(plan_polar_state.polar_modified_at, excluded.polar_modified_at),
        last_synced_at = now(), last_checked_at = now(), last_error = null, details = '{}', updated_at = now();
  end if;
  update public.plan_sync_jobs set status = 'synced', stage = null, last_error = null, polar_result = p_polar,
         updated_at = now(), completed_at = now() where id = p_job;
  perform public.admin_log(p_admin, 'plan_synced', (select code from public.subscription_plans where id = v_job.plan_id),
    jsonb_build_object('job', p_job, 'environment', v_job.environment, 'previous', v_job.previous, 'requested', v_req));
end $$;

-- ------------------------------------------------- Polar-side changes (webhook / check) ----
-- Records what Polar currently has for a plan's product. NEVER changes local plan data:
-- a difference marks the plan out_of_sync (checkout is blocked by the price-sync guard).
-- Ignores stale reads (older modified_at) and reads taken while a sync job is open.
create or replace function public.record_polar_product_state(p_environment text, p_plan_code text, p_product jsonb)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_plan record;
  v_state record;
  v_mod timestamptz := nullif(p_product ->> 'modified_at', '')::timestamptz;
  v_php integer; v_usd integer;
  v_diff jsonb := '{}';
begin
  select * into v_plan from public.subscription_plans where code = p_plan_code;
  if not found then return 'unknown_plan'; end if;
  select * into v_state from public.plan_polar_state where plan_id = v_plan.id and environment = p_environment for update;
  if exists (select 1 from public.plan_sync_jobs where plan_id = v_plan.id and environment = p_environment and status in ('pending', 'polar_applied')) then
    update public.plan_polar_state set last_checked_at = now() where plan_id = v_plan.id and environment = p_environment;
    return 'sync_in_progress';
  end if;
  if v_state.plan_id is not null and v_state.polar_modified_at is not null and v_mod is not null and v_mod < v_state.polar_modified_at then
    return 'stale';
  end if;
  select amount_minor into v_php from public.plan_prices where plan_id = v_plan.id and currency = 'PHP' and is_active;
  select amount_minor into v_usd from public.plan_prices where plan_id = v_plan.id and currency = 'USD' and is_active;
  if (p_product ->> 'name') is distinct from v_plan.name then v_diff := v_diff || jsonb_build_object('name', p_product ->> 'name'); end if;
  if (p_product #>> '{prices,PHP,amount}')::integer is distinct from v_php then v_diff := v_diff || jsonb_build_object('php_minor', (p_product #>> '{prices,PHP,amount}')::integer); end if;
  if (p_product #>> '{prices,USD,amount}')::integer is distinct from v_usd then v_diff := v_diff || jsonb_build_object('usd_minor', (p_product #>> '{prices,USD,amount}')::integer); end if;
  if coalesce((p_product ->> 'problem'), '') <> '' then v_diff := v_diff || jsonb_build_object('problem', p_product ->> 'problem'); end if;

  insert into public.plan_polar_state (plan_id, environment, polar_product_id, status, polar_name, php_price_id, php_minor,
      usd_price_id, usd_minor, polar_modified_at, last_checked_at, details, last_error)
  values (v_plan.id, p_environment, p_product ->> 'product_id', case when v_diff = '{}' then 'in_sync' else 'out_of_sync' end,
      p_product ->> 'name', p_product #>> '{prices,PHP,id}', (p_product #>> '{prices,PHP,amount}')::integer,
      p_product #>> '{prices,USD,id}', (p_product #>> '{prices,USD,amount}')::integer, v_mod, now(), v_diff,
      case when v_diff = '{}' then null else 'Changed in Polar; differs from BringMe!' end)
  on conflict (plan_id, environment) do update set
      polar_product_id = excluded.polar_product_id, status = excluded.status, polar_name = excluded.polar_name,
      php_price_id = excluded.php_price_id, php_minor = excluded.php_minor, usd_price_id = excluded.usd_price_id, usd_minor = excluded.usd_minor,
      polar_modified_at = coalesce(excluded.polar_modified_at, plan_polar_state.polar_modified_at),
      last_checked_at = now(), details = excluded.details, last_error = excluded.last_error, updated_at = now();
  return case when v_diff = '{}' then 'in_sync' else 'out_of_sync' end;
end $$;

revoke all on function
  public.admin_begin_plan_sync(uuid, uuid, text, text, jsonb), public.admin_retry_plan_sync(uuid, uuid),
  public.admin_fail_plan_sync(uuid, uuid, text, text, jsonb), public.admin_finish_plan_sync(uuid, uuid, jsonb),
  public.record_polar_product_state(text, text, jsonb)
  from public, anon, authenticated;
grant execute on function
  public.admin_begin_plan_sync(uuid, uuid, text, text, jsonb), public.admin_retry_plan_sync(uuid, uuid),
  public.admin_fail_plan_sync(uuid, uuid, text, text, jsonb), public.admin_finish_plan_sync(uuid, uuid, jsonb),
  public.record_polar_product_state(text, text, jsonb)
  to service_role;
