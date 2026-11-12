import type { NextRequest } from "next/server";

import { HttpError, handle, json, readJson } from "@/lib/api/http";
import { requireActiveSubscription } from "@/lib/auth/guards";
import { toBingoHttpError } from "@/lib/bingosnap/errors";
import { parseBoardInput } from "@/lib/bingosnap/validation";

/**
 * Create a BingoSnap board: saved as a draft, or published straight to the
 * lobby (`publish: true`). Needs an active Game Pass; the database re-checks
 * it, plus the plan's open-game / per-period limits and the room's player cap,
 * on the games insert (the same triggers as Bring Me).
 */
export async function POST(request: NextRequest) {
  return handle(async () => {
    const { supabase } = await requireActiveSubscription();
    const parsed = parseBoardInput(await readJson(request), { existing: false });
    if (!parsed.ok) throw new HttpError(400, parsed.error);
    const v = parsed.value;

    const { data, error } = await supabase.rpc("bingo_save_board", {
      p_game: null, p_expected_revision: 0, p_title: v.title, p_board_size: v.boardSize, p_win_mode: v.winMode,
      p_free_space: v.freeSpace, p_duration_seconds: v.durationSeconds, p_winner_rule: v.winnerRule, p_cells: v.cells, p_publish: v.publish,
    });
    if (error || !data) throw toBingoHttpError(error?.message ?? "");
    const state = data as { gameId: string; joinCode: string };
    return json({ id: state.gameId, code: state.joinCode, state }, 201);
  });
}
