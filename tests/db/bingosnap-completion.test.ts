import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";

import { boardLines, evaluateCard, type CardCell } from "../../lib/bingosnap/completion.ts";
import type { WinMode } from "../../lib/bingosnap/types.ts";
import { createDb } from "./harness.ts";

/**
 * The client's completion engine must agree with the server's `bingo_pattern`: whatever the
 * engine offers to submit is accepted with the same pattern, and every line / full card the
 * server accepts is one the engine recognises.
 */
let db: PGlite;
before(async () => { db = await createDb(); });
after(async () => { await db.close(); });

const sqlPattern = async (size: number, mode: WinMode, free: number | null, positions: number[]) =>
  (await db.query<{ p: string | null }>("select public.bingo_pattern($1, $2::public.bingo_win_mode, $3, $4::int[]) as p", [size, mode, free, positions])).rows[0].p;

// Deterministic pseudo-random sets (no flakiness).
function* sets(n: number, count: number) {
  let x = 12345 + n;
  for (let i = 0; i < count; i++) {
    const s: number[] = [];
    for (let p = 0; p < n * n; p++) { x = (x * 1103515245 + 12345) & 0x7fffffff; if (x % 100 < 30 + (i % 80)) s.push(p); }
    yield s;
  }
}

const CONFIGS: [number, WinMode, boolean][] = [
  [3, "traditional", false], [3, "traditional", true], [4, "traditional", false], [5, "traditional", false], [5, "traditional", true],
  [3, "full_card", false], [4, "full_card", false], [5, "full_card", false],
];

describe("completion engine ⇔ SQL bingo_pattern", () => {
  for (const [size, mode, freeOn] of CONFIGS) {
    const free = freeOn ? (size * size - 1) / 2 : null;
    const cells: CardCell[] = Array.from({ length: size * size }, (_, pos) => ({ pos, cellId: `id${pos}`, isFree: pos === free }));
    const posOf = (ids: string[]) => ids.map((id) => Number(id.slice(2)));

    it(`${size}×${size} ${mode}${freeOn ? " + free centre" : ""}: every claim the engine offers is accepted with the same pattern`, async () => {
      let offered = 0;
      for (const s of sets(size, 120)) {
        const e = evaluateCard({ size, mode, cells, done: new Set(s.filter((p) => p !== free).map((p) => `id${p}`)) });
        if (!e.claim) continue;
        offered++;
        assert.equal(await sqlPattern(size, mode, free, posOf(e.claim.cellIds)), e.claim.pattern, JSON.stringify(s));
      }
      assert.ok(offered > 5, `exercised ${offered} claims`);
    });

    it(`${size}×${size} ${mode}${freeOn ? " + free centre" : ""}: every server-accepted pattern is recognised by the engine`, async () => {
      const targets = mode === "full_card"
        ? [{ pattern: "full", positions: cells.filter((c) => !c.isFree).map((c) => c.pos) }]
        : boardLines(size).map((l) => ({ pattern: l.pattern, positions: l.positions.filter((p) => p !== free) }));
      for (const t of targets) {
        assert.equal(await sqlPattern(size, mode, free, t.positions), t.pattern);
        const e = evaluateCard({ size, mode, cells, done: new Set(t.positions.map((p) => `id${p}`)) });
        assert.ok(e.eligible && (mode === "full_card" ? e.claim?.pattern === "full" : e.lines.some((l) => l.pattern === t.pattern)), t.pattern);
        if (t.positions.length > 1) {
          const short = t.positions.slice(1);
          assert.equal(await sqlPattern(size, mode, free, short), null, "one short is refused by the server");
          const e2 = evaluateCard({ size, mode, cells, done: new Set(short.map((p) => `id${p}`)) });
          assert.ok(mode === "full_card" ? !e2.eligible : !e2.lines.some((l) => l.pattern === t.pattern), "…and by the engine");
        }
      }
    });
  }
});
