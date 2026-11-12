-- BingoSnap post-migration checks (READ-ONLY). Run after 20261112000017, 18, 19, 20 and 21.
-- Every query only reads the catalog or counts rows. Expected results are noted above each one.

-- 1. Objects exist. Expect: 4 types, 3 tables, games.game_type present.
select
  (select count(*) from pg_type where typnamespace = 'public'::regnamespace
     and typname in ('game_type', 'bingo_win_mode', 'bingo_winner_rule', 'bingo_submission_status')) as types,
  (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'
     and relname in ('bingo_games', 'bingo_cells', 'bingo_submissions')) as tables,
  exists (select 1 from information_schema.columns
           where table_schema = 'public' and table_name = 'games' and column_name = 'game_type') as games_game_type;

-- 2. Existing data unchanged. Expect: every pre-existing game is 'bring_me'.
select game_type, count(*) as games from public.games group by game_type order by 1;

-- 3. RLS on. Expect: 3 rows, all rls = true.
select relname, relrowsecurity as rls from pg_class
 where relnamespace = 'public'::regnamespace and relname in ('bingo_games', 'bingo_cells', 'bingo_submissions') order by 1;

-- 4. No client writes. Expect: 0 rows.
select table_name, grantee, privilege_type from information_schema.table_privileges
 where table_schema = 'public' and table_name like 'bingo_%'
   and grantee in ('anon', 'authenticated') and privilege_type <> 'SELECT';
select table_name, column_name, grantee, privilege_type from information_schema.column_privileges
 where table_schema = 'public' and grantee in ('anon', 'authenticated') and privilege_type in ('INSERT', 'UPDATE')
   and (table_name like 'bingo_%' or (table_name = 'games' and column_name = 'game_type'));

-- 5. Function access. Expect anon_exec = false everywhere; auth_exec = true ONLY for
--    bingo_host_state, bingo_review_submission, bingo_save_board, bingo_start, bingo_transition, bingo_update_settings, create_bingosnap_game.
--    (bingo_room_info and bingo_player_state: service role only.)
--    svc_exec is true for all (the service role is trusted; Supabase's default grants).
select p.proname,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
       has_function_privilege('service_role', p.oid, 'EXECUTE') as svc_exec
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace and (p.proname like 'bingo_%' or p.proname = 'create_bingosnap_game')
   and p.prorettype <> 'trigger'::regtype
 order by 1;

-- 6. Guards installed. Expect 6 rows: guard_bingosnap_board_complete, guard_bingosnap_game_state and guard_game_type_immutable on games,
--    guard_bring_me_only on game_rounds, submission_intents and submissions.
select tgrelid::regclass as on_table, tgname from pg_trigger
 where tgname in ('guard_bingosnap_board_complete', 'guard_bingosnap_game_state', 'guard_game_type_immutable', 'guard_bring_me_only') and not tgisinternal
 order by 1, 2;

-- 7. No photo-shaped column in BingoSnap tables. Expect: 0 rows.
select table_name, column_name from information_schema.columns
 where table_schema = 'public' and table_name like 'bingo_%'
   and column_name ~* '(photo|image|img|url|path|blob|thumb|exif|base64|bytes|storage|file|hash|mime)';

-- 8. Board drafts (migration 19). Expect: board_revision column = true; no published or started
--    BingoSnap game with an incomplete board (0 rows).
select exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'bingo_games' and column_name = 'board_revision') as board_revision;
select g.id, g.status from public.games g
 where g.game_type = 'bingosnap' and g.status in ('lobby', 'live', 'finished')
   and exists (select 1 from public.bingo_cells c where c.game_id = g.id and not c.is_free and c.challenge is null);

-- 9. Lobby (migration 20). Expect 2 rows: bingo_room_info (auth false), bingo_start (auth true); anon false for both.
select p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('bingo_room_info', 'bingo_start') order by 1;

-- 10. Reliable claims (migration 21). Expect: request_id column = true, the unique index = true,
--     and 2 rows for bingo_submit_claim (2 and 3 arguments), anon false and auth false for both.
select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'bingo_submissions' and column_name = 'request_id') as request_id_column,
       to_regclass('public.bingo_submissions_request') is not null as request_index;
select p.oid::regprocedure::text as fn, has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'bingo_submit_claim' order by 1;
