import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";

import { generatePlayerToken, hashToken } from "../../lib/players/token.ts";
import { as, createDb, createUser, endCurrentPass, errorOf, subscribe } from "./harness.ts";

type State = { gameId: string; status: string; version: number; boardRevision: number; board: { size: number; winMode: string; freeSpace: boolean; durationSeconds: number; winnerRule: string };
  cells: { challenge: string | null; isFree: boolean; row: number; col: number }[]; title: string };

let db: PGlite;
let host: string;
let other: string;
const svc = { role: "service_role" } as const;
const user = (sub: string) => ({ role: "authenticated", sub }) as const;
const full = (n: number, tag = "c") => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`);
/** n² entries, the centre empty (for free-centre boards). */
const withCentre = (size: number, tag = "c") => full(size * size, tag).map((c, i) => (i === (size * size - 1) / 2 ? "" : c));

type Opts = { title?: string; size?: number; mode?: string; free?: boolean; duration?: number; rule?: string; cells?: (string | null)[]; publish?: boolean; revision?: number };
const save = (owner: string, game: string | null, o: Opts = {}) => {
  const size = o.size ?? 3;
  return as(db, user(owner), async () => (await db.query<{ s: State }>(
    "select public.bingo_save_board($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) s",
    [game, o.revision ?? 0, o.title ?? "Draft night", size, o.mode ?? "traditional", o.free ?? false, o.duration ?? 600, o.rule ?? "ranked",
      o.cells ?? Array(size * size).fill(""), o.publish ?? false])).rows[0].s);
};
const hostView = async (id: string, sub = host) =>
  (await as(db, user(sub), () => db.query<{ s: State }>("select public.bingo_host_state($1) s", [id]))).rows[0].s;
const ver = async (id: string) => Number((await db.query<{ v: string }>("select state_version::text v from public.games where id=$1", [id])).rows[0].v);
const act = async (id: string, action: string, sub = host) =>
  as(db, user(sub), async () => (await db.query("select public.bingo_transition($1,$2,$3,null)", [id, action, await ver(id)])).rows[0]);
const join = async (code: string, name: string) =>
  as(db, svc, () => db.query("select * from public.join_game($1,$2,$3,null)", [code, name, hashToken(generatePlayerToken())]));
const code = async (id: string) => (await db.query<{ c: string }>("select join_code c from public.games where id=$1", [id])).rows[0].c;
async function freeSlots(owner: string) {
  await db.query("select set_config('bingosnap.engine','on',false)");
  await db.query("update public.games set status='canceled' where owner_id=$1 and status in ('draft','lobby','live')", [owner]);
  await db.query("select set_config('bingosnap.engine','off',false)");
}

before(async () => {
  db = await createDb();
  host = await createUser(db, "board-host@example.com");
  other = await createUser(db, "board-other@example.com");
  await subscribe(db, host, { plan: "pro" });
  await subscribe(db, other, { plan: "pro" });
});
after(async () => { await db.close(); });

describe("drafts", () => {
  it("saves an empty draft (status draft, every position stored, not joinable)", async () => {
    await freeSlots(host);
    const s = await save(host, null, { size: 3, free: true });
    assert.equal(s.status, "draft");
    assert.equal(s.boardRevision, 0);
    assert.equal(s.cells.length, 9);
    assert.deepEqual(s.cells.map((c) => c.isFree), [false, false, false, false, true, false, false, false, false]);
    assert.ok(s.cells.every((c) => c.challenge === null));
    assert.match((await errorOf(join(await code(s.gameId), "Ann"))) ?? "", /game_not_joinable/);
  });

  it("keeps instructions per position, increments the revision, refuses stale saves", async () => {
    await freeSlots(host);
    const s0 = await save(host, null, { cells: ["red shoes", "", "", "", "", "", "", "", "a watch"] });
    assert.deepEqual([s0.cells[0].challenge, s0.cells[8].challenge, s0.cells[1].challenge], ["red shoes", "a watch", null]);
    const s1 = await save(host, s0.gameId, { revision: 0, title: "Renamed", cells: ["red shoes", "a plant", "", "", "", "", "", "", "a watch"] });
    assert.deepEqual([s1.boardRevision, s1.title, s1.cells[1].challenge], [1, "Renamed", "a plant"]);
    assert.match((await errorOf(save(host, s0.gameId, { revision: 0 }))) ?? "", /stale_board/, "a second tab with the old revision");
    assert.equal((await hostView(s0.gameId)).cells[1].challenge, "a plant", "nothing overwritten");
  });

  it("drafts may be incomplete and contain duplicates; trims; enforces the 120-character limit", async () => {
    await freeSlots(host);
    const s = await save(host, null, { cells: ["  hat ", "hat", "", "", "", "", "", "", ""] });
    assert.deepEqual([s.cells[0].challenge, s.cells[1].challenge], ["hat", "hat"]);
    assert.match((await errorOf(save(host, s.gameId, { cells: ["x".repeat(121), "", "", "", "", "", "", "", ""] }))) ?? "", /invalid_challenge/);
  });

  it("refuses invalid dimensions and an edited free centre", async () => {
    await freeSlots(host);
    for (const [o, re] of [
      [{ size: 3, cells: Array(8).fill("") }, /invalid_board_dimensions/],
      [{ size: 4, cells: Array(9).fill("") }, /invalid_board_dimensions/],
      [{ size: 6, cells: Array(36).fill("") }, /invalid_board_size/],
      [{ size: 3, free: true, cells: ["", "", "", "", "centre!", "", "", "", ""] }, /free_cell_not_editable/],
      [{ size: 4, free: true, cells: Array(16).fill("") }, /free_space_not_allowed/],
      [{ size: 3, mode: "full_card", free: true }, /free_space_not_allowed/],
    ] as [Opts, RegExp][]) {
      assert.match((await errorOf(save(host, null, o))) ?? "", re, JSON.stringify({ ...o, cells: o.cells?.length }));
    }
  });

  it("resizing a draft rewrites the board to the new dimensions", async () => {
    await freeSlots(host);
    const s = await save(host, null, { size: 3 });
    const r = await save(host, s.gameId, { revision: 0, size: 5, free: true, cells: withCentre(5) });
    assert.deepEqual([r.board.size, r.cells.length, r.cells.filter((c) => c.isFree).length, r.cells[12].isFree], [5, 25, 1, true]);
    const back = await save(host, s.gameId, { revision: 1, size: 4, cells: full(16) });
    assert.deepEqual([back.cells.length, back.cells.some((c) => c.isFree)], [16, false]);
    const rows = (await db.query<{ n: string }>("select count(*)::text n from public.bingo_cells where game_id=$1", [s.gameId])).rows[0].n;
    assert.equal(rows, "16", "no leftover squares");
  });

  it("only the owner can save; guests can't call it", async () => {
    await freeSlots(host);
    const s = await save(host, null);
    assert.match((await errorOf(save(other, s.gameId))) ?? "", /game_not_found/);
    assert.match((await errorOf(as(db, { role: "anon" }, () => db.query("select public.bingo_save_board(null,0,'x',3,'traditional',false,600,'ranked',$1)", [Array(9).fill("")])))) ?? "", /permission denied/);
  });
});

describe("publishing & the complete-board rule", () => {
  it("publishing needs every non-free square filled with distinct instructions; a refused publish changes nothing", async () => {
    await freeSlots(host);
    const s = await save(host, null, { cells: ["a", "b", "", "d", "e", "f", "g", "h", "i"] });
    assert.match((await errorOf(save(host, s.gameId, { revision: 0, cells: ["a", "b", "", "d", "e", "f", "g", "h", "i"], publish: true }))) ?? "", /board_incomplete/);
    assert.match((await errorOf(save(host, s.gameId, { revision: 0, cells: ["a", "A", "c", "d", "e", "f", "g", "h", "i"], publish: true }))) ?? "", /duplicate_challenge/);
    const still = await hostView(s.gameId);
    assert.deepEqual([still.status, still.boardRevision, still.cells[2].challenge], ["draft", 0, null], "rolled back");
    const pub = await save(host, s.gameId, { revision: 0, cells: full(9), publish: true });
    assert.equal(pub.status, "lobby");
    await join(await code(s.gameId), "Ann");
  });

  it("a free centre counts as complete", async () => {
    await freeSlots(host);
    const pub = await save(host, null, { size: 5, free: true, cells: withCentre(5), publish: true });
    assert.equal(pub.status, "lobby");
  });

  it("no path can publish or start an incomplete board (trigger)", async () => {
    await freeSlots(host);
    const s = await save(host, null);
    await db.query("select set_config('bingosnap.engine','on',false)");
    assert.match((await errorOf(db.query("update public.games set status='lobby' where id=$1", [s.gameId]))) ?? "", /board_incomplete/);
    await db.query("select set_config('bingosnap.engine','off',false)");
  });

  it("lobby boards stay editable but must stay complete", async () => {
    await freeSlots(host);
    const pub = await save(host, null, { cells: full(9), publish: true });
    const edited = await save(host, pub.gameId, { revision: 0, cells: full(9, "new") });
    assert.deepEqual([edited.status, edited.cells[0].challenge], ["lobby", "new 1"]);
    assert.match((await errorOf(save(host, pub.gameId, { revision: 1, cells: ["", ...full(8)] }))) ?? "", /board_incomplete/);
  });

  it("once the game starts the board, mode and timer are locked", async () => {
    await freeSlots(host);
    const pub = await save(host, null, { cells: full(9), publish: true });
    await join(await code(pub.gameId), "Ann");
    await act(pub.gameId, "start_game");
    assert.match((await errorOf(save(host, pub.gameId, { revision: 0, cells: full(9, "late"), mode: "full_card" }))) ?? "", /board_locked/);
    const s = await hostView(pub.gameId);
    assert.deepEqual([s.board.winMode, s.cells[0].challenge], ["traditional", "c 1"]);
  });

  it("a draft can be discarded (cancel)", async () => {
    await freeSlots(host);
    const s = await save(host, null);
    await act(s.gameId, "cancel");
    assert.equal((await hostView(s.gameId)).status, "cancelled");
    assert.match((await errorOf(save(host, s.gameId, { revision: 0 }))) ?? "", /board_locked/);
  });
});

describe("Game Pass (unchanged rules)", () => {
  it("creating a draft needs a pass and uses an open-game slot", async () => {
    const none = await createUser(db, "board-nopass@example.com");
    assert.match((await errorOf(save(none, null))) ?? "", /subscription_required/);
    const u = await createUser(db, "board-starter@example.com");
    await subscribe(db, u, { plan: "starter" }); // 1 open game
    await save(u, null);
    assert.match((await errorOf(as(db, user(u), () => db.query("select * from public.create_game_with_rounds('Classic', $1)", [["hat"]])))) ?? "", /game_limit_reached/);
  });

  it("after the pass ends a draft can still be saved, but not published", async () => {
    const u = await createUser(db, "board-expire@example.com");
    await subscribe(db, u, { plan: "starter" });
    const s = await save(u, null);
    await endCurrentPass(db, u);
    const kept = await save(u, s.gameId, { revision: 0, cells: full(9) });
    assert.equal(kept.status, "draft");
    assert.match((await errorOf(save(u, s.gameId, { revision: 1, cells: full(9), publish: true }))) ?? "", /subscription_required/);
  });

  it("a published board gets the pass's player cap", async () => {
    const u = await createUser(db, "board-trialcap@example.com");
    await subscribe(db, u, { plan: "trial" });
    const pub = await save(u, null, { cells: full(9), publish: true });
    const c = await code(pub.gameId);
    for (const n of ["A", "B", "C"]) await join(c, n);
    assert.match((await errorOf(join(c, "D"))) ?? "", /game_full/);
  });
});
