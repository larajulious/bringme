import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { boardLines, evaluateCard, patternLabel, type CardCell } from "../lib/bingosnap/completion.ts";
import type { WinMode } from "../lib/bingosnap/types.ts";

/** A player's card: cell ids are deliberately NOT in position order (each player has their own order). */
function card(size: number, free: boolean): CardCell[] {
  const centre = free && size % 2 === 1 ? (size * size - 1) / 2 : -1;
  return Array.from({ length: size * size }, (_, pos) => ({ pos, cellId: `cell-${(pos * 7 + 3) % (size * size)}`, isFree: pos === centre }));
}
const idsAt = (cells: CardCell[], positions: number[]) => positions.map((p) => cells[p]).filter((c) => !c.isFree).map((c) => c.cellId);
const ev = (size: number, mode: WinMode, free: boolean, positions: number[], extraIds: string[] = []) => {
  const cells = card(size, free);
  return evaluateCard({ size, mode, cells, done: new Set([...idsAt(cells, positions), ...extraIds]) });
};
const SIZES = [3, 4, 5] as const;
const row = (n: number, r: number) => Array.from({ length: n }, (_, c) => r * n + c);
const col = (n: number, c: number) => Array.from({ length: n }, (_, r) => r * n + c);
const main = (n: number) => Array.from({ length: n }, (_, i) => i * n + i);
const anti = (n: number) => Array.from({ length: n }, (_, i) => i * n + (n - 1 - i));

describe("boardLines", () => {
  it("has n rows, n columns and 2 diagonals for every size", () => {
    for (const n of SIZES) {
      const l = boardLines(n);
      assert.equal(l.length, 2 * n + 2);
      assert.deepEqual(l.find((x) => x.pattern === "diag:anti")!.positions, anti(n));
      assert.deepEqual(l.find((x) => x.pattern === `col:${n - 1}`)!.positions, col(n, n - 1));
    }
  });
});

describe("Traditional Bingo", () => {
  for (const n of SIZES) {
    it(`${n}×${n}: every row and column wins, and the claim is exactly that line's cells`, () => {
      for (let k = 0; k < n; k++) {
        for (const [pattern, positions] of [[`row:${k}`, row(n, k)], [`col:${k}`, col(n, k)]] as const) {
          const e = ev(n, "traditional", false, positions);
          assert.equal(e.eligible, true, pattern);
          assert.deepEqual(e.lines.map((l) => l.pattern), [pattern]);
          assert.deepEqual(e.claim, { pattern, cellIds: idsAt(card(n, false), positions) });
          assert.deepEqual([...e.winningPositions].sort((a, b) => a - b), positions);
        }
      }
    });
    it(`${n}×${n}: both diagonals win`, () => {
      assert.equal(ev(n, "traditional", false, main(n)).claim?.pattern, "diag:main");
      assert.equal(ev(n, "traditional", false, anti(n)).claim?.pattern, "diag:anti");
    });
    it(`${n}×${n}: one square short of every line is not a win`, () => {
      for (const l of boardLines(n)) {
        const e = ev(n, "traditional", false, l.positions.slice(1));
        assert.equal(e.eligible, false, l.pattern);
        assert.equal(e.claim, null);
        assert.equal(e.toGo, 1);
      }
    });
  }

  it("an empty or scattered card is incomplete", () => {
    const empty = ev(5, "traditional", false, []);
    assert.deepEqual([empty.eligible, empty.completed, empty.required, empty.percent, empty.toGo, empty.lines.length], [false, 0, 25, 0, 5, 0]);
    const scattered = ev(3, "traditional", false, [0, 5, 7]); // no line
    assert.deepEqual([scattered.eligible, scattered.completed, scattered.percent], [false, 3, 33]);
  });

  it("free centre counts as done: the middle row of a 3×3 needs 2 photos, a 5×5 diagonal 4", () => {
    const e3 = ev(3, "traditional", true, [3, 5]);
    assert.equal(e3.claim?.pattern, "row:1");
    assert.equal(e3.claim?.cellIds.length, 2, "the free square is never sent");
    assert.equal(e3.required, 8);
    assert.ok(e3.donePositions.has(4));
    const e5 = ev(5, "traditional", true, [0, 6, 18, 24]);
    assert.equal(e5.claim?.pattern, "diag:main");
    assert.equal(e5.claim?.cellIds.length, 4);
    assert.equal(ev(5, "traditional", true, []).toGo, 4);
    assert.equal(ev(5, "traditional", false, []).toGo, 5, "without a free centre every line needs 5");
  });

  it("several lines: all are reported and highlighted, the claim is the first", () => {
    const e = ev(3, "traditional", false, [...row(3, 0), ...col(3, 0), 4, 8]); // row 0, col 0 and both diagonals
    assert.deepEqual(e.lines.map((l) => l.pattern), ["row:0", "col:0", "diag:main", "diag:anti"]);
    assert.equal(e.claim?.pattern, "row:0");
    assert.equal(e.winningPositions.size, 7);
  });

  it("ids that are not on this card are ignored", () => {
    const e = ev(3, "traditional", false, [0, 1], ["cell-999", "someone-else"]);
    assert.deepEqual([e.completed, e.eligible], [2, false]);
  });
});

