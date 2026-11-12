-- BringMe! Game Pass 3/7: entitlement ledger (passes, segments, audit log).
-- New, empty tables + one nullable profile column => no behaviour change. Re-runnable.
-- Design: GAME_PASS_DESIGN.md §4.3. Access at instant t = the segment containing t.
--
-- Why not reuse public.subscriptions as the ledger: it allows only ONE live row per
-- user (subscriptions_one_live_per_user) and admin activation overwrites that row,
-- so queued / paused passes and purchase history cannot be represented without
-- recurring-subscription assumptions. It stays as frozen legacy history.

do $$ begin
  if to_regclass('public.profiles') is null or to_regclass('public.subscriptions') is null then
    raise exception 'game_pass_precondition: apply 20261111000001..12 first';
  end if;
  if to_regtype('public.pass_source') is null then
    raise exception 'game_pass_precondition: apply 20261112000001_game_pass_types.sql first';
  end if;
  if not exists (select 1 from pg_available_extensions where name = 'btree_gist') then
    raise exception 'game_pass_precondition: extension btree_gist is not available on this server';
  end if;
end $$;

create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions;

-- --------------------------------------------------------------- profiles ----
alter table public.profiles add column if not exists hosting_suspended_at timestamptz;
comment on column public.profiles.hosting_suspended_at is
  'Account-level hosting suspension (admin). Pass time keeps running while suspended.';

-- ------------------------------------------------------------- game_passes ----
create table if not exists public.game_passes (
  id                     uuid primary key default gen_random_uuid(),
  seq                    bigint generated always as identity,
  user_id                uuid not null references public.profiles (id) on delete restrict,
  plan_id                uuid not null references public.subscription_plans (id) on delete restrict,
  source                 public.pass_source not null,
  order_id               uuid,                       -- FK added in 20261112000004
  legacy_subscription_id uuid references public.subscriptions (id) on delete restrict,
  max_players            integer not null check (max_players between 2 and 500),          -- snapshot
  duration_seconds       numeric(14, 6) not null check (duration_seconds >= 0 and duration_seconds <= 189216000), -- snapshot, up to 6 y
  disposition            public.pass_disposition not null default 'granted',
  ended_at               timestamptz,
  end_reason             text check (end_reason is null or char_length(end_reason) between 1 and 200),
  granted_by             uuid references public.profiles (id) on delete set null,
  grant_reason           text check (grant_reason is null or char_length(grant_reason) between 1 and 500),
  created_at             timestamptz not null default now(),
  constraint game_passes_seq_key unique (seq),
  constraint game_passes_order_key unique (order_id),
  constraint game_passes_legacy_key unique (legacy_subscription_id),
  constraint game_passes_purchase_order check ((source = 'purchase') = (order_id is not null)),
  constraint game_passes_legacy_ref check ((source = 'legacy_subscription') = (legacy_subscription_id is not null)),
  constraint game_passes_admin_reason check (source <> 'admin_grant' or grant_reason is not null),
  constraint game_passes_end_consistent check ((disposition = 'granted') = (ended_at is null)
                                               and (disposition = 'granted') = (end_reason is null)),
  constraint game_passes_forfeit_trial check (disposition <> 'forfeited' or source = 'trial')
);
comment on table public.game_passes is
  'One granted block of access time (entitlement). A paid order creates exactly one. Rows are never deleted.';
create unique index if not exists game_passes_one_trial_per_user on public.game_passes (user_id) where source = 'trial';
create index if not exists game_passes_user_idx on public.game_passes (user_id, max_players desc, seq);
create index if not exists game_passes_plan_idx on public.game_passes (plan_id);

-- ----------------------------------------------------------- pass_segments ----
create table if not exists public.pass_segments (
  id         bigint generated always as identity primary key,
  pass_id    uuid not null references public.game_passes (id) on delete restrict,
  user_id    uuid not null references public.profiles (id) on delete restrict,   -- denormalised for the exclusion
  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  constraint pass_segments_positive check (ends_at > starts_at),
  -- THE invariant: never two active passes for one host at the same instant. Half-open [start, end).
  constraint pass_segments_no_overlap exclude using gist (user_id with =, tstzrange(starts_at, ends_at, '[)') with &&)
);
create index if not exists pass_segments_pass_idx on public.pass_segments (pass_id);
create index if not exists pass_segments_user_idx on public.pass_segments (user_id, starts_at);

-- ------------------------------------------------------ entitlement_events ----
create table if not exists public.entitlement_events (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  user_id     uuid not null references public.profiles (id) on delete restrict,
  pass_id     uuid references public.game_passes (id) on delete restrict,
  order_id    uuid,                                  -- FK added in 20261112000004
  actor_kind  text not null check (actor_kind in ('system', 'webhook', 'admin', 'host', 'migration')),
  actor_id    uuid,
  action      text not null check (action ~ '^[a-z_]{3,40}$'),
  details     jsonb not null default '{}'
);
create index if not exists entitlement_events_user_idx on public.entitlement_events (user_id, at desc);

