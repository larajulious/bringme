import type { NextRequest } from "next/server";

import { HttpError, handle, isUuid, json } from "@/lib/api/http";
import { requireUser } from "@/lib/auth/guards";
import { SUBMISSION_BUCKET } from "@/lib/players/submission";

/** Round-by-round results with the winners' photos (2-minute signed URLs, owner only). */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) throw new HttpError(400, "invalid_game");
    const { data, error } = await supabase.rpc("game_results", { p_game: id });
    if (error) throw new HttpError(500, "results_failed");
    const paths = (data ?? []).map((r) => r.winner_path).filter((p): p is string => Boolean(p));
    const { data: signed } = paths.length ? await supabase.storage.from(SUBMISSION_BUCKET).createSignedUrls(paths, 120) : { data: [] };
    const url = new Map((signed ?? []).map((s) => [s.path, s.signedUrl]));
    return json({
      rounds: (data ?? []).map((r) => ({
        no: r.round_no, prompt: r.prompt, winnerName: r.winner_name, winnerMs: r.winner_ms,
        submissions: r.submissions, photoUrl: r.winner_path ? url.get(r.winner_path) ?? null : null,
      })),
    });
  });
}
