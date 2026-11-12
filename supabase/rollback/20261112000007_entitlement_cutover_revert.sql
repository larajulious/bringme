-- BringMe! COMPENSATING REVERT for 20261112000007_entitlement_cutover.sql.
-- NOT a migration (kept outside supabase/migrations on purpose). Run it manually, in one
-- transaction, ONLY if the cutover must be undone:  begin; \i this file; commit;
--
-- What it does:
--   1. projects current pass access back into public.subscriptions (one live row per host,
--      [now, end of contiguous access)), so hosts who bought after the cutover keep access;
--      projected rows are tagged external_ref = 'ledger_projection:<pass id>' so a later
--      re-cutover never converts them again (edits made to them while reverted are NOT carried back);
--      legacy rows that no longer correspond to access are marked canceled;
--   2. restores the pre-cutover function bodies VERBATIM (copied from migrations 6/8/9/11);
--   3. unfreezes subscriptions and makes sync_lobby_capacity a no-op again.
-- Ledger tables (passes, segments, orders, events, prices) are KEPT untouched: re-applying
-- 20261112000007 later restores the full queue/history from them.
-- Known simplification while reverted: queued/paused ordering collapses to "access until X
-- on the current plan" (the ledger still holds the truth).

drop trigger if exists guard_legacy_subscriptions on public.subscriptions;

do $$
declare
  r record;
  v_sub uuid;
begin
  -- Hosts with a running pass: one live subscription row covering their contiguous access.
  for r in
    select pr.id as uid, pr.hosting_suspended_at as susp, p.plan_id, p.id as pass_id,
           (with recursive chain as (
              select s.ends_at from public.pass_segments s
               where s.pass_id = p.id and s.starts_at <= now() and now() < s.ends_at
              union
              select s2.ends_at from public.pass_segments s2 join chain c on s2.user_id = pr.id and s2.starts_at = c.ends_at)
            select max(ends_at) from chain) as until
      from public.profiles pr
      join public.game_passes p on p.id = public.current_pass_id(pr.id)
  loop
    select id into v_sub from public.subscriptions
     where user_id = r.uid and status in ('trialing', 'active', 'past_due', 'suspended')
     order by created_at desc limit 1;
    if v_sub is null then
      insert into public.subscriptions (user_id, plan_id, status, current_period_start, current_period_end, external_ref)
      values (r.uid, r.plan_id, case when r.susp is not null then 'suspended' else 'active' end::public.subscription_status, now(), r.until,
              'ledger_projection:' || r.pass_id);
    else
      update public.subscriptions
         set plan_id = r.plan_id, status = case when r.susp is not null then 'suspended' else 'active' end::public.subscription_status,
             cancel_at_period_end = false, current_period_start = now(), current_period_end = r.until,
             external_ref = coalesce(external_ref, 'ledger_projection:' || r.pass_id)
       where id = v_sub;
    end if;
  end loop;
  -- Legacy rows that would grant access the ledger no longer gives (e.g. an admin-revoked pass).
  update public.subscriptions s set status = 'canceled'
   where s.status in ('trialing', 'active', 'past_due', 'suspended') and s.current_period_end > now()
     and public.current_pass_id(s.user_id) is null;
end $$;

-- verbatim from 20261111000006_admin_dashboard.sql
create or replace function public.entitlement_for(p_user uuid)
returns table (
  subscription_id uuid, plan_code text,
  max_active_games integer, max_players_per_game integer, max_rounds_per_game integer,
  current_period_end timestamptz
) language sql stable security definer set search_path = '' as $$
  select s.id, p.code, p.max_active_games, p.max_players_per_game, p.max_rounds_per_game, s.current_period_end
  from public.subscriptions s
  join public.subscription_plans p on p.id = s.plan_id
  join public.profiles pr on pr.id = s.user_id and pr.deactivated_at is null
  where s.user_id = p_user
    and s.status in ('trialing', 'active')
    and s.current_period_start <= now()
    and s.current_period_end > now()
  order by s.current_period_end desc
  limit 1
$$;

-- verbatim from 20261111000006_admin_dashboard.sql
create or replace function public.access_state_for(p_user uuid)
returns table (state text, plan_code text, current_period_end timestamptz)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_ent record;
  v_sub record;
