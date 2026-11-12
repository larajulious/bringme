import type { NextRequest } from "next/server";

import { HttpError, handle, isUuid, json, readJson } from "@/lib/api/http";
import { requireUser } from "@/lib/auth/guards";
import { toBingoHttpError } from "@/lib/bingosnap/errors";
import { parseSettingsInput } from "@/lib/bingosnap/validation";

/** Switch Ranked / First wins until the hunt starts (owner + version checked in SQL). */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) throw new HttpError(400, "invalid_game");
    const parsed = parseSettingsInput(await readJson(request));
    if (!parsed.ok) throw new HttpError(400, parsed.error);

    const { data, error } = await supabase.rpc("bingo_update_settings", {
      p_game: id,
      p_expected_version: parsed.value.expectedVersion,
      p_winner_rule: parsed.value.winnerRule,
    });
    if (error) throw toBingoHttpError(error.message);
    return json({ state: data });
  });
}
