import type { NextRequest } from "next/server";

import { HttpError, handle, isUuid, json } from "@/lib/api/http";
import { requireUser } from "@/lib/auth/guards";
import { listSubmissionPhotos, parseHave, type RankingRow } from "@/lib/game/submission-photos";
import { SUBMISSION_BUCKET } from "@/lib/players/submission";

/**
 * Ranked submissions of the CURRENT round, with short-lived signed photo URLs, for the game's owner.
 *  ?view=presenter  names only, plus the official winner's photo during the announcement
 *  ?have=<ids>      submissions whose photo URL the caller still holds: not signed again (Phase 3)
 * Runs as the signed-in host: the game is looked up owner-scoped (another host's id is just "not found"),
 * round_ranking() is SECURITY INVOKER (RLS), and URLs are signed under the host's own session, so the
 * Storage policy re-checks ownership of every object. Paths never come from the request. Photos stay private;
 * URLs are bearer credentials and are never logged.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { supabase, userId } = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) throw new HttpError(400, "invalid_game");
    const search = request.nextUrl.searchParams;

    const listing = await listSubmissionPhotos({
      game: async () => {
        const { data, error } = await supabase.from("games").select("current_round_id, phase").eq("id", id).eq("owner_id", userId).maybeSingle();
        if (error) throw new HttpError(500, "game_lookup_failed");
        return data ? { currentRoundId: data.current_round_id, phase: data.phase } : null;
      },
      ranking: async (roundId) => {
        const { data, error } = await supabase.rpc("round_ranking", { p_round: roundId });
        if (error) throw new HttpError(500, "ranking_failed");
        return (data ?? []) as RankingRow[];
      },
      officialWinner: async (roundId) => {
        const { data } = await supabase.from("game_rounds").select("winner_player_id, winner_confirmed_at").eq("id", roundId).maybeSingle();
        return data?.winner_confirmed_at ? data.winner_player_id : null;
      },
      sign: async (paths, ttlSeconds) => {
        const { data, error } = await supabase.storage.from(SUBMISSION_BUCKET).createSignedUrls(paths, ttlSeconds);
        if (error) {
          // The list still loads; the client retries the missing photos. Never log URLs or paths.
          console.warn("[photos] signing failed", JSON.stringify({ count: paths.length, status: (error as { status?: number }).status ?? null }));
          return new Map();
        }
        return new Map((data ?? []).filter((s) => s.signedUrl && !s.error && s.path).map((s) => [s.path as string, s.signedUrl]));
      },
    }, { gameId: id, view: search.get("view") === "presenter" ? "presenter" : "host", have: parseHave(search.get("have")) });

    if (!listing) throw new HttpError(404, "game_not_found");
    return json({ submissions: listing.submissions, ttlSeconds: listing.ttlSeconds });
  });
}
