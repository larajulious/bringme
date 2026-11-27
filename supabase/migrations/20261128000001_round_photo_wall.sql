-- Per-round sticky-note photo wall option for Bring Me presenter & TV screens. Forward-only, re-runnable.
-- REQUIRES 20261113000002_realtime_audience.sql (uses bump_game_version(uuid, text) and host_sync_keys(uuid, text)).
--
-- Lets the Game Master opt in per round to display players' non-rejected photos on the presentation/TV screen
-- during review (before announcing the winner) or after the winner is announced.
--  - Defaults to false for every round (audience-safe by default).
--  - Automatically resets to false when a round's winner is confirmed, so the TV immediately reveals the winner.
--  - Toggling broadcasts only on game:<id>:host (console, presenter, TV link); players are never woken up.

do $$ begin
  if to_regprocedure('public.bump_game_version(uuid, text)') is null
     or to_regprocedure('public.host_sync_keys(uuid, text)') is null then
    raise exception 'photo_wall_precondition: apply 20261113000002_realtime_audience.sql first';
  end if;
end $$;

alter table public.game_rounds
  add column if not exists show_photos_on_screen boolean not null default false;

-- Only the owner-checked RPC below may change this flag.
revoke update (show_photos_on_screen) on public.game_rounds from public, anon, authenticated;

-- When a winner is confirmed (even "no winner"), close any pre-winner photo wall so the announcement takes the screen.
create or replace function public.game_rounds_reset_photo_wall()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.winner_confirmed_at is null and new.winner_confirmed_at is not null then
    new.show_photos_on_screen := false;
  end if;
  return new;
end $$;

drop trigger if exists game_rounds_reset_photo_wall on public.game_rounds;
create trigger game_rounds_reset_photo_wall before update on public.game_rounds
  for each row execute function public.game_rounds_reset_photo_wall();

-- Include `showPhotosOnScreen` in the round snapshot (read by host console, presenter, and TV screen).
create or replace function public.game_state_json(p_game uuid, p_viewer text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  g public.games%rowtype;
  r public.game_rounds%rowtype;
begin
  select * into g from public.games where id = p_game;
  if not found then return null; end if;
  if g.current_round_id is not null then
    select * into r from public.game_rounds where id = g.current_round_id;
  end if;
  return public.host_sync_keys(g.id, p_viewer) || jsonb_build_object(
    'version', g.state_version,
    'status', g.status,
    'phase', g.phase,
    'title', g.title,
    'serverNow', clock_timestamp(),
    'countdownEndsAt', g.countdown_ends_at,
    'totalRounds', (select count(*) from public.game_rounds where game_id = g.id and replayed_at is null),
    'roundsRemaining', (select count(*) from public.game_rounds
                         where game_id = g.id and status = 'pending' and id is distinct from g.current_round_id),
    'playerCount', (select count(*) from public.players where game_id = g.id and kicked_at is null),
    'maxPlayers', g.max_players,
    'archivedAt', g.archived_at,
    'submissionCount', case when r.id is null then 0
                            else (select count(*) from public.submissions s
                                   join public.players pl on pl.id = s.player_id and pl.kicked_at is null
                                  where s.round_id = r.id) end,
    'reviewCounts', case when r.id is null then null else (
      select jsonb_build_object(
        'pending',  count(*) filter (where s.status = 'pending'),
        'approved', count(*) filter (where s.status = 'approved'),
        'rejected', count(*) filter (where s.status = 'rejected'))
      from public.submissions s join public.players pl on pl.id = s.player_id and pl.kicked_at is null
      where s.round_id = r.id) end,
    'results', case when g.status = 'finished' then public.game_results_json(g.id, null) else null end,
    'round', case when r.id is null then null else jsonb_build_object(
      'id', r.id,
      -- the number players see: replayed rounds are left out, so a replay keeps its round's number
      'no', (select count(*) from public.game_rounds x where x.game_id = g.id and x.round_no <= r.round_no and x.replayed_at is null),
      'status', r.status,
      'openedAt', r.opened_at,
      'closedAt', r.closed_at,
      'timeLimitSeconds', r.time_limit_seconds,
      'prompt', case when p_viewer = 'host' or (r.opened_at is not null and r.opened_at <= clock_timestamp())
                     then r.prompt end,
      'winnerPlayerId', r.winner_player_id,
      'winnerName', (select nickname from public.players where id = r.winner_player_id),
      'winnerMs', r.winner_rank_ms,
      'decided', r.winner_confirmed_at is not null,
      'showPhotosOnScreen', r.show_photos_on_screen
    ) end
  );
end $$;

-- Host-only toggle for the current round's photo wall on the presenter & TV screens.
create or replace function public.set_round_photo_wall(p_game uuid, p_show boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  g public.games%rowtype;
  r public.game_rounds%rowtype;
  v_show boolean := coalesce(p_show, false);
begin
  if auth.uid() is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  select * into g from public.games where id = p_game and owner_id = auth.uid() for update;
  if not found then raise exception 'game_not_found' using errcode = 'P0001'; end if;
  if g.game_type <> 'bring_me' or g.status <> 'live' or g.current_round_id is null then
    raise exception 'invalid_transition' using errcode = 'P0001';
  end if;
  select * into r from public.game_rounds where id = g.current_round_id for update;
  if not found then raise exception 'invalid_transition' using errcode = 'P0001'; end if;
  if not (g.phase in ('reviewing', 'winner_announced') or (g.phase = 'active' and r.status = 'closed')) then
    raise exception 'invalid_transition' using errcode = 'P0001';
  end if;

  if r.show_photos_on_screen is distinct from v_show then
    update public.game_rounds set show_photos_on_screen = v_show where id = r.id;
    perform public.bump_game_version(g.id, 'host');
  end if;
  return public.game_state_json(g.id, 'host') || jsonb_build_object('joinCode', g.join_code);
end $$;

revoke all on function public.game_rounds_reset_photo_wall(), public.set_round_photo_wall(uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.set_round_photo_wall(uuid, boolean) to authenticated;
