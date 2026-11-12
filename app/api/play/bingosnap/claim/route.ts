import type { NextRequest } from "next/server";

import { HttpError, handle, json, readJson } from "@/lib/api/http";
import { submitBingoClaim } from "@/lib/bingosnap/server";
import { parseClaimInput } from "@/lib/bingosnap/validation";
import { requireTokenHash } from "@/lib/players/session";

/**
 * Claim Bingo / Full Card. The body is exactly `{ cellIds, requestId? }` (unknown keys are
 * refused, and readJson caps bodies at 8 KB): photos never leave the device. `requestId` makes
 * retries idempotent: a repeat returns the existing claim instead of a second one or an error.
 * The participant comes from the HttpOnly session cookie only. The pattern,
 * the deadline (database clock, judged on arrival) and the one-open-claim rule are checked in SQL.
 */
export async function POST(request: NextRequest) {
  return handle(async () => {
    const tokenHash = requireTokenHash(request);
    const parsed = parseClaimInput(await readJson(request));
    if (!parsed.ok) throw new HttpError(400, parsed.error);
    return json({ state: await submitBingoClaim(tokenHash, parsed.value.cellIds, parsed.value.requestId) }, 201);
  });
}
