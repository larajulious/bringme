/** Timing helpers shared by the browser and the server handlers (pure, unit-tested). */

/** Results closer than this are "too close to call" by the clock alone (see TIMING.md). */
export const NEAR_TIE_MS = 150;
/** A capture must be uploaded within this window after the tap (mirrors the SQL functions). */
export const UPLOAD_WINDOW_MS = 45_000;

/** Elapsed milliseconds as SS.mmm (or M:SS.mmm past a minute). */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms)) return "--.---";
  const total = Math.round(ms);
  const sign = total < 0 ? "-" : "";
  const abs = Math.abs(total);
  const millis = abs % 1000;
  const seconds = Math.floor(abs / 1000);
  const mmm = String(millis).padStart(3, "0");
  if (seconds < 60) return `${sign}${String(seconds).padStart(2, "0")}.${mmm}`;
  return `${sign}${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}.${mmm}`;
}

const NUMERIC_KEYS = [
  "syncRttMs", "syncAgeMs", "syncUncertaintyMs", "tapWallMs", "frameWidth", "frameHeight",
  "bytes", "uploadMs", "compressMs", "uploadAttempts", "width", "height", "backgroundedMs",
] as const;
const ENUM_KEYS: Record<string, readonly string[]> = {
  camera: ["environment", "user", "unknown"],
  visibility: ["visible", "hidden"],
  source: ["live"],
  contentType: ["image/jpeg"],
};

/**
 * Whitelist + clamp client-supplied timing metadata. Unknown keys are dropped,
 * numbers must be finite, strings must be one of a few known values, and the
 * result is size-capped. Whatever survives is still just a CLAIM (see TIMING.md).
 */
export function sanitizeClientMeta(input: unknown): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  const src = input as Record<string, unknown>;
  for (const k of NUMERIC_KEYS) {
    const v = src[k];
    if (typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1e13) out[k] = Math.round(v * 1000) / 1000;
  }
  for (const [k, allowed] of Object.entries(ENUM_KEYS)) {
    const v = src[k];
    if (typeof v === "string" && allowed.includes(v)) out[k] = v;
  }
  return JSON.stringify(out).length <= 1024 ? out : {};
}

/** Elapsed ms must be a plain integer in a sane range (the database re-checks). */
export function parseElapsedMs(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= -60_000 && v <= 7_200_000 ? v : null;
}
