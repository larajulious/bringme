-- Phase 11 — production readiness fixes.
--
-- Hosts could DELETE their own draft/finished/cancelled games (and pending
-- rounds) straight through the REST API. The app never does this, but it let a
-- Game Master bypass the per-period game cap (the cap counts existing game
-- rows), orphaned submission photos in Storage (rows cascade, objects don't),
-- erased history from the admin metrics, and could empty a lobby's rounds.
-- Games end through game_transition (cancel / end_game / archive) instead.
-- Super admins and the service role are unaffected.

drop policy if exists games_delete_own on public.games;
drop policy if exists rounds_delete_own on public.game_rounds;
revoke delete on public.games, public.game_rounds from authenticated;
