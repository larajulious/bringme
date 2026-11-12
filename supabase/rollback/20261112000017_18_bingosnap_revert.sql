-- BingoSnap: COMPENSATING REVERT for 20261112000017_bingosnap_schema.sql, 20261112000018_bingosnap_functions.sql
-- 20261112000019_bingosnap_board_drafts.sql, 20261112000020_bingosnap_lobby.sql and 20261112000021_bingosnap_claims.sql.
-- NOT a migration (kept outside supabase/migrations on purpose). Run manually, in one transaction,
-- ONLY if BingoSnap must be removed:  begin; \i this file; commit;
--
-- Safety: it REFUSES to run while any BingoSnap game exists, so it can never delete game data.
-- (Cancel/keep those games, or export them first; deleting them is a separate, deliberate decision.)
-- Bring Me tables, rows and functions are not touched: only BingoSnap objects are dropped.

do $$ begin
  if to_regclass('public.games') is not null
     and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'games' and column_name = 'game_type')
     and exists (select 1 from public.games where game_type::text = 'bingosnap') then
    raise exception 'bingosnap_revert_refused: BingoSnap games exist; nothing was changed';
  end if;
end $$;

-- reliable claims (migration 21; its column and index go with the bingo_submissions table below)
drop function if exists public.bingo_submit_claim(text, uuid[], uuid);

-- lobby (migration 20; bingo_player_state is dropped with migration 18's functions below)
drop function if exists public.bingo_start(uuid, bigint);
drop function if exists public.bingo_room_info(text);

-- board drafts (migration 19)
drop trigger if exists guard_bingosnap_board_complete on public.games;
drop function if exists public.bingo_save_board(uuid, integer, text, integer, text, boolean, integer, text, text[], boolean);
drop function if exists public.guard_bingosnap_board_complete();
drop function if exists public.bingo_board_problem(uuid);

-- functions (migration 18)
drop function if exists public.bingo_player_state(text);
drop function if exists public.bingo_host_state(uuid, text);
drop function if exists public.bingo_review_submission(uuid, text, text);
drop function if exists public.bingo_submit_claim(text, uuid[]);
drop function if exists public.bingo_update_settings(uuid, bigint, text);
drop function if exists public.bingo_transition(uuid, text, bigint, uuid);
drop function if exists public.create_bingosnap_game(text, integer, text, boolean, integer, text, text[]);
drop function if exists public.bingo_state_json(uuid, text, uuid);
drop function if exists public.bingo_results_json(uuid);
drop function if exists public.bingo_settle(uuid);
drop function if exists public.bingo_ranking(uuid);
drop function if exists public.bingo_pattern(integer, public.bingo_win_mode, integer, integer[]);
drop function if exists public.bingo_layout(uuid, uuid);
drop function if exists public.bingo_center(integer, boolean);

-- guards (migration 17)
drop trigger if exists guard_bring_me_only on public.game_rounds;
drop trigger if exists guard_bring_me_only on public.submission_intents;
drop trigger if exists guard_bring_me_only on public.submissions;
drop trigger if exists guard_bingosnap_game_state on public.games;
drop trigger if exists guard_game_type_immutable on public.games;

-- tables (empty: guaranteed by the check above, since they cascade from BingoSnap games)
drop table if exists public.bingo_submissions;
drop table if exists public.bingo_cells;
drop table if exists public.bingo_games;

drop function if exists public.bingo_touch();
drop function if exists public.guard_bring_me_only();
drop function if exists public.guard_bingosnap_game_state();
drop function if exists public.guard_game_type_immutable();

drop index if exists public.games_bingosnap_idx;
alter table public.games drop column if exists game_type;   -- every remaining row is 'bring_me'

drop type if exists public.bingo_submission_status;
drop type if exists public.bingo_winner_rule;
drop type if exists public.bingo_win_mode;
drop type if exists public.game_type;
