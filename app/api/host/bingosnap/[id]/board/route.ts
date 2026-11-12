import type { NextRequest } from "next/server";

import { HttpError, handle, isUuid, json, readJson } from "@/lib/api/http";
import { requireUser } from "@/lib/auth/guards";
import { toBingoHttpError } from "@/lib/bingosnap/errors";
import { parseBoardInput } from "@/lib/bingosnap/validation";

/**
 * Save the board (draft or lobby) and optionally publish it. Ownership, the
 * "editable until the game starts" rule, the board revision (another tab's save
 * is never overwritten), the complete-board rule for publishing and the Game Pass
 * check on publish are all enforced in bingo_save_board(). Saving a draft does
 * not need an active pass, so hosts never lose work when a pass ends.
 */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) throw new HttpError(400, "invalid_game");
    const parsed = parseBoardInput(await readJson(request), { existing: true });
    if (!parsed.ok) throw new HttpError(400, parsed.error);
    const v = parsed.value;

    const { data, error } = await supabase.rpc("bingo_save_board", {
      p_game: id, p_expected_revision: v.expectedRevision ?? -1, p_title: v.title, p_board_size: v.boardSize, p_win_mode: v.winMode,
      p_free_space: v.freeSpace, p_duration_seconds: v.durationSeconds, p_winner_rule: v.winnerRule, p_cells: v.cells, p_publish: v.publish,
    });
    if (error) throw toBingoHttpError(error.message);
    return json({ state: data });
  });
}
