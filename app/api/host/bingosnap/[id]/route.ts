import type { NextRequest } from "next/server";

import { HttpError, handle, isUuid, json } from "@/lib/api/http";
import { requireUser } from "@/lib/auth/guards";
import { toBingoHttpError } from "@/lib/bingosnap/errors";

/**
 * Authoritative BingoSnap snapshot for the owning host. `?view=presenter`
 * returns the audience-safe variant (no rejection reasons, no claimed
 * challenges, challenges hidden until the hunt starts). Ownership is checked in SQL.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) throw new HttpError(400, "invalid_game");
    const view = request.nextUrl.searchParams.get("view") === "presenter" ? "presenter" : "host";

    const { data, error } = await supabase.rpc("bingo_host_state", { p_game: id, p_view: view });
    if (error) throw toBingoHttpError(error.message);
    return json(data);
  });
}
