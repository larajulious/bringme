-- BringMe! Game Pass 8: AUTOMATIC free trial (Phase 3).
-- Supersedes design D-3 (explicit claim): the trial is granted ONCE, automatically, when a
-- Game Master's account becomes valid (email confirmed). Re-runnable.
--
-- Claim evidence is Phase 2's ledger: a permanent game_passes row with source 'trial'
-- (rows are never deleted) + the unique index game_passes_one_trial_per_user. Nothing a
-- session, logout, password reset or profile update does can remove it, so the trial can
-- never restart. Start/end come only from the database clock (grant_pass / replan).
--
-- Activation paths (all call ensure_trial_for, which is idempotent and race-safe):
--   1. trigger on auth.users: insert with a confirmed email (auto-confirm projects) or the
--      update that confirms it (Supabase "Confirm email" ON). Never blocks sign-up.
--   2. /auth/continue (after every sign-in) -> ensure_my_trial(): accounts confirmed before
--      this migration, or if path 1 failed. Existing accounts with any pass history are
--      NOT eligible (has_paid_history / trial_already_used), so access is preserved.
--   3. POST /api/host/trial (dashboard button) -> ensure_my_trial(): same, on demand.

do $$ begin
  if to_regprocedure('public.trial_eligibility(uuid)') is null
     or to_regprocedure('public.grant_pass(uuid, uuid, public.pass_source, numeric, uuid, text, uuid, text)') is null then
    raise exception 'game_pass_precondition: apply 20261112000001..7 first';
  end if;
end $$;

