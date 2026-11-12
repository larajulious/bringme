import type { NextRequest } from "next/server";

import { HttpError, handle, isUuid, json, readJson } from "@/lib/api/http";
import { requireUser } from "@/lib/auth/guards";
import { toHttpError } from "@/lib/host/errors";

/**
 * Replay the current round after photos were stopped too early (before its winner is announced).
 * Ownership, the allowed state and the optimistic version check live in replay_round() (PostgreSQL);
 * this only checks the request's shape.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) throw new HttpError(400, "invalid_game");

    const body = await readJson(request);
    if (!Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number) < 0) {
      throw new HttpError(400, "invalid_version");
    }
    const { data, error } = await supabase.rpc("replay_round", { p_game: id, p_expected_version: body.expectedVersion as number });
    if (error) throw toHttpError(error.message);
    return json({ state: data });
  });
}