begin
  if exists (select 1 from public.profiles where id = p_user and deactivated_at is not null) then
    return query select 'deactivated'::text, null::text, null::timestamptz;
    return;
  end if;

  select * into v_ent from public.entitlement_for(p_user);
  if v_ent.subscription_id is not null then
    return query select 'active'::text, v_ent.plan_code, v_ent.current_period_end;
    return;
  end if;

  select s.status, p.code as pcode, s.current_period_end as pend, s.current_period_start as pstart
    into v_sub
  from public.subscriptions s
  join public.subscription_plans p on p.id = s.plan_id
  where s.user_id = p_user
  order by s.created_at desc
  limit 1;

  if not found then
    return query select 'pending'::text, null::text, null::timestamptz;
  elsif v_sub.status = 'suspended' then
    return query select 'suspended'::text, v_sub.pcode, v_sub.pend;
  elsif v_sub.status in ('trialing', 'active') and v_sub.pstart > now() then
    return query select 'pending'::text, v_sub.pcode, v_sub.pend;
  else
    return query select 'expired'::text, v_sub.pcode, v_sub.pend;
  end if;
end $$;

-- verbatim from 20261111000006_admin_dashboard.sql
create or replace function public.enforce_game_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_ent record;
  v_period record;
  v_active integer;
  v_period_count integer;
begin
  if new.status <> 'draft' then
    raise exception 'games must be created as draft' using errcode = 'P0001';
  end if;
  if not public.is_admin_user(new.owner_id) then
    select * into v_ent from public.entitlement_for(new.owner_id);
    if v_ent is null then
      raise exception 'subscription_required' using errcode = 'P0001';
    end if;
    select count(*) into v_active from public.games
      where owner_id = new.owner_id and status in ('draft', 'lobby', 'live');
    if v_active >= v_ent.max_active_games then
      raise exception 'game_limit_reached' using errcode = 'P0001';
    end if;

    select s.current_period_start as pstart, p.max_games_per_period as pmax into v_period
      from public.subscriptions s join public.subscription_plans p on p.id = s.plan_id
      where s.id = v_ent.subscription_id;
    if v_period.pmax is not null then
      select count(*) into v_period_count from public.games
        where owner_id = new.owner_id and created_at >= v_period.pstart;
      if v_period_count >= v_period.pmax then
        raise exception 'period_game_limit_reached' using errcode = 'P0001';
      end if;
    end if;
    new.max_players := least(new.max_players, v_ent.max_players_per_game);
  end if;
  return new;
end $$;

-- verbatim from 20261111000009_game_engine.sql
create or replace function public.enforce_player_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_game record;
  v_count integer;
begin
  select * into v_game from public.games where id = new.game_id for update;
  if v_game is null or v_game.status <> 'lobby' then
    raise exception 'game_not_joinable' using errcode = 'P0001';
  end if;
  select count(*) into v_count from public.players where game_id = new.game_id and kicked_at is null;
  if v_count >= v_game.max_players then
    raise exception 'game_full' using errcode = 'P0001';
  end if;
  new.kicked_at := null;
  return new;
end $$;

-- verbatim from 20261111000008_guest_join.sql
create or replace function public.public_room_info(p_code text)
returns table (title text, status public.game_status, player_count bigint, max_players integer)
language sql stable security definer set search_path = '' as $$
  select g.title, g.status,
         (select count(*) from public.players p where p.game_id = g.id and p.kicked_at is null),
         g.max_players
  from public.games g
  where g.join_code = upper(p_code)
$$;

