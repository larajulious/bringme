import type { NextRequest } from "next/server";

import { HttpError, handle, json } from "@/lib/api/http";
import { requireTokenHash } from "@/lib/players/session";
import { SUBMISSION_BUCKET } from "@/lib/players/submission";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * The winner's photo for the announcement screen. The database only returns a
 * path while THIS player's game is showing the winner announcement for its
 * current round, so no other photo and no other moment is ever reachable.
 * The URL is signed for 2 minutes; the bucket stays private.
 */
export async function GET(request: NextRequest) {
  return handle(async () => {
    const tokenHash = requireTokenHash(request);
    const admin = createAdminClient();
    const { data: path, error } = await admin.rpc("player_winner_photo", { p_token_hash: tokenHash });
    if (error) throw new HttpError(500, "photo_lookup_failed");
    if (!path) return json({ url: null });
    const { data } = await admin.storage.from(SUBMISSION_BUCKET).createSignedUrl(path, 120);
    return json({ url: data?.signedUrl ?? null });
  });
}
