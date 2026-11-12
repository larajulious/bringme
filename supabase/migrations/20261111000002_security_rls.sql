-- BringMe! Phase 2 / migration 2 of 3: authorization.
-- Security model (see docs/SECURITY.md):
--   * super_admin / subscriber live in public.profiles.role (never in JWT metadata).
--   * `anon` has NO table privileges: guests are served only by server handlers
--     that validate a guest token and use the service-role key.
--   * `authenticated` gets the minimum column-level grants + row-level policies.
--   * Entitlement + state-machine rules are enforced by triggers, so they also
--     bind the service role and any future client.

-- ------------------------------------------------------ helper functions ----
create or replace function public.is_admin_user(p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = p_user and role = 'super_admin')
$$;

create or replace function public.is_super_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_admin_user(auth.uid())
$$;

create or replace function public.owns_game(p_game uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.games where id = p_game and owner_id = auth.uid())
$$;

-- Storage object names are '<game_id>/<round_id>/<player_id>.<ext>'.
create or replace function public.owns_game_path(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select case
    when p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
    then exists (
      select 1 from public.games g
      where g.id = split_part(p_name, '/', 1)::uuid and g.owner_id = auth.uid())
    else false
  end
$$;

-- Subscription entitlement. A subscription entitles only while status is
-- trialing/active AND now() is inside its period: expiry is time-based, so a
-- stale status column (e.g. a missed webhook) can never keep someone entitled.
create or replace function public.entitlement_for(p_user uuid)
returns table (
  subscription_id uuid, plan_code text,
  max_active_games integer, max_players_per_game integer, max_rounds_per_game integer,
  current_period_end timestamptz
) language sql stable security definer set search_path = '' as $$
  select s.id, p.code, p.max_active_games, p.max_players_per_game, p.max_rounds_per_game, s.current_period_end
  from public.subscriptions s
  join public.subscription_plans p on p.id = s.plan_id
  where s.user_id = p_user
    and s.status in ('trialing', 'active')
    and s.current_period_start <= now()
    and s.current_period_end > now()
  order by s.current_period_end desc
  limit 1
$$;

-- What the signed-in user may read about their own entitlement.
create or replace function public.my_entitlement()
returns table (
  subscription_id uuid, plan_code text,
  max_active_games integer, max_players_per_game integer, max_rounds_per_game integer,
  current_period_end timestamptz
) language sql stable security definer set search_path = '' as $$
  select * from public.entitlement_for(auth.uid())
$$;

-- ----------------------------------------------------- profile role guard ----
-- Second line of defence behind column grants: only trusted DB roles may change
-- a role (service_role from a server, or postgres from the SQL editor).
create or replace function public.guard_profile_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.id is distinct from old.id then
    raise exception 'profile id is immutable' using errcode = '42501';
  end if;
  if new.role is distinct from old.role
     and current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'role can only be changed by a trusted server' using errcode = '42501';
  end if;
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists guard_profile_update on public.profiles;
create trigger guard_profile_update before update on public.profiles
  for each row execute function public.guard_profile_update();

-- ------------------------------------------------------- games: triggers ----
create or replace function public.enforce_game_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_ent record;
  v_active integer;
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
    new.max_players := least(new.max_players, v_ent.max_players_per_game);
  end if;
  return new;
end $$;

create or replace function public.enforce_game_update()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_ent record;
begin
  if new.id <> old.id or new.owner_id <> old.owner_id
     or new.join_code <> old.join_code or new.created_at <> old.created_at then
    raise exception 'immutable game column' using errcode = '42501';
  end if;

  if new.status is distinct from old.status then
    if not (
      (old.status = 'draft' and new.status in ('lobby', 'canceled')) or
      (old.status = 'lobby' and new.status in ('live', 'canceled')) or
      (old.status = 'live'  and new.status in ('finished', 'canceled'))
    ) then
      raise exception 'invalid_game_transition' using errcode = 'P0001';
    end if;
    -- Opening the lobby / going live needs an unexpired subscription.
    -- Finishing or cancelling never does, so expired hosts can still wrap up.
    if new.status in ('lobby', 'live') and not public.is_admin_user(old.owner_id) then
      if not exists (select 1 from public.entitlement_for(old.owner_id)) then
        raise exception 'subscription_required' using errcode = 'P0001';
      end if;
    end if;
    if new.status = 'live' then new.started_at := now(); end if;
    if new.status in ('finished', 'canceled') then new.finished_at := now(); end if;
  elsif old.status in ('finished', 'canceled') then
    raise exception 'game_is_closed' using errcode = 'P0001';
  end if;

  if new.max_players is distinct from old.max_players and not public.is_admin_user(old.owner_id) then
    select * into v_ent from public.entitlement_for(old.owner_id);
    if v_ent is null then
      raise exception 'subscription_required' using errcode = 'P0001';
    end if;
    new.max_players := least(new.max_players, v_ent.max_players_per_game);
  end if;
  return new;
end $$;

drop trigger if exists enforce_game_insert on public.games;
create trigger enforce_game_insert before insert on public.games
  for each row execute function public.enforce_game_insert();
drop trigger if exists enforce_game_update on public.games;
create trigger enforce_game_update before update on public.games
  for each row execute function public.enforce_game_update();

-- ------------------------------------------------------ rounds: triggers ----
create or replace function public.enforce_round_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_game record;
  v_ent record;
  v_count integer;
begin
  select * into v_game from public.games where id = new.game_id;
  if v_game.status not in ('draft', 'lobby') then
    raise exception 'rounds can only be added before the game starts' using errcode = 'P0001';
  end if;
  new.status := 'pending'; new.opened_at := null; new.closed_at := null;
  if not public.is_admin_user(v_game.owner_id) then
    select * into v_ent from public.entitlement_for(v_game.owner_id);
    if v_ent is null then
      raise exception 'subscription_required' using errcode = 'P0001';
    end if;
    select count(*) into v_count from public.game_rounds where game_id = new.game_id;
    if v_count >= v_ent.max_rounds_per_game then
      raise exception 'round_limit_reached' using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;

create or replace function public.enforce_round_update()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_status public.game_status;
begin
  if new.id <> old.id or new.game_id <> old.game_id then
    raise exception 'immutable round column' using errcode = '42501';
  end if;
  if new.status is distinct from old.status then
    if not ((old.status = 'pending' and new.status = 'open') or (old.status = 'open' and new.status = 'closed')) then
      raise exception 'invalid_round_transition' using errcode = 'P0001';
    end if;
    if new.status = 'open' then
      select status into v_status from public.games where id = new.game_id;
      if v_status <> 'live' then
        raise exception 'game_not_live' using errcode = 'P0001';
      end if;
      new.opened_at := now();
    else
      new.closed_at := now();
    end if;
  elsif old.status <> 'pending'
        and (new.prompt <> old.prompt or new.points <> old.points
             or new.time_limit_seconds <> old.time_limit_seconds or new.round_no <> old.round_no) then
    raise exception 'round_locked' using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists enforce_round_insert on public.game_rounds;
create trigger enforce_round_insert before insert on public.game_rounds
  for each row execute function public.enforce_round_insert();
drop trigger if exists enforce_round_update on public.game_rounds;
create trigger enforce_round_update before update on public.game_rounds
  for each row execute function public.enforce_round_update();

-- ----------------------------------------------------- players: triggers ----
create or replace function public.enforce_player_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_game record;
  v_count integer;
begin
  -- Row lock serialises concurrent joins so max_players cannot be overshot.
  select * into v_game from public.games where id = new.game_id for update;
  if v_game is null or v_game.status not in ('lobby', 'live') then
    raise exception 'game_not_joinable' using errcode = 'P0001';
  end if;
  select count(*) into v_count from public.players where game_id = new.game_id and kicked_at is null;
  if v_count >= v_game.max_players then
    raise exception 'game_full' using errcode = 'P0001';
  end if;
  new.kicked_at := null;
  return new;
end $$;

create or replace function public.enforce_player_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.id <> old.id or new.game_id <> old.game_id
     or new.token_hash <> old.token_hash or new.nickname <> old.nickname then
    raise exception 'immutable player column' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists enforce_player_insert on public.players;
create trigger enforce_player_insert before insert on public.players
  for each row execute function public.enforce_player_insert();
drop trigger if exists enforce_player_update on public.players;
create trigger enforce_player_update before update on public.players
  for each row execute function public.enforce_player_update();

-- ------------------------------------------------- submissions: triggers ----
create or replace function public.enforce_submission_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_round record;
  v_game_status public.game_status;
  v_kicked timestamptz;
begin
  select * into v_round from public.game_rounds where id = new.round_id and game_id = new.game_id;
  select status into v_game_status from public.games where id = new.game_id;
  select kicked_at into v_kicked from public.players where id = new.player_id and game_id = new.game_id;

  if v_game_status is distinct from 'live' then
    raise exception 'game_not_live' using errcode = 'P0001';
  end if;
  if v_kicked is not null then
    raise exception 'player_kicked' using errcode = 'P0001';
  end if;
  if v_round.status is distinct from 'open' then
    raise exception 'round_not_open' using errcode = 'P0001';
  end if;
  -- 5s grace for upload latency.
  if now() > v_round.opened_at + make_interval(secs => v_round.time_limit_seconds + 5) then
    raise exception 'round_closed' using errcode = 'P0001';
  end if;
  new.status := 'pending'; new.points_awarded := 0; new.reviewed_at := null; new.submitted_at := now();
  return new;
end $$;

create or replace function public.enforce_submission_update()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_points integer;
begin
  if new.id <> old.id or new.game_id <> old.game_id or new.round_id <> old.round_id
     or new.player_id <> old.player_id or new.storage_path <> old.storage_path
     or new.submitted_at <> old.submitted_at then
    raise exception 'immutable submission column' using errcode = '42501';
  end if;
  select points into v_points from public.game_rounds where id = old.round_id;
  if new.points_awarded > v_points then
    raise exception 'points exceed round value' using errcode = 'P0001';
  end if;
  if new.status is distinct from old.status then new.reviewed_at := now(); end if;
  return new;
end $$;

drop trigger if exists enforce_submission_insert on public.submissions;
create trigger enforce_submission_insert before insert on public.submissions
  for each row execute function public.enforce_submission_insert();
drop trigger if exists enforce_submission_update on public.submissions;
create trigger enforce_submission_update before update on public.submissions
  for each row execute function public.enforce_submission_update();

-- ----------------------------------------------------------------- grants ----
-- Supabase grants ALL on new public tables to anon/authenticated by default.
-- Start from zero and add back the minimum.
revoke all on public.profiles, public.subscription_plans, public.subscriptions,
              public.games, public.game_rounds, public.players, public.submissions
  from public, anon, authenticated;

grant all on public.profiles, public.subscription_plans, public.subscriptions,
             public.games, public.game_rounds, public.players, public.submissions
  to service_role;

grant select on public.subscription_plans to anon, authenticated;
grant select on public.profiles, public.subscriptions to authenticated;
grant update (display_name) on public.profiles to authenticated;

grant select, delete on public.games to authenticated;
grant insert (owner_id, title, max_players) on public.games to authenticated;
grant update (title, status, max_players) on public.games to authenticated;

grant select, delete on public.game_rounds to authenticated;
grant insert (game_id, round_no, prompt, time_limit_seconds, points) on public.game_rounds to authenticated;
grant update (round_no, prompt, time_limit_seconds, points, status) on public.game_rounds to authenticated;

-- token_hash is deliberately not selectable by any client role.
grant select (id, game_id, nickname, joined_at, last_seen_at, kicked_at) on public.players to authenticated;
grant update (kicked_at) on public.players to authenticated;

grant select on public.submissions to authenticated;
grant update (status, points_awarded) on public.submissions to authenticated;

-- Functions: default is EXECUTE for PUBLIC. Lock everything, then re-grant.
revoke all on function
  public.is_admin_user(uuid), public.is_super_admin(), public.owns_game(uuid),
  public.owns_game_path(text), public.entitlement_for(uuid), public.my_entitlement(),
  public.generate_join_code()
  from public, anon, authenticated;
grant execute on function
  public.is_super_admin(), public.owns_game(uuid), public.owns_game_path(text), public.my_entitlement(),
  public.generate_join_code()  -- column DEFAULT on games.join_code runs as the caller
  to authenticated;
grant execute on function
  public.is_admin_user(uuid), public.entitlement_for(uuid), public.generate_join_code()
  to service_role;

-- -------------------------------------------------------------------- RLS ----
alter table public.profiles           enable row level security;
alter table public.subscription_plans enable row level security;
alter table public.subscriptions      enable row level security;
alter table public.games              enable row level security;
alter table public.game_rounds        enable row level security;
alter table public.players            enable row level security;
alter table public.submissions        enable row level security;

-- profiles: read self; admin reads all. Updates: own display_name only (column grant).
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles for select to authenticated
  using (id = (select auth.uid()));
drop policy if exists profiles_select_admin on public.profiles;
create policy profiles_select_admin on public.profiles for select to authenticated
  using ((select public.is_super_admin()));
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- subscription_plans: public catalogue of active plans. Writes: service role only.
drop policy if exists plans_select_active on public.subscription_plans;
create policy plans_select_active on public.subscription_plans for select to anon, authenticated
  using (is_active);
drop policy if exists plans_select_admin on public.subscription_plans;
create policy plans_select_admin on public.subscription_plans for select to authenticated
  using ((select public.is_super_admin()));

-- subscriptions: read own / admin reads all. Writes: service role only (billing).
drop policy if exists subs_select_own on public.subscriptions;
create policy subs_select_own on public.subscriptions for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists subs_select_admin on public.subscriptions;
create policy subs_select_admin on public.subscriptions for select to authenticated
  using ((select public.is_super_admin()));

-- games: owner full control (entitlement enforced by triggers); admin read-only.
drop policy if exists games_select_own on public.games;
create policy games_select_own on public.games for select to authenticated
  using (owner_id = (select auth.uid()));
drop policy if exists games_select_admin on public.games;
create policy games_select_admin on public.games for select to authenticated
  using ((select public.is_super_admin()));
drop policy if exists games_insert_own on public.games;
create policy games_insert_own on public.games for insert to authenticated
  with check (owner_id = (select auth.uid()) and status = 'draft');
drop policy if exists games_update_own on public.games;
create policy games_update_own on public.games for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
drop policy if exists games_delete_own on public.games;
create policy games_delete_own on public.games for delete to authenticated
  using (owner_id = (select auth.uid()) and status in ('draft', 'finished', 'canceled'));

-- game_rounds: via game ownership.
drop policy if exists rounds_select_own on public.game_rounds;
create policy rounds_select_own on public.game_rounds for select to authenticated
  using (public.owns_game(game_id));
drop policy if exists rounds_select_admin on public.game_rounds;
create policy rounds_select_admin on public.game_rounds for select to authenticated
  using ((select public.is_super_admin()));
drop policy if exists rounds_insert_own on public.game_rounds;
create policy rounds_insert_own on public.game_rounds for insert to authenticated
  with check (public.owns_game(game_id));
drop policy if exists rounds_update_own on public.game_rounds;
create policy rounds_update_own on public.game_rounds for update to authenticated
  using (public.owns_game(game_id)) with check (public.owns_game(game_id));
drop policy if exists rounds_delete_own on public.game_rounds;
create policy rounds_delete_own on public.game_rounds for delete to authenticated
  using (public.owns_game(game_id) and status = 'pending');

-- players: host reads/kicks players of own games. Inserts: service role only (guest join handler).
drop policy if exists players_select_own on public.players;
create policy players_select_own on public.players for select to authenticated
  using (public.owns_game(game_id));
drop policy if exists players_select_admin on public.players;
create policy players_select_admin on public.players for select to authenticated
  using ((select public.is_super_admin()));
drop policy if exists players_update_own on public.players;
create policy players_update_own on public.players for update to authenticated
  using (public.owns_game(game_id)) with check (public.owns_game(game_id));

-- submissions: host reads and scores own games' submissions. Inserts: service role only.
drop policy if exists submissions_select_own on public.submissions;
create policy submissions_select_own on public.submissions for select to authenticated
  using (public.owns_game(game_id));
drop policy if exists submissions_select_admin on public.submissions;
create policy submissions_select_admin on public.submissions for select to authenticated
  using ((select public.is_super_admin()));
drop policy if exists submissions_update_own on public.submissions;
create policy submissions_update_own on public.submissions for update to authenticated
  using (public.owns_game(game_id)) with check (public.owns_game(game_id));
