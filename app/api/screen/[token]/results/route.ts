import type { NextRequest } from "next/server";

import { HttpError, handle, json } from "@/lib/api/http";
import { SUBMISSION_BUCKET } from "@/lib/players/submission";
import { resolveScreen } from "@/lib/screen/server";
import { createAdminClient } from "@/lib/supabase/admin";

/** Final screen for a TV link: each round's official winning photo (2-minute URLs), once the game has finished. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  return handle(async () => {
    const screen = await resolveScreen((await params).token);
    if (!screen || screen.gameType !== "bring_me") throw new HttpError(404, "screen_not_found");
    if (screen.status !== "finished") return json({ rounds: [] });
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("game_results", { p_game: screen.gameId });
    if (error) throw new HttpError(500, "results_failed");
    const prefix = `${screen.gameId}/`;
    const paths = (data ?? []).map((r) => r.winner_path).filter((p): p is string => typeof p === "string" && p.startsWith(prefix));
    const { data: signed } = paths.length ? await admin.storage.from(SUBMISSION_BUCKET).createSignedUrls(paths, 120) : { data: [] };
    const url = new Map((signed ?? []).map((s) => [s.path, s.signedUrl]));
    return json({ rounds: (data ?? []).map((r) => ({ no: r.round_no, photoUrl: r.winner_path ? url.get(r.winner_path) ?? null : null })) });
  });
}
