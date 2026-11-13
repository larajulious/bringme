-- Revert of 20261113000003_tv_screen_links.sql (NOT a migration). Every TV link stops working at once; the signed-in
-- presenter screen (/present/[id]) is unaffected. Restores can_listen_game_topic from 20261113000002 verbatim.
-- Run in one transaction:  begin; \i this file; commit;

create or replace function public.can_listen_game_topic(p_topic text)
returns boolean language sql stable security definer set search_path = '' as $$
  select case
    when p_topic ~ '^game:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      exists (select 1 from public.games g
              where g.id = substr(p_topic, 6)::uuid and g.owner_id = auth.uid())
      or ((auth.jwt() ->> 'kind') = 'guest' and (auth.jwt() ->> 'game_id') = substr(p_topic, 6))
    -- host-only hints (submissions, reviews, claims): the owning host only, never a guest token
    when p_topic ~ '^game:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:host$' then
      exists (select 1 from public.games g
              where g.id = substr(p_topic, 6, 36)::uuid and g.owner_id = auth.uid())
    else false
  end
$$;

revoke execute on function public.round_ranking(uuid, integer), public.game_results(uuid) from service_role;
drop function if exists public.screen_state(text);
drop function if exists public.screen_link(uuid, boolean);
drop function if exists public.new_screen_token();
drop table if exists public.game_screens;
