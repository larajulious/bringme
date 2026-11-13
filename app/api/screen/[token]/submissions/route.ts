import type { NextRequest } from "next/server";

import { HttpError, handle, json } from "@/lib/api/http";
import { listSubmissionPhotos, parseHave, type RankingRow } from "@/lib/game/submission-photos";
import { SUBMISSION_BUCKET } from "@/lib/players/submission";
import { resolveScreen } from "@/lib/screen/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Current round for a TV link: the same presenter listing as the signed-in presenter screen (names only, plus the
 * OFFICIAL winner's photo during the announcement), minus timing details. Every query is scoped to the game the
 * token resolved to; paths come only from the database and must lie inside that game's folder.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  return handle(async () => {
    const screen = await resolveScreen((await params).token);
    if (!screen || screen.gameType !== "bring_me") throw new HttpError(404, "screen_not_found");
    const admin = createAdminClient();

    const listing = await listSubmissionPhotos({
      game: async () => {
        const { data, error } = await admin.from("games").select("current_round_id, phase").eq("id", screen.gameId).maybeSingle();
        if (error) throw new HttpError(500, "game_lookup_failed");
        return data ? { currentRoundId: data.current_round_id, phase: data.phase } : null;
      },
      ranking: async (roundId) => {
        const { data, error } = await admin.rpc("round_ranking", { p_round: roundId });
        if (error) throw new HttpError(500, "ranking_failed");
        return ((data ?? []) as RankingRow[]);
      },
      officialWinner: async (roundId) => {
        const { data } = await admin.from("game_rounds").select("winner_player_id, winner_confirmed_at").eq("id", roundId).eq("game_id", screen.gameId).maybeSingle();
        return data?.winner_confirmed_at ? data.winner_player_id : null;
      },
      sign: async (paths, ttlSeconds) => {
        const { data, error } = await admin.storage.from(SUBMISSION_BUCKET).createSignedUrls(paths, ttlSeconds);
        if (error) return new Map(); // the list still loads; the screen retries. Never log URLs or paths.
        return new Map((data ?? []).filter((s) => s.signedUrl && !s.error && s.path).map((s) => [s.path as string, s.signedUrl]));
      },
    }, { gameId: screen.gameId, view: "presenter", have: parseHave(request.nextUrl.searchParams.get("have")) });

    if (!listing) throw new HttpError(404, "screen_not_found");
    return json({
      ttlSeconds: listing.ttlSeconds,
      submissions: listing.submissions.map((s) => ({
        submissionId: s.submissionId, rank: s.rank, playerId: s.playerId, nickname: s.nickname, photoKey: s.photoKey, photoUrl: s.photoUrl,
      })),
    });
  });
}
