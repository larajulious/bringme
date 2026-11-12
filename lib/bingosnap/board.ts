/**
 * Pure logic for the BingoSnap card editor (unit-tested). A board is one string
 * per position, row-major (length size²); "" is an empty square; the free centre
 * (odd boards, Traditional only) is always "". The server re-validates everything
 * (lib/bingosnap/validation.ts + bingo_save_board in SQL).
 */
import { CHALLENGE_MAX_LENGTH, MAX_DURATION_SECONDS, MIN_DURATION_SECONDS, freeSpaceAllowed, type BingoHostSnapshot, type BingoPlayerSubmission, type BoardSize, type WinMode } from "./types.ts";

export const DURATION_PRESETS_MIN = [5, 10, 15, 20, 30, 45, 60] as const;
export const MIN_DURATION_MIN = MIN_DURATION_SECONDS / 60;
export const MAX_DURATION_MIN = MAX_DURATION_SECONDS / 60;

/** Everyday, findable-anywhere photo instructions (placeholders and "Fill with ideas"). */
export const CHALLENGE_IDEAS = [
  "Take a photo of red shoes", "Capture someone wearing a watch", "Find a green plant", "Photograph a water bottle",
  "Capture something circular", "Find an object with the color blue", "Photograph a pair of glasses",
  "Capture a handwritten note", "Find something made of wood", "Photograph a set of keys", "Capture a smile from a stranger",
  "Find something with stripes", "Photograph a clock", "Capture a book with a yellow cover", "Find a heart shape",
  "Photograph a pair of sunglasses", "Capture something soft", "Find a coin", "Photograph a coffee mug",
  "Capture a group high-five", "Find something older than you", "Photograph a star shape", "Capture something that glows",
  "Find a piece of fruit", "Photograph a pet (or a photo of one)", "Capture your best silly face",
] as const;

export const normalise = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();

export type BoardShape = { size: BoardSize; free: boolean };

/** Free centre only on odd boards in Traditional mode. */
export const effectiveFree = (wanted: boolean, size: BoardSize, mode: WinMode) => wanted && freeSpaceAllowed(size, mode);
export const centreIndex = (size: number, free: boolean): number | null => (free && size % 2 === 1 ? (size * size - 1) / 2 : null);
export const emptyCells = (size: number): string[] => Array<string>(size * size).fill("");
export const editablePositions = ({ size, free }: BoardShape): number[] => {
  const c = centreIndex(size, free);
  return Array.from({ length: size * size }, (_, i) => i).filter((i) => i !== c);
};

/**
 * Changing the board size or the free centre, keeping what the host typed.
 *  - same size: turning the free centre ON moves the centre's instruction to the first empty
 *    square (or drops it if the board is full); turning it OFF leaves an empty centre.
 *  - new size: instructions are re-laid in reading order (empty squares between them are kept
 *    when they fit, then squeezed out); whatever still doesn't fit is dropped.
 * `dropped` lists removed instructions so the UI can warn before applying.
 */
export function reshapeBoard(cells: string[], from: BoardShape, to: BoardShape): { cells: string[]; dropped: string[] } {
  if (from.size === to.size) {
    const out = [...cells];
    const c = centreIndex(to.size, to.free);
    const dropped: string[] = [];
    if (c !== null && normalise(out[c] ?? "")) {
      const text = out[c];
      out[c] = "";
      const slot = editablePositions(to).find((p) => !normalise(out[p]));
      if (slot === undefined) dropped.push(normalise(text));
      else out[slot] = text;
    }
    return { cells: out, dropped };
  }
  // reading order of the old board's editable squares, trailing empties removed
  let list = editablePositions(from).map((p) => cells[p] ?? "");
  while (list.length && !normalise(list[list.length - 1])) list.pop();
  const slots = editablePositions(to);
  if (list.length > slots.length) list = list.filter((t) => normalise(t)); // squeeze out holes
  const dropped = list.slice(slots.length).map(normalise).filter(Boolean);
  const out = emptyCells(to.size);
  slots.forEach((p, i) => { out[p] = list[i] ?? ""; });
  return { cells: out, dropped };
}

/** Arrow-key / Home / End movement across ALL squares (the free centre is focusable, just not editable). */
export function moveInGrid(pos: number, size: number, key: string): number {
  const r = Math.floor(pos / size), c = pos % size;
  switch (key) {
    case "ArrowRight": return c < size - 1 ? pos + 1 : pos;
    case "ArrowLeft": return c > 0 ? pos - 1 : pos;
    case "ArrowDown": return r < size - 1 ? pos + size : pos;
    case "ArrowUp": return r > 0 ? pos - size : pos;
    case "Home": return r * size;
    case "End": return r * size + size - 1;
    default: return pos;
  }
}

/** Next / previous EDITABLE square in reading order (null at the ends). */
export function stepEditable(pos: number, shape: BoardShape, dir: 1 | -1): number | null {
  const list = editablePositions(shape);
  const i = list.indexOf(pos);
  let j = i + dir;
  if (i === -1) { // from the free centre: the nearest editable square in that direction
    j = dir === 1 ? list.findIndex((p) => p > pos) : -1;
    if (dir === -1) for (let k = list.length - 1; k >= 0; k--) if (list[k] < pos) { j = k; break; }
  }
  return j >= 0 && j < list.length ? list[j] : null;
}

/** First empty editable square at or after `from` (wrapping), or null when the board is full. */
export function nextEmpty(cells: string[], shape: BoardShape, from = 0): number | null {
  const list = editablePositions(shape);
  const ordered = [...list.filter((p) => p >= from), ...list.filter((p) => p < from)];
  return ordered.find((p) => !normalise(cells[p] ?? "")) ?? null;
}

export type SquareProblem = "empty" | "too_long" | "duplicate";