-- ------------------------------------------------------------- eligibility ----
-- Tightened for automatic activation (supersedes D-4's admin-grant exception): an account
-- that has EVER had any pass (trial, purchase, manual grant, legacy subscription) is a
-- previously used account and never gets a trial. Same signature as 20261112000005.
create or replace function public.trial_eligibility(p_user uuid)
returns table (eligible boolean, reason text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_p record;
  v_confirmed timestamptz;
begin
  select pr.role, pr.deactivated_at, pr.hosting_suspended_at into v_p from public.profiles pr where pr.id = p_user;
  if not found or v_p.role <> 'subscriber' then return query select false, 'not_subscriber'::text; return; end if;
  if v_p.deactivated_at is not null then return query select false, 'deactivated'::text; return; end if;
  if v_p.hosting_suspended_at is not null then return query select false, 'suspended'::text; return; end if;
  select u.email_confirmed_at into v_confirmed from auth.users u where u.id = p_user;
  if v_confirmed is null then return query select false, 'email_unconfirmed'::text; return; end if;
  if exists (select 1 from public.game_passes g where g.user_id = p_user and g.source = 'trial') then
    return query select false, 'trial_already_used'::text; return;
  end if;
  if exists (select 1 from public.game_passes g where g.user_id = p_user and g.source in ('purchase', 'legacy_subscription')) then
    return query select false, 'has_paid_history'::text; return;
  end if;
  if exists (select 1 from public.game_passes g where g.user_id = p_user) then
    return query select false, 'has_pass_history'::text; return;
  end if;
  return query select true, null::text;
end $$;

-- --------------------------------------------------------------- activation ----
-- Grants the trial if (and only if) the host is eligible right now. Never raises for an
-- ineligible host: returns granted=false + the reason. Concurrent calls serialise on the
-- profile row lock; the unique index is the final guard.
create or replace function public.ensure_trial_for(p_user uuid, p_actor_kind text default 'system')
returns table (granted boolean, reason text, pass_id uuid)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_el   record;
  v_plan record;
  v_pass uuid;
begin
  perform 1 from public.profiles where id = p_user for update;
  if not found then
    return query select false, 'not_subscriber'::text, null::uuid;
    return;
  end if;
  select * into v_el from public.trial_eligibility(p_user);
  if not v_el.eligible then
    return query select false, v_el.reason, (select g.id from public.game_passes g where g.user_id = p_user and g.source = 'trial');
    return;
  end if;
  select id, duration_seconds into v_plan from public.subscription_plans where is_trial and is_active order by tier limit 1;
  if not found then
    return query select false, 'trial_unavailable'::text, null::uuid;
    return;
  end if;
  begin
    v_pass := public.grant_pass(p_user, v_plan.id, 'trial', v_plan.duration_seconds, null,
                                case when p_actor_kind = 'host' then 'host' else 'system' end,
                                case when p_actor_kind = 'host' then p_user end, null);
  exception when unique_violation then
    return query select false, 'trial_already_used'::text, (select g.id from public.game_passes g where g.user_id = p_user and g.source = 'trial');
    return;
  end;
  return query select true, null::text, v_pass;
end $$;

create or replace function public.ensure_my_trial()
returns table (granted boolean, reason text, pass_id uuid)
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  return query select * from public.ensure_trial_for(auth.uid(), 'host');
end $$;

-- Path 1. Runs AFTER on_auth_user_created (same event; triggers fire in name order:
-- "on_auth_user_created" < "on_auth_user_trial"), so the profile already exists.
create or replace function public.handle_trial_on_confirm()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.email_confirmed_at is not null
     and (tg_op = 'INSERT' or old.email_confirmed_at is null) then
    begin
      perform public.ensure_trial_for(new.id, 'system');
    exception when others then
      -- Never break sign-up / confirmation; /auth/continue retries on the next sign-in.
      raise warning 'bringme: trial activation skipped for %: %', new.id, sqlerrm;
    end;
  end if;
  return new;
end $$;

drop trigger if exists on_auth_user_trial on auth.users;
create trigger on_auth_user_trial
  after insert or update of email_confirmed_at on auth.users
  for each row execute function public.handle_trial_on_confirm();

-- ----------------------------------------------------------- host summary ----
-- Everything the Host dashboard needs, computed with the DATABASE clock (the UI never
-- decides whether access is active). remaining_* are seconds from server now.
create or replace function public.game_pass_summary_for(p_user uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_access record;
  v_ent    record;
  v_trial  record;
  v_el     record;
  v_now    timestamptz := now();
  v_other  boolean;
begin
  select * into v_access from public.access_state_for(p_user);
  select e.*, pl.name as plan_name into v_ent
    from public.pass_entitlement(p_user) e join public.subscription_plans pl on pl.id = e.plan_id;
  select g.id, g.disposition, g.ended_at,
         (select min(s.starts_at) from public.pass_segments s where s.pass_id = g.id) as started_at,
         (select max(s.ends_at) from public.pass_segments s where s.pass_id = g.id) as ends_at
    into v_trial
    from public.game_passes g where g.user_id = p_user and g.source = 'trial';
  select * into v_el from public.trial_eligibility(p_user);
  v_other := exists (select 1 from public.game_passes g where g.user_id = p_user and g.source <> 'trial');

  return jsonb_build_object(
    'serverNow', v_now,
    'state', v_access.state,
    'planCode', v_ent.plan_code,
    'planName', v_ent.plan_name,
    'source', v_ent.source,
    'isTrial', coalesce(v_ent.source = 'trial', false),
    'maxPlayers', v_ent.max_players_per_game,
    'passStartedAt', v_ent.activated_at,
    'passEndsAt', v_ent.current_period_end,
    'accessUntil', v_ent.access_until,
    'passRemainingSeconds', case when v_ent.pass_id is null then null
                                 else greatest(extract(epoch from (v_ent.current_period_end - v_now)), 0) end,
    'accessRemainingSeconds', case when v_ent.pass_id is null then null
                                   else greatest(extract(epoch from (v_ent.access_until - v_now)), 0) end,
    'trial', jsonb_build_object(
      'used', v_trial.id is not null,
      'status', case
                  when v_trial.id is null then 'none'
                  when v_trial.disposition = 'forfeited' then 'replaced_by_pass'
                  when v_trial.disposition = 'revoked' then 'revoked'
                  when v_trial.started_at <= v_now and v_now < v_trial.ends_at then 'active'
                  else 'ended' end,
      'startedAt', v_trial.started_at,
      'endsAt', coalesce(v_trial.ended_at, v_trial.ends_at),
      'eligible', v_el.eligible,
      'reason', v_el.reason),
    -- "Your free trial has ended" applies only to hosts whose ONLY access was the trial.
    'trialEndedNoPass', v_access.state = 'expired' and v_trial.id is not null and not v_other
  );
end $$;

create or replace function public.my_game_pass_summary()
returns jsonb language sql stable security definer set search_path = '' as $$
  select public.game_pass_summary_for(auth.uid())
$$;

-- ------------------------------------------------------------------ privileges ----
revoke all on function public.ensure_trial_for(uuid, text), public.ensure_my_trial(),
  public.handle_trial_on_confirm(), public.game_pass_summary_for(uuid), public.my_game_pass_summary()
  from public, anon, authenticated;
grant execute on function public.ensure_my_trial(), public.my_game_pass_summary() to authenticated;
grant execute on function public.ensure_trial_for(uuid, text), public.game_pass_summary_for(uuid) to service_role;
