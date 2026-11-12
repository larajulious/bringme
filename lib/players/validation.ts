/**
 * Player display names (pure, unit-tested). A name is a label shown to other
 * players; it is NEVER an identifier or credential (identity = session token).
 */
import type { Parsed } from "@/lib/admin/validation";

export const NAME_MAX = 24;

export function parsePlayerName(raw: unknown): Parsed<string> {
  if (typeof raw !== "string") return { ok: false, error: "invalid_nickname" };
  const name = raw
    .normalize("NFC")
    // control chars and invisible/format chars (zero-width, bidi overrides, BOM)
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    // unusual whitespace (incl. NBSP, line separators) -> single space
    .replace(/[\p{Z}\s]+/gu, " ")
    .trim();
  const length = Array.from(name).length; // code points, same as Postgres char_length
  if (length < 1 || length > NAME_MAX) return { ok: false, error: "invalid_nickname" };
  // must contain something readable: a letter, number or emoji
  if (!/[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(name)) return { ok: false, error: "invalid_nickname" };
  return { ok: true, value: name };
}
