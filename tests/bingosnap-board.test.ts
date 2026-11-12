import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CHALLENGE_IDEAS, boardProblems, centreIndex, clampMinutes, editablePositions, effectiveFree, emptyCells, fillWithIdeas,
  editorInitialFrom, formatMinutes, moveInGrid, nextEmpty, pasteLines, readyCount, reshapeBoard, shortLabel, stepEditable, suggestions,
} from "../lib/bingosnap/board.ts";
import { parseBoardInput } from "../lib/bingosnap/validation.ts";

const nine = (...xs: string[]) => [...xs, ...Array(9 - xs.length).fill("")];

describe("board shape", () => {
  it("free centre only on odd Traditional boards; editable squares skip it", () => {
    assert.deepEqual([effectiveFree(true, 3, "traditional"), effectiveFree(true, 4, "traditional"), effectiveFree(true, 5, "full_card")], [true, false, false]);
    assert.deepEqual([centreIndex(3, true), centreIndex(5, true), centreIndex(4, true), centreIndex(5, false)], [4, 12, null, null]);
    assert.deepEqual(editablePositions({ size: 3, free: true }), [0, 1, 2, 3, 5, 6, 7, 8]);
    assert.equal(emptyCells(5).length, 25);
  });
});

describe("reshapeBoard (preserve instructions, warn about removals)", () => {
  it("growing keeps every instruction in reading order", () => {
    const r = reshapeBoard(nine("a", "b", "c", "d"), { size: 3, free: false }, { size: 5, free: true });
    assert.deepEqual(r.dropped, []);
    assert.deepEqual(r.cells.slice(0, 4), ["a", "b", "c", "d"]);
    assert.equal(r.cells[12], "", "centre stays free");
    assert.equal(r.cells.length, 25);
  });
  it("keeps gaps between instructions when they fit", () => {
    const r = reshapeBoard(nine("a", "", "c"), { size: 3, free: false }, { size: 4, free: false });
    assert.deepEqual(r.cells.slice(0, 3), ["a", "", "c"]);
  });
  it("shrinking squeezes out gaps first, then reports what doesn't fit", () => {
    const five = Array.from({ length: 25 }, (_, i) => (i % 2 ? `x${i}` : ""));
    const r = reshapeBoard(five, { size: 5, free: false }, { size: 3, free: false });
    assert.equal(r.cells.filter(Boolean).length, 9);
    assert.deepEqual(r.dropped, ["x19", "x21", "x23"]);
    const fits = reshapeBoard(["a", "", "", "", "", "", "", "", "", "b", ...Array(15).fill("")], { size: 5, free: false }, { size: 3, free: false });
    assert.deepEqual([fits.dropped, fits.cells.filter(Boolean)], [[], ["a", "b"]], "gaps squeezed so nothing is lost");
  });
  it("turning on the free centre moves its instruction to an empty square, or drops it when full", () => {
    const moved = reshapeBoard(nine("a", "b", "c", "d", "CENTRE"), { size: 3, free: false }, { size: 3, free: true });
    assert.deepEqual([moved.cells[4], moved.cells[5], moved.dropped], ["", "CENTRE", []]);
    const full = Array.from({ length: 9 }, (_, i) => `c${i}`);
    const dropped = reshapeBoard(full, { size: 3, free: false }, { size: 3, free: true });
    assert.deepEqual([dropped.cells[4], dropped.dropped], ["", ["c4"]]);
  });
  it("turning the free centre off leaves an empty, editable centre", () => {
    const r = reshapeBoard(nine("a"), { size: 3, free: true }, { size: 3, free: false });
    assert.deepEqual([r.cells[4], r.dropped], ["", []]);
  });
});

