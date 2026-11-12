import type { NextRequest } from "next/server";

import { HttpError, handle, json, readJson } from "@/lib/api/http";
import { requireRole } from "@/lib/auth/guards";

/**
 * Start the one-time free trial for the signed-in Game Master, if eligible.
 * The body is ignored (send `{}`): plan, start and end are decided by the database.
 * Requiring a JSON body keeps the same CSRF protection as the other handlers.
 * Idempotent: calling it again never restarts or extends a trial.
 */
export async function POST(request: NextRequest) {
  return handle(async () => {
    const { supabase } = await requireRole("subscriber");
    await readJson(request);
    const { data, error } = await supabase.rpc("ensure_my_trial");
    if (error || !data?.[0]) throw new HttpError(500, "trial_failed");
    const { granted, reason } = data[0];
    if (!granted && reason !== "trial_already_used") throw new HttpError(409, reason ?? "trial_unavailable");
    return json({ granted, reason }, granted ? 201 : 200);
  });
}
