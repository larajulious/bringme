-- TV link: a public, audience-safe presenter screen for any smart-TV browser (no sign-in). Forward-only, re-runnable.
-- REQUIRES 20261113000002_realtime_audience.sql (can_listen_game_topic below is that body plus the 'screen' kind).
--
-- One secret token per game (12 characters, ~59 bits, from the database's CSPRNG). The host creates or resets it
-- (screen_link, owner-checked); resetting cuts off every TV holding the old link at once: snapshots, lists and
-- Realtime all re-check the CURRENT token. The token table has no client access at all: the app server resolves a
-- token with the service role after validating its format.
-- What a TV can see is exactly the presenter view: Bring Me = the player snapshot (the item only after GO) plus the
-- side-list fingerprints; BingoSnap = bingo_state_json(..., 'presenter'). Never the item list, timings or reviews.
-- Revert (not a migration): supabase/rollback/20261113000003_tv_screen_links_revert.sql

do $$ begin
  if to_regprocedure('public.host_sync_keys(uuid, text)') is null then
    raise exception 'tv_precondition: apply 20261113000002_realtime_audience.sql first';
  end if;
end $$;

-- ------------------------------------------------------------------ table ----
create table if not exists public.game_screens (
  game_id    uuid primary key references public.games(id) on delete cascade,
  token      text not null unique,
  created_at timestamptz not null default clock_timestamp(),
  constraint game_screens_token_format check (token ~ '^[23456789abcdefghjkmnpqrstuvwxyz]{12}$')
);
alter table public.game_screens enable row level security;
-- No policies: clients can't read or write it. Only the server (service role) and the functions below touch it.
revoke all on table public.game_screens from public, anon, authenticated;
grant select on table public.game_screens to service_role;

-- -------------------------------------------------------------- functions ----
-- 12 symbols from a 31-letter alphabet without look-alikes (0/o, 1/l/i), by rejection sampling over a SHA-256 of
-- two random UUIDs (unbiased; easy to type with a TV remote).
create or replace function public.new_screen_token()
returns text language plpgsql volatile security definer set search_path = '' as $$
declare
  c_alpha constant text := '23456789abcdefghjkmnpqrstuvwxyz';
  v_bytes bytea;
  v_tok text;
  v_b integer;
begin
  loop
    v_bytes := sha256(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid()));
    v_tok := '';
    for i in 0 .. length(v_bytes) - 1 loop
      v_b := get_byte(v_bytes, i);
      if v_b < 248 then v_tok := v_tok || substr(c_alpha, v_b % 31 + 1, 1); end if;
      exit when char_length(v_tok) = 12;
    end loop;
    if char_length(v_tok) = 12 and not exists (select 1 from public.game_screens where token = v_tok) then
      return v_tok;
    end if;
  end loop;
end $$;

-- The host's TV link token: created on first use, replaced on reset. Not your game = not found. Drafts have no screen.
create or replace function public.screen_link(p_game uuid, p_reset boolean default false)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare
  g public.games%rowtype;
  v_tok text;
begin
  if auth.uid() is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  select * into g from public.games where id = p_game and owner_id = auth.uid();
  if not found then raise exception 'game_not_found' using errcode = 'P0001'; end if;
  if g.status = 'draft' then raise exception 'game_not_open' using errcode = 'P0001'; end if;

  if coalesce(p_reset, false) then
    insert into public.game_screens (game_id, token) values (g.id, public.new_screen_token())
    on conflict (game_id) do update set token = excluded.token, created_at = clock_timestamp();
  else
    -- two first clicks at once: the second waits for the first and keeps its token
    insert into public.game_screens (game_id, token) values (g.id, public.new_screen_token())
    on conflict (game_id) do nothing;
  end if;
  select token into v_tok from public.game_screens where game_id = g.id;
  return v_tok;
end $$;

-- Service role only: the audience-safe snapshot for a TV token (null = unknown, reset or malformed token).
create or replace function public.screen_state(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  g public.games%rowtype;
begin
  if p_token is null or p_token !~ '^[23456789abcdefghjkmnpqrstuvwxyz]{12}$' then return null; end if;
  select gm.* into g from public.game_screens sc join public.games gm on gm.id = sc.game_id where sc.token = p_token;
  if not found then return null; end if;
  if g.game_type = 'bingosnap' then
    return public.bingo_state_json(g.id, 'presenter') || jsonb_build_object('gameType', 'bingosnap', 'gameId', g.id);
  end if;
  return public.game_state_json(g.id, 'player') || public.host_sync_keys(g.id, 'host')
      || jsonb_build_object('gameType', 'bring_me', 'gameId', g.id, 'joinCode', g.join_code);
end $$;

-- ------------------------------------------------- channel authorization ----
-- As in 20261113000002, plus: a TV's Realtime token (kind 'screen', minted by the server for a valid link) may
-- listen to its game's topics while that link is still the current one. Hints carry no data (version/phase/scope).
create or replace function public.can_listen_game_topic(p_topic text)
returns boolean language sql stable security definer set search_path = '' as $$
  select case
    when p_topic ~ '^game:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      exists (select 1 from public.games g
              where g.id = substr(p_topic, 6)::uuid and g.owner_id = auth.uid())
      or ((auth.jwt() ->> 'kind') = 'guest' and (auth.jwt() ->> 'game_id') = substr(p_topic, 6))
      or ((auth.jwt() ->> 'kind') = 'screen' and exists (
            select 1 from public.game_screens s
             where s.game_id = substr(p_topic, 6)::uuid and s.token = (auth.jwt() ->> 'screen_token')))
    -- host-only hints (submissions, reviews, claims): the owning host, or the game's current TV link
    when p_topic ~ '^game:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:host$' then
      exists (select 1 from public.games g
              where g.id = substr(p_topic, 6, 36)::uuid and g.owner_id = auth.uid())
      or ((auth.jwt() ->> 'kind') = 'screen' and exists (
            select 1 from public.game_screens s
             where s.game_id = substr(p_topic, 6, 36)::uuid and s.token = (auth.jwt() ->> 'screen_token')))
    else false
  end
$$;

-- ------------------------------------------------------------- privileges ----
revoke all on function public.new_screen_token(), public.screen_link(uuid, boolean), public.screen_state(text)
  from public, anon, authenticated;
grant execute on function public.screen_link(uuid, boolean) to authenticated;
grant execute on function public.screen_state(text) to service_role;
-- The TV's lists are read by the server with the service role after it resolved the token (scoped to that game).
grant execute on function public.round_ranking(uuid, integer), public.game_results(uuid) to service_role;
