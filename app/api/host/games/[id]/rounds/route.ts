import type { NextRequest } from "next/server";

import { HttpError, handle, isUuid, json, readJson } from "@/lib/api/http";
import { requireUser } from "@/lib/auth/guards";
import { toHttpError } from "@/lib/host/errors";
import { ITEM_MAX_LENGTH } from "@/lib/host/validation";

/**
 * Add one round to a game that is still open (lobby or live). Ownership, the game state and the plan's round limit
 * are enforced in PostgreSQL (add_game_round + the round-insert trigger); this only checks the request's shape.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) throw new HttpError(400, "invalid_game");

    const body = await readJson(request);
    const prompt = typeof body.prompt === "string" ? body.prompt.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "";
    if (prompt.length < 1) throw new HttpError(400, "empty_item");
    if (prompt.length > ITEM_MAX_LENGTH) throw new HttpError(400, "invalid_item");

    const { data, error } = await supabase.rpc("add_game_round", { p_game: id, p_prompt: prompt });
    if (error) throw toHttpError(error.message);
    return json({ state: data });
  });
}
