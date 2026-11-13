import type { NextRequest } from "next/server";

import { HttpError, handle, isUuid, json, readJson } from "@/lib/api/http";
import { requireUser } from "@/lib/auth/guards";
import { toHttpError } from "@/lib/host/errors";
import { screenPath } from "@/lib/screen/token";
import { getSiteUrl } from "@/lib/site/url";

/**
 * The game's TV link (any game type). { reset: true } replaces it, cutting off every TV holding the old one.
 * Ownership and the "not a draft" rule live in screen_link() (PostgreSQL).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) throw new HttpError(400, "invalid_game");
    const body = await readJson(request);
    const { data, error } = await supabase.rpc("screen_link", { p_game: id, p_reset: body.reset === true });
    if (error) {
      if (/game_not_found/.test(error.message)) throw new HttpError(404, "game_not_found");
      if (/game_not_open/.test(error.message)) throw new HttpError(409, "game_not_open");
      throw toHttpError(error.message, error.code);
    }
    const path = screenPath(data as string);
    return json({ url: `${getSiteUrl().url}${path}`, path });
  });
}