describe("Full Card", () => {
  for (const n of SIZES) {
    it(`${n}×${n}: only the whole card is eligible, and the claim lists every square`, () => {
      const all = Array.from({ length: n * n }, (_, i) => i);
      const almost = ev(n, "full_card", false, all.slice(1));
      assert.equal(almost.eligible, false);
      assert.equal(almost.toGo, 1);
      assert.ok(almost.percent < 100);
      assert.equal(ev(n, "full_card", false, row(n, 0)).eligible, false, "a line is not enough");
      const done = ev(n, "full_card", false, all);
      assert.deepEqual([done.eligible, done.full, done.percent, done.claim?.pattern, done.claim?.cellIds.length, done.winningPositions.size], [true, true, 100, "full", n * n, n * n]);
      assert.deepEqual(done.claim?.cellIds, idsAt(card(n, false), all), "in board order");
    });
  }
  it("free squares are excluded from the requirement", () => {
    const e = ev(3, "full_card", true, [0, 1, 2, 3, 5, 6, 7, 8]);
    assert.deepEqual([e.required, e.completed, e.eligible, e.claim?.cellIds.length], [8, 8, true, 8]);
  });
  it("percent rounds down so 99.x% never shows as 100%", () => {
    assert.equal(ev(5, "full_card", false, Array.from({ length: 24 }, (_, i) => i)).percent, 96);
    assert.equal(ev(3, "full_card", false, [0, 1]).percent, 22);
  });
});

describe("recalculation: removing and replacing photos", () => {
  it("removing a photo from the only line breaks the win; adding it back restores it", () => {
    const cells = card(4, false);
    const done = new Set(idsAt(cells, col(4, 2)));
    assert.equal(evaluateCard({ size: 4, mode: "traditional", cells, done }).claim?.pattern, "col:2");
    done.delete(cells[6].cellId);
    const broken = evaluateCard({ size: 4, mode: "traditional", cells, done });
    assert.deepEqual([broken.eligible, broken.completed, broken.toGo], [false, 3, 1]);
    done.add(cells[6].cellId); // retaken / restored after a refresh
    assert.equal(evaluateCard({ size: 4, mode: "traditional", cells, done }).eligible, true);
  });
  it("replacing a photo (same square, new photo) changes nothing", () => {
    const cells = card(3, true);
    const before = evaluateCard({ size: 3, mode: "traditional", cells, done: new Set(idsAt(cells, [3, 5])) });
    const after = evaluateCard({ size: 3, mode: "traditional", cells, done: new Set(idsAt(cells, [5, 3])) });
    assert.deepEqual(after.claim, before.claim);
    assert.equal(after.completed, before.completed);
  });
  it("removing a square from a full card makes it ineligible again", () => {
    const cells = card(3, false);
    const done = new Set(cells.map((c) => c.cellId));
    assert.equal(evaluateCard({ size: 3, mode: "full_card", cells, done }).eligible, true);
    done.delete(cells[8].cellId);
    assert.equal(evaluateCard({ size: 3, mode: "full_card", cells, done }).eligible, false);
  });
});

describe("input checks and labels", () => {
  it("refuses unsupported sizes and malformed cards", () => {
    assert.throws(() => evaluateCard({ size: 6, mode: "traditional", cells: card(5, false), done: new Set() }), /invalid_size/);
    assert.throws(() => evaluateCard({ size: 3, mode: "traditional", cells: card(3, false).slice(1), done: new Set() }), /invalid_cells/);
    const dup = card(3, false); dup[1] = { ...dup[1], pos: 0 };
    assert.throws(() => evaluateCard({ size: 3, mode: "traditional", cells: dup, done: new Set() }), /invalid_cells/);
  });
  it("names patterns for people", () => {
    assert.deepEqual(["row:0", "col:2", "diag:main", "diag:anti", "full"].map((p) => patternLabel(p as never)), ["Row 1", "Column 3", "Top-left diagonal", "Top-right diagonal", "Full card"]);
  });
});
