/** Server-side validation for game creation (pure, unit-tested). */
import type { Parsed } from "@/lib/admin/validation";

export const ITEM_MAX_LENGTH = 200;
export const TITLE_MAX_LENGTH = 80;
export const HARD_MAX_ROUNDS = 200;

export type GameInput = { title: string; items: string[] };

/** `maxRounds` comes from the caller's plan (never from the request). */
export function parseGameInput(body: Record<string, unknown>, maxRounds: number): Parsed<GameInput> {
  const limit = Math.min(maxRounds, HARD_MAX_ROUNDS);

  let title = "";
  if (body.title !== undefined && body.title !== null) {
    if (typeof body.title !== "string") return { ok: false, error: "invalid_title" };
    title = body.title.trim();
    if (title.length > TITLE_MAX_LENGTH) return { ok: false, error: "invalid_title" };
  }

  if (!Array.isArray(body.items) || body.items.length < 1) return { ok: false, error: "items_required" };
  if (body.items.length > limit) return { ok: false, error: "too_many_items" };
  const items: string[] = [];
  for (const raw of body.items) {
    if (typeof raw !== "string") return { ok: false, error: "invalid_item" };
    const item = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    if (item.length < 1) return { ok: false, error: "empty_item" };
    if (item.length > ITEM_MAX_LENGTH) return { ok: false, error: "invalid_item" };
    items.push(item);
  }
  return { ok: true, value: { title, items } };
}