-- verbatim from 20261111000011_review_winners.sql
create or replace function public.game_transition(
  p_game uuid, p_action text, p_expected_version bigint, p_winner uuid default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  g public.games%rowtype;
  r public.game_rounds%rowtype;
  v_ver bigint;
  v_phase public.game_phase;
  v_win record;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  if p_action not in ('start_game', 'start_countdown', 'start_round', 'close_submissions',
                      'move_to_review', 'announce_winner', 'next_round', 'end_game', 'cancel', 'archive') then
    raise exception 'invalid_action' using errcode = 'P0001';
  end if;

  -- Not the owner and not existing look identical (no information leak).
  select * into g from public.games where id = p_game and owner_id = auth.uid() for update;
  if not found then
    raise exception 'game_not_found' using errcode = 'P0001';
  end if;
  if g.state_version <> p_expected_version then
    raise exception 'stale_state' using errcode = 'P0001';
  end if;

  if g.current_round_id is not null then
    select * into r from public.game_rounds where id = g.current_round_id for update;
  end if;

  if p_action = 'start_game' then
    if g.status <> 'lobby' then raise exception 'invalid_transition' using errcode = 'P0001'; end if;
    if not exists (select 1 from public.players where game_id = g.id and kicked_at is null) then
      raise exception 'no_players' using errcode = 'P0001';
    end if;
    if not exists (select 1 from public.game_rounds where game_id = g.id and status = 'pending') then
      raise exception 'no_rounds_left' using errcode = 'P0001';
    end if;
    update public.games set status = 'live' where id = g.id;  -- entitlement checked by trigger

  elsif p_action = 'start_countdown' then
    if g.status <> 'live' or g.phase <> 'lobby' then
      raise exception 'invalid_transition' using errcode = 'P0001';
    end if;
    if not public.is_admin_user(g.owner_id)
       and not exists (select 1 from public.entitlement_for(g.owner_id)) then
      raise exception 'subscription_required' using errcode = 'P0001';
    end if;
    select * into r from public.game_rounds
      where game_id = g.id and status = 'pending' order by round_no limit 1;
    if not found then raise exception 'no_rounds_left' using errcode = 'P0001'; end if;
    update public.games
       set phase = 'countdown', current_round_id = r.id,
           countdown_ends_at = clock_timestamp() + interval '3 seconds'
     where id = g.id;

  elsif p_action = 'start_round' then
    if g.phase <> 'countdown' or r.id is null then
      raise exception 'invalid_transition' using errcode = 'P0001';
    end if;
    update public.game_rounds set status = 'open' where id = r.id;
    -- Official start = the end of the countdown (or now, if it already passed).
    update public.game_rounds
       set opened_at = greatest(clock_timestamp(), g.countdown_ends_at)
     where id = r.id;
    update public.games set phase = 'active' where id = g.id;

  elsif p_action = 'close_submissions' then
    if g.phase <> 'active' or r.id is null or r.status <> 'open' then
      raise exception 'invalid_transition' using errcode = 'P0001';
    end if;
    if r.opened_at > clock_timestamp() then
      raise exception 'round_not_started' using errcode = 'P0001';
    end if;
    update public.game_rounds set status = 'closed' where id = r.id;

  elsif p_action = 'move_to_review' then
    if g.phase <> 'active' or r.id is null or r.status <> 'closed' then
      raise exception 'invalid_transition' using errcode = 'P0001';
    end if;
    update public.games set phase = 'reviewing' where id = g.id;

  elsif p_action = 'announce_winner' then
    if g.phase <> 'reviewing' or r.id is null then
      raise exception 'invalid_transition' using errcode = 'P0001';
    end if;
    if r.winner_confirmed_at is not null then
      raise exception 'winner_already_confirmed' using errcode = 'P0001';
    end if;
    -- THE WINNER IS COMPUTED HERE, never taken from the caller: the fastest APPROVED
    -- submission by the ranking policy (disqualified / pending / removed players never win).
    -- p_winner is the host's CONFIRMATION of what they saw; if the ranking moved
    -- meanwhile (late photo, another decision) it no longer matches and nothing is announced.
    select s.id, s.player_id, s.rank_ms into v_win
      from public.submissions s
      join public.players pl on pl.id = s.player_id and pl.kicked_at is null
      where s.round_id = r.id and s.status = 'approved'
      order by s.rank_ms, s.server_elapsed_ms, s.submitted_at, s.id
      limit 1;
    if p_winner is distinct from v_win.player_id then
      raise exception 'winner_mismatch' using errcode = 'P0001';
    end if;
    update public.game_rounds
       set winner_player_id = v_win.player_id, winner_submission_id = v_win.id,
           winner_rank_ms = v_win.rank_ms, winner_confirmed_at = clock_timestamp()
     where id = r.id;
    update public.games set phase = 'winner_announced' where id = g.id;

  elsif p_action = 'next_round' then
    if g.phase <> 'winner_announced' then
      raise exception 'invalid_transition' using errcode = 'P0001';
    end if;
    if not exists (select 1 from public.game_rounds where game_id = g.id and status = 'pending') then
      raise exception 'no_rounds_left' using errcode = 'P0001';
    end if;
    update public.games set phase = 'lobby', current_round_id = null, countdown_ends_at = null where id = g.id;

  elsif p_action = 'end_game' then
    if g.status <> 'live' then raise exception 'invalid_transition' using errcode = 'P0001'; end if;
    update public.game_rounds set status = 'closed' where game_id = g.id and status = 'open';
    update public.games set status = 'finished' where id = g.id;

  elsif p_action = 'archive' then
    if g.status <> 'finished' or g.archived_at is not null then
      raise exception 'invalid_transition' using errcode = 'P0001';
    end if;
    update public.games set archived_at = clock_timestamp() where id = g.id;

  elsif p_action = 'cancel' then
    if g.status not in ('draft', 'lobby', 'live') then
      raise exception 'invalid_transition' using errcode = 'P0001';
    end if;
    update public.game_rounds set status = 'closed' where game_id = g.id and status = 'open';
    update public.games set status = 'canceled' where id = g.id;
  end if;

  select state_version, phase into v_ver, v_phase from public.games where id = g.id;
  if v_ver = g.state_version then            -- e.g. close_submissions changed only the round
    update public.games set state_version = state_version + 1, phase_changed_at = clock_timestamp()
     where id = g.id returning state_version, phase into v_ver, v_phase;
  end if;
  perform public.broadcast_game(g.id, v_ver, v_phase);

  return public.game_state_json(g.id, 'host') || jsonb_build_object('joinCode', g.join_code);
end $$;

-- verbatim from 20261111000006_admin_dashboard.sql
create or replace function public.admin_set_subscription(
  p_user uuid, p_action text, p_plan_code text default null,
  p_days integer default null, p_expires timestamptz default null
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_plan uuid;
  v_target record;
  v_updated integer;
begin
  if not exists (select 1 from public.profiles where id = p_user and role = 'subscriber') then
    raise exception 'user_not_found' using errcode = 'P0001';
  end if;

  if p_action in ('activate', 'set_plan') then
    select id into v_plan from public.subscription_plans where code = p_plan_code and is_active;
    if v_plan is null then raise exception 'unknown_plan' using errcode = 'P0001'; end if;
  end if;

  -- The user's current (live or suspended) subscription row, if any.
  select id, current_period_start into v_target from public.subscriptions
    where user_id = p_user and status in ('trialing', 'active', 'past_due', 'suspended')
    order by created_at desc limit 1 for update;

  if p_action = 'activate' then
    if exists (select 1 from public.profiles where id = p_user and deactivated_at is not null) then
      raise exception 'account_deactivated' using errcode = 'P0001';
    end if;
    if p_days is null or p_days < 1 or p_days > 366 then
      raise exception 'invalid_days' using errcode = 'P0001';
    end if;
    if v_target.id is null then
      insert into public.subscriptions (user_id, plan_id, status, current_period_start, current_period_end)
      values (p_user, v_plan, 'active', now(), now() + make_interval(days => p_days));
    else
      update public.subscriptions
        set plan_id = v_plan, status = 'active', cancel_at_period_end = false,
            current_period_start = now(), current_period_end = now() + make_interval(days => p_days)
        where id = v_target.id;
    end if;

  elsif p_action = 'set_plan' then
    if v_target.id is null then raise exception 'no_subscription' using errcode = 'P0001'; end if;
    update public.subscriptions set plan_id = v_plan where id = v_target.id;

  elsif p_action = 'set_expiry' then
    if v_target.id is null then raise exception 'no_subscription' using errcode = 'P0001'; end if;
    if p_expires is null or p_expires <= v_target.current_period_start
       or p_expires > now() + interval '5 years' then
      raise exception 'invalid_expiry' using errcode = 'P0001';
    end if;
    update public.subscriptions set current_period_end = p_expires where id = v_target.id;

  elsif p_action = 'suspend' then
    update public.subscriptions set status = 'suspended'
      where user_id = p_user and status in ('trialing', 'active', 'past_due');
    get diagnostics v_updated = row_count;
    if v_updated = 0 then raise exception 'no_live_subscription' using errcode = 'P0001'; end if;

  else
    raise exception 'invalid_action' using errcode = 'P0001';
  end if;
end $$;

create or replace function public.sync_lobby_capacity(p_user uuid, p_old_cap integer)
returns void language plpgsql security definer set search_path = '' as $$
begin
  return;
end $$;

comment on table public.subscriptions is 'Entitlement source (cutover reverted).';
