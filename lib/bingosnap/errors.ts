import { HttpError } from "@/lib/api/http";
import { toHttpError } from "@/lib/host/errors";
import { bingoErrorCode } from "./error-codes";

/** BingoSnap errors first; anything else falls back to the shared host mapping (pass, stale state, transitions…). */
export function toBingoHttpError(message: string, code?: string | null): HttpError {
  const hit = bingoErrorCode(message);
  return hit ? new HttpError(hit[0], hit[1]) : toHttpError(message, code);
}