/** Per-position problems for publishing (null = fine; the free centre is always null). */
export function boardProblems(cells: string[], shape: BoardShape): (SquareProblem | null)[] {
  const c = centreIndex(shape.size, shape.free);
  const seen = new Set<string>();
  return cells.map((raw, p) => {
    if (p === c) return null;
    const t = normalise(raw);
    if (!t) return "empty";
    if (t.length > CHALLENGE_MAX_LENGTH) return "too_long";
    const k = t.toLowerCase();
    if (seen.has(k)) return "duplicate";
    seen.add(k);
    return null;
  });
}

export const readyCount = (cells: string[], shape: BoardShape) =>
  editablePositions(shape).filter((p) => normalise(cells[p] ?? "") && normalise(cells[p]).length <= CHALLENGE_MAX_LENGTH).length;

/** Fills only empty squares, with ideas the board doesn't already use. */
export function fillWithIdeas(cells: string[], shape: BoardShape): string[] {
  const used = new Set(cells.map((c) => normalise(c).toLowerCase()).filter(Boolean));
  const pool = CHALLENGE_IDEAS.filter((i) => !used.has(i.toLowerCase()));
  let k = 0;
  const out = [...cells];
  for (const p of editablePositions(shape)) if (!normalise(out[p] ?? "")) out[p] = pool[k++] ?? "";
  return out;
}

/** A few unused ideas for the square being edited. */
export function suggestions(cells: string[], count = 3, seed = 0): string[] {
  const used = new Set(cells.map((c) => normalise(c).toLowerCase()).filter(Boolean));
  const pool = CHALLENGE_IDEAS.filter((i) => !used.has(i.toLowerCase()));
  if (!pool.length) return [];
  const start = seed % pool.length;
  return [...pool.slice(start), ...pool.slice(0, start)].slice(0, count);
}

/** Pasting several lines fills this square and the following editable ones. null = a normal single-line paste. */
export function pasteLines(cells: string[], pos: number, text: string, shape: BoardShape): string[] | null {
  const lines = text.split(/\r?\n|\t/).map(normalise).filter(Boolean);
  if (lines.length < 2) return null;
  const list = editablePositions(shape).filter((p) => p >= pos);
  const out = [...cells];
  list.forEach((p, i) => { if (i < lines.length) out[p] = lines[i].slice(0, CHALLENGE_MAX_LENGTH); });
  return out;
}

/** "B3"-style label: column letter + row number. */
export const shortLabel = (pos: number, size: number) => `${String.fromCharCode(65 + (pos % size))}${Math.floor(pos / size) + 1}`;
export const longLabel = (pos: number, size: number) => `Row ${Math.floor(pos / size) + 1}, column ${(pos % size) + 1}`;

export function clampMinutes(n: number): number {
  if (!Number.isFinite(n)) return MIN_DURATION_MIN;
  return Math.min(MAX_DURATION_MIN, Math.max(MIN_DURATION_MIN, Math.round(n)));
}
export function formatMinutes(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** Friendly copy for the API's error codes (BingoSnap + shared Game Pass ones). */
export const EDITOR_ERRORS: Record<string, string> = {
  subscription_required: "Purchase required: your Game Pass isn't active. You can keep editing and saving the draft; choose a 7-Day Game Pass to publish it.",
  game_limit_reached: "You've reached the number of games your Game Pass allows at once (drafts, Bring Me and BingoSnap games count together). Finish, cancel or discard one first.",
  period_game_limit_reached: "You've used all the games included in your current Game Pass.",
  board_incomplete: "Every square needs a photo instruction before the board can be published.",
  duplicate_challenge: "Each square needs a different instruction.",
  invalid_challenge: "One of the instructions is too long.",
  free_cell_not_editable: "The free centre can't hold a photo instruction.",
  free_space_not_allowed: "A free centre only works on 3×3 or 5×5 boards in Traditional Bingo.",
  invalid_board_dimensions: "The board didn't match its size. Reload the page and try again.",
  invalid_duration: `Pick a timer between ${MIN_DURATION_MIN} and ${MAX_DURATION_MIN} minutes.`,
  invalid_title: "That title is too long.",
  stale_board: "This board was changed in another tab or window. Reload to get the latest version, then make your change again.",
  board_locked: "The game has started, so the board can no longer change.",
  game_not_found: "This game no longer exists.",
  unauthenticated: "Your session has ended. Please sign in again.",
};

/** The editor's starting point from a host snapshot (draft or lobby): one entry per square, row-major. */
export function editorInitialFrom(s: BingoHostSnapshot & { status: "draft" | "lobby" }) {
  const b = s.board;
  return {
    gameId: s.gameId, status: s.status, version: s.version, revision: s.boardRevision ?? 0, joinCode: s.joinCode, title: s.title,
    winMode: b.winMode, winnerRule: b.winnerRule, size: b.size, freeSpace: b.freeSpace, durationSeconds: b.durationSeconds,
    cells: [...(s.cells ?? [])].sort((x, y) => x.order - y.order).map((c) => c.challenge ?? ""),
  };
}

// ------------------------------------------------------------- Phase 6: the player's card ----

/** Squares whose photo is evidence in a claim the host is checking or has verified: no retakes. */
export function lockedCellIds(submissions: Pick<BingoPlayerSubmission, "status" | "cellIds">[]): Set<string> {
  return new Set(submissions.filter((s) => s.status === "pending" || s.status === "verified").flatMap((s) => s.cellIds));
}

/** The win mode as shown to people. */
export const modeText = (mode: WinMode) =>
  mode === "traditional"
    ? { name: "Traditional Bingo", goal: "Snap a full row, column or diagonal" }
    : { name: "Full Card", goal: "Snap every square on the card" };
