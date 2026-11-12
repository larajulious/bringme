import type { NextRequest } from "next/server";

import { HttpError, handle, isUuid, json, readJson } from "@/lib/api/http";
import { requireUser } from "@/lib/auth/guards";
import { toBingoHttpError } from "@/lib/bingosnap/errors";
import { parseStartInput } from "@/lib/bingosnap/validation";

/**
 * Start a BingoSnap game: closes the lobby, runs the 3 s countdown and opens the hunt at its end,
 * in one transaction (bingo_start). Ownership, at least one player, the CURRENT Game Pass
 * covering everyone in the room, and the expected version are all checked in SQL.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) throw new HttpError(400, "invalid_game");
    const parsed = parseStartInput(await readJson(request));
    if (!parsed.ok) throw new HttpError(400, parsed.error);

    const { data, error } = await supabase.rpc("bingo_start", { p_game: id, p_expected_version: parsed.value.expectedVersion });
    if (error) throw toBingoHttpError(error.message);
    return json({ state: data });
  });
}