-- ---------------------------------------------------------------- guards ----
-- Maintenance bypass (historical backfill / tests): transaction-local setting AND a
-- superuser-class role. Client roles have no write grants on these tables anyway.
create or replace function public.ledger_maintenance()
returns boolean language sql stable set search_path = '' as $$
  select coalesce(current_setting('bringme.ledger_maintenance', true), '') = 'on'
     and current_user in ('postgres', 'supabase_admin')
$$;

create or replace function public.guard_game_pass()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if public.ledger_maintenance() then return old; end if;
    raise exception 'ledger_rows_are_never_deleted' using errcode = '42501';
  end if;
  if new.id <> old.id or new.seq <> old.seq or new.user_id <> old.user_id or new.source <> old.source
     or new.order_id is distinct from old.order_id
     or new.legacy_subscription_id is distinct from old.legacy_subscription_id
     or new.created_at <> old.created_at or new.granted_by is distinct from old.granted_by then
    raise exception 'immutable pass column' using errcode = '42501';
  end if;
  if new.disposition is distinct from old.disposition and old.disposition <> 'granted' then
    raise exception 'pass_already_ended' using errcode = 'P0001';
  end if;
  -- What was sold stays as sold: only manual/legacy passes may change plan or length.
  if (new.plan_id <> old.plan_id or new.max_players <> old.max_players or new.duration_seconds <> old.duration_seconds)
     and old.source not in ('admin_grant', 'legacy_subscription') and not public.ledger_maintenance() then
    raise exception 'paid_pass_immutable' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists guard_game_pass on public.game_passes;
create trigger guard_game_pass before update or delete on public.game_passes
  for each row execute function public.guard_game_pass();

-- Consumed time is final: only time at or after now() can be (re)scheduled.
create or replace function public.guard_pass_segment()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_now  timestamptz := now();
  v_user uuid;
begin
  if public.ledger_maintenance() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    if old.starts_at < v_now then
      raise exception 'ledger_history_immutable' using errcode = '42501';
    end if;
    return old;
  end if;
  select user_id into v_user from public.game_passes where id = new.pass_id;
  if v_user is distinct from new.user_id then
    raise exception 'segment_user_mismatch' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then
    if new.starts_at < v_now then
      raise exception 'ledger_history_immutable' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.pass_id <> old.pass_id or new.user_id <> old.user_id or new.starts_at <> old.starts_at then
    raise exception 'ledger_history_immutable' using errcode = '42501';
  end if;
  -- Half-open [start, end): a segment ending exactly at now() holds no time >= now(), so
  -- moving its end (the replan's "continue the running pass") only changes the future.
  if new.ends_at <> old.ends_at and (old.ends_at < v_now or new.ends_at < v_now) then
    raise exception 'ledger_history_immutable' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists guard_pass_segment on public.pass_segments;
create trigger guard_pass_segment before insert or update or delete on public.pass_segments
  for each row execute function public.guard_pass_segment();

create or replace function public.guard_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'audit_log_append_only' using errcode = '42501';
end $$;
drop trigger if exists entitlement_events_append_only on public.entitlement_events;
create trigger entitlement_events_append_only before update or delete on public.entitlement_events
  for each row execute function public.guard_append_only();
drop trigger if exists entitlement_events_no_truncate on public.entitlement_events;
create trigger entitlement_events_no_truncate before truncate on public.entitlement_events
  for each statement execute function public.guard_append_only();
drop trigger if exists game_passes_no_truncate on public.game_passes;
create trigger game_passes_no_truncate before truncate on public.game_passes
  for each statement execute function public.guard_append_only();
drop trigger if exists pass_segments_no_truncate on public.pass_segments;
create trigger pass_segments_no_truncate before truncate on public.pass_segments
  for each statement execute function public.guard_append_only();

-- ---------------------------------------------------------- grants / RLS ----
alter table public.game_passes        enable row level security;
alter table public.pass_segments      enable row level security;
alter table public.entitlement_events enable row level security;

revoke all on public.game_passes, public.pass_segments, public.entitlement_events from public, anon, authenticated;
grant all on public.game_passes, public.pass_segments, public.entitlement_events to service_role;
-- Hosts read their own ledger (no admin notes); writes only through SECURITY DEFINER functions.
grant select (id, user_id, plan_id, source, max_players, duration_seconds, disposition, ended_at, end_reason, created_at)
  on public.game_passes to authenticated;
grant select (id, pass_id, user_id, starts_at, ends_at) on public.pass_segments to authenticated;
grant select on public.entitlement_events to authenticated;   -- policy: super admins only

drop policy if exists passes_select_own on public.game_passes;
create policy passes_select_own on public.game_passes for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists passes_select_admin on public.game_passes;
create policy passes_select_admin on public.game_passes for select to authenticated using ((select public.is_super_admin()));
drop policy if exists segments_select_own on public.pass_segments;
create policy segments_select_own on public.pass_segments for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists segments_select_admin on public.pass_segments;
create policy segments_select_admin on public.pass_segments for select to authenticated using ((select public.is_super_admin()));
drop policy if exists entitlement_events_select_admin on public.entitlement_events;
create policy entitlement_events_select_admin on public.entitlement_events for select to authenticated
  using ((select public.is_super_admin()));

revoke all on function public.ledger_maintenance(), public.guard_game_pass(), public.guard_pass_segment(),
  public.guard_append_only() from public, anon, authenticated;
