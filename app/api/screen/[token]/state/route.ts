import type { NextRequest } from "next/server";

import { HttpError, handle, json } from "@/lib/api/http";
import { getScreenState } from "@/lib/screen/server";

/** TV link snapshot (public; the token is the credential). 404 = unknown or reset link. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  return handle(async () => {
    const state = await getScreenState((await params).token);
    if (!state) throw new HttpError(404, "screen_not_found");
    return json(state);
  });
}
