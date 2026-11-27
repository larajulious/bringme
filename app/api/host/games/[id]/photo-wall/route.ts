import type { NextRequest } from "next/server";

import { HttpError, handle, isUuid, json, readJson } from "@/lib/api/http";
import { requireUser } from "@/lib/auth/guards";
import { toHttpError } from "@/lib/host/errors";

/**
 * Per-round toggle for showing players' non-rejected photos on the presentation & TV screens
 * (during review before announcing the winner, or after the winner is announced).
 * Ownership and valid phase are enforced inside set_round_photo_wall().
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) throw new HttpError(400, "invalid_game");

    const body = await readJson(request);
    if (typeof body.show !== "boolean") throw new HttpError(400, "invalid_show");

    const { data, error } = await supabase.rpc("set_round_photo_wall", {
      p_game: id,
      p_show: body.show,
    });
    if (error) throw toHttpError(error.message, error.code);
    return json({ state: data });
  });
}
