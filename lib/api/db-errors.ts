/**
 * Database errors that mean "nothing was committed, the same request may simply be sent again"
 * (pure, no imports, unit-tested). Every write path that can hit one is idempotent (submissions by
 * attempt id, BingoSnap claims by request id, host actions by expected version).
 *  - 40P01 deadlock_detected, 40001 serialization_failure, 55P03 lock_not_available
 *  - 57014 query_canceled (statement timeout)
 *  - PGRST003 PostgREST timed out waiting for a pooled connection
 */
const TRANSIENT_DB_CODES = new Set(["40P01", "40001", "55P03", "57014", "PGRST003"]);

/** Stable API error code for a transient database failure (answered with HTTP 503). */
export const DB_BUSY = "db_busy";

export function isTransientDbError(code: unknown): code is string {
  return typeof code === "string" && TRANSIENT_DB_CODES.has(code);
}
