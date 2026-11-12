import type { NextRequest } from "next/server";

import { HttpError, handle, isUuid, json } from "@/lib/api/http";
import { requireUser } from "@/lib/auth/guards";
import type { HostSnapshot } from "@/lib/game/types";
import { SUBMISSION_BUCKET } from "@/lib/players/submission";

/**
 * Live, ranked submissions of the CURRENT round with review status and
 * short-lived signed photo URLs. Runs as the signed-in host: host_game_state()
 * checks ownership, round_ranking() is SECURITY INVOKER (RLS) and the storage
 * policy only allows the owner's game folders. Photos stay private.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) throw new HttpError(400, "invalid_game");

    const { data: state, error: stateErr } = await supabase.rpc("host_game_state", { p_game: id });
    if (stateErr || !state) throw new HttpError(404, "game_not_found");
    const roundId = (state as unknown as HostSnapshot).round?.id;
    if (!roundId) return json({ submissions: [] });

    const { data: rows, error } = await supabase.rpc("round_ranking", { p_round: roundId });
    if (error) throw new HttpError(500, "ranking_failed");

    const { data: signed } = await supabase.storage.from(SUBMISSION_BUCKET).createSignedUrls((rows ?? []).map((r) => r.storage_path), 120);
    const urlByPath = new Map((signed ?? []).map((s) => [s.path, s.signedUrl]));
    return json({
      submissions: (rows ?? []).map((r) => ({
        submissionId: r.submission_id, rank: r.rank, playerId: r.player_id, nickname: r.nickname, status: r.status,
        rankMs: r.rank_ms, claimedMs: r.claimed_elapsed_ms, serverMs: r.server_elapsed_ms, timing: r.timing_status,
        flags: r.timing_flags, nearTie: r.near_tie, isLeader: r.is_leader, photoUrl: urlByPath.get(r.storage_path) ?? null,
      })),
    });
  });
}
