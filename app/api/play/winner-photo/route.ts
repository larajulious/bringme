import type { NextRequest } from "next/server";

import { HttpError, handle, json } from "@/lib/api/http";
import { requireTokenHash } from "@/lib/players/session";
import { SharedSignedUrlCache, resolveWinnerPhoto } from "@/lib/players/shared-url-cache";
import { SUBMISSION_BUCKET } from "@/lib/players/submission";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * One signed URL per winner photo per server instance, reused while ≥ 60 s of its 2 minutes remain (Phase 3).
 * Only ever consulted AFTER the database authorized this request for exactly that object (see below), so a
 * cached URL reaches only players the database already allowed to see it. Concurrent requests share one signing.
 */
const winnerUrls = new SharedSignedUrlCache({ ttlSeconds: 120, minRemainingMs: 60_000, maxEntries: 256 });

/**
 * The winner's photo for the announcement screen. The database only returns a
 * path while THIS player's game is showing the winner announcement for its
 * current round (and the player was not removed), so no other photo and no other
 * moment is ever reachable. The URL is short-lived; the bucket stays private.
 */
export async function GET(request: NextRequest) {
  return handle(async () => {
    const tokenHash = requireTokenHash(request);
    const admin = createAdminClient();
    const url = await resolveWinnerPhoto(
      async () => {
        const { data: path, error } = await admin.rpc("player_winner_photo", { p_token_hash: tokenHash });
        if (error) throw new HttpError(500, "photo_lookup_failed");
        return path ?? null;
      },
      winnerUrls,
      async (path, ttlSeconds) => (await admin.storage.from(SUBMISSION_BUCKET).createSignedUrl(path, ttlSeconds)).data?.signedUrl ?? null,
      SUBMISSION_BUCKET,
    );
    return json({ url });
  });
}