describe("keyboard navigation", () => {
  it("arrows stay inside the grid; Home/End go to the row ends", () => {
    assert.deepEqual(["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].map((k) => moveInGrid(4, 3, k)), [5, 7, 3, 1]);
    assert.deepEqual(["ArrowLeft", "ArrowUp"].map((k) => moveInGrid(0, 3, k)), [0, 0]);
    assert.deepEqual([moveInGrid(7, 4, "Home"), moveInGrid(4, 4, "End")], [4, 7]);
  });
  it("Next/Previous skip the free centre and stop at the ends", () => {
    const s = { size: 3, free: true } as const;
    assert.deepEqual([stepEditable(3, s, 1), stepEditable(5, s, -1), stepEditable(8, s, 1), stepEditable(0, s, -1)], [5, 3, null, null]);
    assert.deepEqual([stepEditable(4, s, 1), stepEditable(4, s, -1)], [5, 3], "from the free centre");
  });
  it("finds the next empty square", () => {
    assert.equal(nextEmpty(nine("a", "b"), { size: 3, free: false }), 2);
    assert.equal(nextEmpty(nine("a", "b", "c", "d", "", "f", "g", "h", "i"), { size: 3, free: true }), null, "free centre isn't a gap");
  });
});

describe("validation & helpers", () => {
  it("reports empty, duplicate and too-long squares; the free centre is never a problem", () => {
    const p = boardProblems(["Hat", "", "hat", "x".repeat(121), "", "a", "b", "c", "d"], { size: 3, free: true });
    assert.deepEqual(p, [null, "empty", "duplicate", "too_long", null, null, null, null, null]);
    assert.equal(readyCount(["Hat", "", "hat", "x".repeat(121), "", "a", "b", "c", "d"], { size: 3, free: true }), 6);
  });
  it("Fill with ideas fills only empty squares with distinct unused ideas (25 available)", () => {
    const out = fillWithIdeas(nine(CHALLENGE_IDEAS[0], "", "Mine"), { size: 3, free: true });
    assert.deepEqual([out[0], out[2], out[4]], [CHALLENGE_IDEAS[0], "Mine", ""]);
    assert.ok(boardProblems(fillWithIdeas(emptyCells(5), { size: 5, free: false }), { size: 5, free: false }).every((x) => x === null));
    assert.ok(!suggestions(out).some((s) => out.includes(s)));
  });
  it("pasting a list fills the following editable squares, skipping the centre", () => {
    assert.equal(pasteLines(emptyCells(3), 0, "one line", { size: 3, free: true }), null);
    const out = pasteLines(emptyCells(3), 3, "a\nb\n\nc", { size: 3, free: true })!;
    assert.deepEqual([out[3], out[4], out[5], out[6]], ["a", "", "b", "c"]);
  });
  it("labels, timer clamp and format", () => {
    assert.deepEqual([shortLabel(0, 5), shortLabel(12, 5), shortLabel(24, 5)], ["A1", "C3", "E5"]);
    assert.deepEqual([clampMinutes(1), clampMinutes(500), clampMinutes(NaN)], [3, 120, 3]);
    assert.deepEqual([formatMinutes(20), formatMinutes(90)], ["20 min", "1 h 30 min"]);
  });
  it("a board produced by the editor helpers is accepted by the API, at every size", () => {
    for (const [size, mode, free] of [[3, "traditional", true], [4, "full_card", false], [5, "traditional", true], [5, "full_card", true]] as const) {
      const f = effectiveFree(free, size, mode);
      const cells = fillWithIdeas(emptyCells(size), { size, free: f });
      const r = parseBoardInput({ boardSize: size, winMode: mode, freeSpace: f, cells, publish: true }, { existing: false });
      assert.ok(r.ok, `${size}/${mode}/${free}: ${r.ok ? "" : r.error}`);
    }
  });
});

describe("editorInitialFrom (Phase 5)", () => {
  it("orders squares row-major from the snapshot and keeps the revision", () => {
    const cell = (order: number, challenge: string | null, isFree = false) => ({ id: `c${order}`, row: Math.floor(order / 3), col: order % 3, order, challenge, isFree });
    const snap = {
      gameId: "g", status: "lobby" as const, version: 4, boardRevision: 2, joinCode: "ABC123", title: "T",
      board: { size: 3 as const, winMode: "traditional" as const, winnerRule: "first" as const, freeSpace: true, durationSeconds: 600, huntStartedAt: null, huntEndsAt: null, huntOver: false, resultsAt: null },
      cells: [cell(8, "i"), cell(0, "a"), cell(4, null, true), cell(1, "b"), cell(2, "c"), cell(3, "d"), cell(5, "f"), cell(6, "g"), cell(7, "h")],
    } as unknown as Parameters<typeof editorInitialFrom>[0];
    const e = editorInitialFrom(snap);
    assert.deepEqual(e.cells, ["a", "b", "c", "d", "", "f", "g", "h", "i"]);
    assert.deepEqual([e.revision, e.status, e.size, e.freeSpace, e.winnerRule, e.joinCode], [2, "lobby", 3, true, "first", "ABC123"]);
  });
});
