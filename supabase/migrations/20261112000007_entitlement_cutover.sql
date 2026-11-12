-- BringMe! Game Pass 7/7: ENTITLEMENT CUTOVER (the only file that changes behaviour).
-- Entitlement now comes from the pass ledger (game_passes / pass_segments). Every
-- existing function keeps its signature, so the current app keeps working.
-- Compensating revert (tested): supabase/rollback/20261112000007_entitlement_cutover_revert.sql
--
-- AFTER THIS FILE, never re-run 20261111000006/9/11 on their own: they redefine the same
-- functions with the legacy bodies. Re-running the whole sequence in order (ending here) is safe.
--
-- Behaviour changes (GAME_PASS_DESIGN.md):
--   * entitlement / access state read the ledger (pure time; half-open UTC segments)
--   * D-8  room capacity = the owner's CURRENT pass cap (not platform default 20 capped by plan)
--   * D-9  start_game needs the current pass to cover everyone in the room (player_limit_exceeded)
--   * D-10 no per-round entitlement check once a game is live
--   * D-11 per-period game cap counts from the current pass's activation
--   * admin_set_subscription keeps its signature as a shim over the new admin functions
--   * public.subscriptions is frozen (inserts/updates refused): use admin_grant_pass

do $$ begin
  if to_regprocedure('public.pass_entitlement(uuid)') is null
     or to_regclass('public.pass_segments') is null then
    raise exception 'game_pass_precondition: apply 20261112000001..6 first';
  end if;
  -- Every running legacy subscription must already have its pass (otherwise access would vanish).
  if exists (select 1 from public.subscriptions s
              where s.status in ('trialing', 'active', 'suspended') and s.current_period_end > now()
                and coalesce(s.external_ref, '') not like 'ledger_projection:%'
                and not exists (select 1 from public.game_passes g where g.legacy_subscription_id = s.id)) then
    raise exception 'game_pass_precondition: running subscriptions without a legacy pass; re-run 20261112000006 first';
  end if;
end $$;

-- ------------------------------------------------------------- entitlement ----
create or replace function public.entitlement_for(p_user uuid)
returns table (
  subscription_id uuid, plan_code text,
  max_active_games integer, max_players_per_game integer, max_rounds_per_game integer,
  current_period_end timestamptz
) language sql stable security definer set search_path = '' as $$
  -- subscription_id now carries the active PASS id (compatible shape for existing callers).
  select e.pass_id, e.plan_code, e.max_active_games, e.max_players_per_game, e.max_rounds_per_game, e.current_period_end
  from public.pass_entitlement(p_user) e
$$;

create or replace function public.access_state_for(p_user uuid)
returns table (state text, plan_code text, current_period_end timestamptz)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_prof record;
  v_e    record;
  v_last record;
begin
  select pr.deactivated_at, pr.hosting_suspended_at into v_prof from public.profiles pr where pr.id = p_user;
  if v_prof.deactivated_at is not null then
    return query select 'deactivated'::text, null::text, null::timestamptz;
    return;
  end if;

  select * into v_e from public.pass_entitlement(p_user);
  if v_e.pass_id is not null then
    -- "ends" = when access actually stops (end of the contiguous queue), not just this pass.
    return query select 'active'::text, v_e.plan_code, v_e.access_until;
    return;
  end if;

  -- Latest point of access the host ever had (or has, if suspended).
  select pl.code as pcode, s.ends_at as pend into v_last
    from public.pass_segments s
    join public.game_passes p on p.id = s.pass_id
    join public.subscription_plans pl on pl.id = p.plan_id
   where s.user_id = p_user
   order by s.ends_at desc
   limit 1;

  if v_prof.hosting_suspended_at is not null then
    return query select 'suspended'::text, v_last.pcode, v_last.pend;
  elsif v_last.pend is null then
    return query select 'pending'::text, null::text, null::timestamptz;
  else
    return query select 'expired'::text, v_last.pcode, v_last.pend;
  end if;
end $$;

-- ------------------------------------------------------------ room capacity ----
-- D-8: players allowed in a room = min(the room's own limit, the owner's CURRENT pass cap).
-- games.max_players is set to the pass cap at creation and raised on upgrade (sync below);
-- a host's own lower limit is kept, and an expiry-driven downgrade still shrinks the room.
create or replace function public.game_capacity(p_game uuid)
returns integer language sql stable security definer set search_path = '' as $$
  select case
           when public.is_admin_user(g.owner_id) then g.max_players
           else least(g.max_players, coalesce((select e.max_players_per_game from public.pass_entitlement(g.owner_id) e), g.max_players))
         end
  from public.games g where g.id = p_game
$$;

-- Keep open lobbies' stored limit in step with the pass after a grant/revoke:
-- a room at (or above) the old plan cap follows the new cap; a room the host had
-- deliberately limited below the old cap keeps its limit (never above the new cap).
create or replace function public.sync_lobby_capacity(p_user uuid, p_old_cap integer)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_cap integer;
  v_new integer;
  r record;
begin
  if public.is_admin_user(p_user) then return; end if;
  select e.max_players_per_game into v_cap from public.pass_entitlement(p_user) e;
  if v_cap is null then return; end if;
  for r in select id, max_players from public.games where owner_id = p_user and status in ('draft', 'lobby') loop
    v_new := case when p_old_cap is null or r.max_players >= p_old_cap then v_cap else least(r.max_players, v_cap) end;
    if v_new <> r.max_players then
      update public.games set max_players = v_new where id = r.id;
      perform public.bump_game_version(r.id);
    end if;
  end loop;
end $$;

