-- BringMe! Phase 5: atomic game creation.
-- SECURITY INVOKER on purpose: it runs as the signed-in subscriber, so RLS,
-- column grants and every Phase 2/4 trigger (active subscription, plan limits,
-- period cap, round cap) apply exactly as for direct inserts. The owner is
-- always auth.uid(): callers cannot create games for someone else.
--
-- One call = one transaction: either the game, ALL its rounds and the open
-- lobby exist, or nothing does.
create or replace function public.create_game_with_rounds(p_title text, p_items text[])
returns table (game_id uuid, code text)
language plpgsql security invoker set search_path = '' as $$
declare
  v_id uuid;
  v_code text;
  v_n integer := coalesce(array_length(p_items, 1), 0);
begin
  if v_n < 1 then
    raise exception 'items_required' using errcode = 'P0001';
  end if;
  if exists (select 1 from unnest(p_items) i where i is null or btrim(i) = '') then
    raise exception 'empty_item' using errcode = 'P0001';
  end if;

  insert into public.games (owner_id, title)
  values (auth.uid(), coalesce(nullif(btrim(p_title), ''), 'Untitled game'))
  returning public.games.id, public.games.join_code into v_id, v_code;

  insert into public.game_rounds (game_id, round_no, prompt)
  select v_id, t.ord::integer, btrim(t.item)
  from unnest(p_items) with ordinality as t(item, ord);

  -- Open the lobby so players can join (needs an unexpired subscription).
  update public.games set status = 'lobby' where id = v_id;

  return query select v_id, v_code;
end $$;

revoke all on function public.create_game_with_rounds(text, text[]) from public, anon, authenticated;
grant execute on function public.create_game_with_rounds(text, text[]) to authenticated;
