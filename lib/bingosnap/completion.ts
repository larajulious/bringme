/**
 * BingoSnap completion engine (pure; no DOM, no storage, no UI).
 *
 * It answers ONE question: has the player supplied a photo for every square a winning pattern
 * needs? It never judges whether a photo shows the right thing: the Game Master checks that.
 *
 * Rules (identical to `bingo_pattern` in SQL, checked by tests/db/bingosnap-completion.test.ts):
 * - Traditional: any complete row, column, main diagonal (top-left → bottom-right) or anti
 *   diagonal (top-right → bottom-left). The free centre (odd sizes, when enabled) counts as done.
 * - Full card: every square except free ones.
 * - A claim sends exactly the photographed squares of ONE pattern (free squares are never sent).
 */
import type { Pattern, WinMode } from "./types.ts";

export type CardCell = { pos: number; cellId: string; isFree: boolean };
export type WinLine = { pattern: Pattern; positions: number[]; cellIds: string[] };

export type CardEvaluation = {
  mode: WinMode;
  size: number;
  /** Squares that need a photo (free squares excluded). */
  required: number;
  /** Of those, how many have one. */
  completed: number;
  /** 0–100, rounded down (100 only when every required square is done). */
  percent: number;
  /** Positions that count as done (photographed or free). */
  donePositions: Set<number>;
  /** Every complete row / column / diagonal, in a stable order (rows, columns, main, anti). */
  lines: WinLine[];
  full: boolean;
  /** Enough photos for the mode's winning pattern. */
  eligible: boolean;
  /** What a claim would send (null = nothing claimable). */
  claim: { pattern: Pattern; cellIds: string[] } | null;
  /** Positions to highlight as winning (the lines, or the whole card). */
  winningPositions: Set<number>;
  /** Fewest photos still needed for a win. */
  toGo: number;
};

/** All winning lines of an n×n board, as positions (row-major), in a stable order. */
export function boardLines(size: number): { pattern: Pattern; positions: number[] }[] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError("invalid_size");
  const idx = [...Array(size).keys()];
  return [
    ...idx.map((r) => ({ pattern: `row:${r}` as Pattern, positions: idx.map((c) => r * size + c) })),
    ...idx.map((c) => ({ pattern: `col:${c}` as Pattern, positions: idx.map((r) => r * size + c) })),
    { pattern: "diag:main" as Pattern, positions: idx.map((i) => i * size + i) },
    { pattern: "diag:anti" as Pattern, positions: idx.map((i) => i * size + (size - 1 - i)) },
  ];
}

function checkCard(size: number, cells: readonly CardCell[]) {
  if (![3, 4, 5].includes(size)) throw new RangeError("invalid_size");
  if (cells.length !== size * size) throw new RangeError("invalid_cells");
  const seen = new Set<number>();
  for (const c of cells) {
    if (!Number.isInteger(c.pos) || c.pos < 0 || c.pos >= size * size || seen.has(c.pos)) throw new RangeError("invalid_cells");
    seen.add(c.pos);
  }
}

/**
 * Evaluate a card. `done` holds the cell ids that have a (local) photo; ids that aren't on this
 * card are ignored, and free squares are always done.
 */
export function evaluateCard(input: { size: number; mode: WinMode; cells: readonly CardCell[]; done: ReadonlySet<string> }): CardEvaluation {
  const { size, mode, cells, done } = input;
  checkCard(size, cells);
  const byPos = new Map(cells.map((c) => [c.pos, c]));
  const isDone = (pos: number) => { const c = byPos.get(pos)!; return c.isFree || done.has(c.cellId); };
  const needs = cells.filter((c) => !c.isFree);
  const completed = needs.filter((c) => done.has(c.cellId)).length;
  const required = needs.length;
  const donePositions = new Set(cells.filter((c) => isDone(c.pos)).map((c) => c.pos));
  const toLine = (l: { pattern: Pattern; positions: number[] }): WinLine => ({
    ...l, cellIds: l.positions.map((p) => byPos.get(p)!).filter((c) => !c.isFree).map((c) => c.cellId),
  });
  const all = boardLines(size);
  const lines = all.filter((l) => l.positions.every(isDone)).map(toLine);
  const full = completed === required;
  const missingIn = (positions: number[]) => positions.filter((p) => !isDone(p)).length;

  let eligible: boolean, claim: CardEvaluation["claim"], winning: number[], toGo: number;
  if (mode === "full_card") {
    eligible = full && required > 0;
    claim = eligible ? { pattern: "full", cellIds: needs.slice().sort((a, b) => a.pos - b.pos).map((c) => c.cellId) } : null;
    winning = eligible ? cells.map((c) => c.pos) : [];
    toGo = required - completed;
  } else {
    eligible = lines.length > 0;
    claim = eligible ? { pattern: lines[0].pattern, cellIds: lines[0].cellIds } : null;
    winning = lines.flatMap((l) => l.positions);
    toGo = Math.min(...all.map((l) => missingIn(l.positions)));
  }

  return {
    mode, size, required, completed,
    percent: required ? (full ? 100 : Math.floor((completed / required) * 100)) : 100,
    donePositions, lines, full, eligible, claim,
    winningPositions: new Set(winning),
    toGo,
  };
}

/** Human name of a pattern ("Row 2", "Column 1", "Top-left diagonal", "Full card"). */
export function patternLabel(p: Pattern): string {
  if (p === "full") return "Full card";
  if (p === "diag:main") return "Top-left diagonal";
  if (p === "diag:anti") return "Top-right diagonal";
  const [kind, n] = p.split(":");
  return `${kind === "row" ? "Row" : "Column"} ${Number(n) + 1}`;
}