-- ------------------------------------------------------------- game triggers ----
create or replace function public.enforce_game_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_ent record;
  v_active integer;
  v_period_count integer;
begin
  if new.status <> 'draft' then
    raise exception 'games must be created as draft' using errcode = 'P0001';
  end if;
  if not public.is_admin_user(new.owner_id) then
    select * into v_ent from public.pass_entitlement(new.owner_id);
    if v_ent.pass_id is null then
      raise exception 'subscription_required' using errcode = 'P0001';
    end if;
    select count(*) into v_active from public.games
      where owner_id = new.owner_id and status in ('draft', 'lobby', 'live');
    if v_active >= v_ent.max_active_games then
      raise exception 'game_limit_reached' using errcode = 'P0001';
    end if;
    -- D-11: the period is the current pass (since its first activation).
    if v_ent.max_games_per_period is not null then
      select count(*) into v_period_count from public.games
        where owner_id = new.owner_id and created_at >= v_ent.activated_at;
      if v_period_count >= v_ent.max_games_per_period then
        raise exception 'period_game_limit_reached' using errcode = 'P0001';
      end if;
    end if;
    -- D-8: the room holds what the pass allows (was: platform default capped by the plan).
    new.max_players := v_ent.max_players_per_game;
  end if;
  return new;
end $$;

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
  if v_count >= public.game_capacity(new.game_id) then
    raise exception 'game_full' using errcode = 'P0001';
  end if;
  new.kicked_at := null;
  return new;
end $$;

create or replace function public.public_room_info(p_code text)
returns table (title text, status public.game_status, player_count bigint, max_players integer)
language sql stable security definer set search_path = '' as $$
  select g.title, g.status,
         (select count(*) from public.players p where p.game_id = g.id and p.kicked_at is null),
         public.game_capacity(g.id)
  from public.games g
  where g.join_code = upper(p_code)
$$;

-- ----------------------------------------------------------- game_transition ----
-- Copied from 20261111000011 with exactly two edits (marked "Game Pass D-9" / "D-10").
create or replace function public.game_transition(
  p_game uuid, p_action text, p_expected_version bigint, p_winner uuid default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  g public.games%rowtype;
  r public.game_rounds%rowtype;
  v_ver bigint;
  v_phase public.game_phase;
  v_win record;
  v_cap integer;
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
    -- Game Pass D-9: the CURRENT pass must cover everyone already in the room
    -- (a downgrade or an expiry may have lowered the cap since the lobby opened).
    if not public.is_admin_user(g.owner_id) then
      select e.max_players_per_game into v_cap from public.pass_entitlement(g.owner_id) e;
      if v_cap is null then
        raise exception 'subscription_required' using errcode = 'P0001';
      end if;
      v_cap := least(g.max_players, v_cap);
      if (select count(*) from public.players where game_id = g.id and kicked_at is null) > v_cap then
        raise exception 'player_limit_exceeded' using errcode = 'P0001';
      end if;
      update public.games set status = 'live', max_players = v_cap where id = g.id;  -- entitlement re-checked by trigger
    else
      update public.games set status = 'live' where id = g.id;
    end if;

  elsif p_action = 'start_countdown' then
    if g.status <> 'live' or g.phase <> 'lobby' then
      raise exception 'invalid_transition' using errcode = 'P0001';
    end if;
    -- Game Pass D-10: no per-round entitlement check. A game that went live while the
    -- host was entitled may finish its pre-created rounds (rounds cannot be added after start).
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

-- -------------------------------------------------- admin compatibility shim ----
-- Same signature as 20261111000006 so the current console keeps working; actions map to
-- the audited ledger functions (actor = NULL: prefer calling admin_* with the admin's id).
create or replace function public.admin_set_subscription(
  p_user uuid, p_action text, p_plan_code text default null,
  p_days integer default null, p_expires timestamptz default null
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.profiles where id = p_user and role = 'subscriber') then
    raise exception 'user_not_found' using errcode = 'P0001';
  end if;
  if p_action = 'activate' then
    perform public.admin_grant_pass(null, p_user, p_plan_code, p_days, 'Admin console (legacy activate)');
  elsif p_action = 'set_plan' then
    perform public.admin_set_pass_plan(null, p_user, p_plan_code);
  elsif p_action = 'set_expiry' then
    perform public.admin_set_pass_expiry(null, p_user, p_expires);
  elsif p_action = 'suspend' then
    perform public.admin_set_suspended(null, p_user, true, 'Admin console (legacy suspend)');
  else
    raise exception 'invalid_action' using errcode = 'P0001';
  end if;
end $$;

-- -------------------------------------------------- freeze legacy subscriptions ----
create or replace function public.guard_legacy_subscriptions()
returns trigger language plpgsql set search_path = '' as $$
begin
  if public.ledger_maintenance() then return new; end if;
  raise exception 'subscriptions_frozen: access is granted with admin_grant_pass (Game Pass ledger)' using errcode = '42501';
end $$;
drop trigger if exists guard_legacy_subscriptions on public.subscriptions;
create trigger guard_legacy_subscriptions before insert or update on public.subscriptions
  for each row execute function public.guard_legacy_subscriptions();
comment on table public.subscriptions is
  'FROZEN legacy history (pre Game Pass). Every row has a game_passes.legacy_subscription_id mirror. Do not write.';

-- ------------------------------------------------------------------ privileges ----
revoke all on function public.game_capacity(uuid), public.guard_legacy_subscriptions(), public.sync_lobby_capacity(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.game_capacity(uuid) to service_role;
-- Unchanged signatures keep their existing grants (entitlement_for, access_state_for,
-- public_room_info, game_transition, admin_set_subscription).
