-- Revert of 20261112000012_capacity_enforcement.sql (NOT a migration). Restores the exact enforce_player_update()
-- body of 20261111000002 (security invoker, immutability check only), i.e. what production ran before 000012.
-- WARNING: this re-opens the capacity bypass 000012 closed (a removed player restored into a full room).
-- Execute grants stay revoked (harmless: a trigger function is never called directly).
-- Run in one transaction:  begin; \i this file; commit;  then: npx supabase migration repair --status reverted 20261112000012 --remote

create or replace function public.enforce_player_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.id <> old.id or new.game_id <> old.game_id
     or new.token_hash <> old.token_hash or new.nickname <> old.nickname then
    raise exception 'immutable player column' using errcode = '42501';
  end if;
  return new;
end $$;
