import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";

import { generatePlayerToken, hashToken } from "../../lib/players/token.ts";
import { as, createDb, createUser, endCurrentPass, errorOf, subscribe } from "./harness.ts";

// Phase 5: joining and the lobby (migration 20). Joining reuses join_game() unchanged.
type Snap = {
  gameId: string; status: string; lifecycle: string; phase: string; version: number; joinCode?: string; playerCount: number; maxPlayers: number;
  countdownEndsAt: string | null; serverNow: string;
  board: { size: number; huntStartedAt: string | null; huntEndsAt: string | null };
  me: { id: string; nickname: string; state: string; layout: unknown[] | null };
  players: { id: string; nickname: string; state: string }[];
};
type Room = { gameType: string; status: string; title?: string; playerCount?: number; maxPlayers?: number; board?: Record<string, unknown> | null };

let db: PGlite;
let host: string;
let other: string;
const svc = { role: "service_role" } as const;
const anon = { role: "anon" } as const;
const user = (sub: string) => ({ role: "authenticated", sub }) as const;
const cells = (n: number) => Array.from({ length: n }, (_, i) => `thing ${i + 1}`);

async function publish(owner: string, size = 3): Promise<{ id: string; code: string }> {
  const s = await as(db, user(owner), async () => (await db.query<{ s: Snap }>(
    "select public.bingo_save_board(null,0,'Lobby night',$1,'traditional',false,600,'ranked',$2,true) s", [size, cells(size * size)])).rows[0].s);
  return { id: s.gameId, code: (await db.query<{ c: string }>("select join_code c from public.games where id=$1", [s.gameId])).rows[0].c };
}
async function draft(owner: string): Promise<{ id: string; code: string }> {
  const s = await as(db, user(owner), async () => (await db.query<{ s: Snap }>(
    "select public.bingo_save_board(null,0,'Draft',3,'traditional',false,600,'ranked',$1,false) s", [Array(9).fill("")])).rows[0].s);
  return { id: s.gameId, code: (await db.query<{ c: string }>("select join_code c from public.games where id=$1", [s.gameId])).rows[0].c };
}
async function freeSlots(owner: string) {
  await db.query("select set_config('bingosnap.engine','on',false)");
  await db.query("update public.games set status='canceled' where owner_id=$1 and status in ('draft','lobby','live')", [owner]);
  await db.query("select set_config('bingosnap.engine','off',false)");
}
const bringMe = (owner: string) => as(db, user(owner), async () => (await db.query<{ id: string; code: string }>(
  "select game_id id, code from public.create_game_with_rounds('Bring Me night', array['a spoon'])")).rows[0]);
const join = (code: string, name: string, token = generatePlayerToken(), existing?: string) =>
  as(db, svc, async () => (await db.query<{ player_id: string; restored: boolean; game_id: string }>(
    "select * from public.join_game($1,$2,$3,$4)", [code, name, hashToken(token), existing ? hashToken(existing) : null])).rows[0]);
const room = (code: string) => as(db, svc, async () => (await db.query<{ r: Room | null }>("select public.bingo_room_info($1) r", [code])).rows[0].r);
const playerState = (token: string) =>
  as(db, svc, async () => (await db.query<{ s: Snap | null }>("select public.bingo_player_state($1) s", [hashToken(token)])).rows[0].s);
const hostState = (id: string, sub = host) => as(db, user(sub), async () => (await db.query<{ s: Snap }>("select public.bingo_host_state($1) s", [id])).rows[0].s);
const ver = async (id: string) => Number((await db.query<{ v: string }>("select state_version::text v from public.games where id=$1", [id])).rows[0].v);
const start = async (id: string, sub = host, version?: number) =>
  as(db, user(sub), async () => (await db.query<{ s: Snap }>("select public.bingo_start($1,$2) s", [id, version ?? await ver(id)])).rows[0].s);
const kick = (id: string, player: string, sub = host) =>
  as(db, user(sub), () => db.query("update public.players set kicked_at = now() where id=$1 and game_id=$2", [player, id]));

before(async () => {
  db = await createDb();
  host = await createUser(db, "lobby-host@example.com");
  other = await createUser(db, "lobby-other@example.com");
  await subscribe(db, host, { plan: "pro" });
  await subscribe(db, other, { plan: "pro" });
});
after(async () => { await db.close(); });

describe("room info (join page)", () => {
  it("describes a published BingoSnap room without revealing challenges", async () => {
    await freeSlots(host);
    const g = await publish(host);
    const r = await room(g.code.toLowerCase());
    assert.equal(r?.gameType, "bingosnap");
    assert.deepEqual([r?.status, r?.title, r?.playerCount, r?.maxPlayers], ["lobby", "Lobby night", 0, 100]);
    assert.deepEqual(r?.board, { size: 3, winMode: "traditional", freeSpace: false, winnerRule: "ranked", durationSeconds: 600 });
    assert.doesNotMatch(JSON.stringify(r), /thing 1/);
  });

  it("a draft shows no board; a Bring Me room reports only its type; unknown codes are null", async () => {
    await freeSlots(host);
    const d = await draft(host);
    const r = await room(d.code);
    assert.deepEqual([r?.status, r?.board], ["draft", null]);
    await freeSlots(host);
    const bm = await bringMe(host);
    assert.deepEqual(await room(bm.code), { gameType: "bring_me", status: "lobby" });
    assert.equal(await room("ZZZZZZ"), null);
  });

  it("is not callable by browsers (anon / authenticated)", async () => {
    assert.match((await errorOf(as(db, anon, () => db.query("select public.bingo_room_info('ABCDEF')")))) ?? "", /permission denied/);
    assert.match((await errorOf(as(db, user(host), () => db.query("select public.bingo_room_info('ABCDEF')")))) ?? "", /permission denied/);
    assert.match((await errorOf(as(db, anon, () => db.query("select public.bingo_player_state('x')")))) ?? "", /permission denied/);
  });
});

describe("joining", () => {
  it("joins with the existing join_game, restores the same browser, and the snapshot carries the room code", async () => {
    await freeSlots(host);
    const g = await publish(host);
    const token = generatePlayerToken();
    const first = await join(g.code, "Ann", token);
    assert.equal(first.restored, false);
    const again = await join(g.code, "Ann again", generatePlayerToken(), token);
    assert.deepEqual([again.restored, again.player_id], [true, first.player_id], "refresh: no duplicate participant");
    const s = await playerState(token);
    assert.deepEqual([s?.joinCode, s?.me.id, s?.me.nickname, s?.status, s?.playerCount], [g.code, first.player_id, "Ann", "lobby", 1]);
    assert.equal(s?.me.layout, null, "no challenges before the hunt");
    assert.equal((await hostState(g.id)).players.length, 1);
  });

  it("identity is the token only: another participant's id or name gets nothing", async () => {
    await freeSlots(host);
    const g = await publish(host);
    const ann = generatePlayerToken();
    await join(g.code, "Ann", ann);
    assert.equal(await playerState(generatePlayerToken()), null, "unknown token");
    // the same name from another browser is refused, not merged into Ann's seat
    assert.match((await errorOf(join(g.code, "Ann"))) ?? "", /duplicate|unique|23505/i);
  });

  it("refuses drafts, started, finished and cancelled games, and unknown codes", async () => {
    await freeSlots(host);
    const d = await draft(host);
    assert.match((await errorOf(join(d.code, "Ann"))) ?? "", /game_not_joinable/);
    await freeSlots(host);
    const g = await publish(host);
    await join(g.code, "Ann");
    await start(g.id);
    assert.match((await errorOf(join(g.code, "Late"))) ?? "", /game_not_joinable/);
    await freeSlots(host);
    assert.match((await errorOf(join(g.code, "Later"))) ?? "", /game_not_joinable/, "cancelled");
    assert.match((await errorOf(join("ZZZZZZ", "Nobody"))) ?? "", /game_not_found/);
  });

  it("caps the room at the host's pass (Free Trial 3) and frees a seat after a removal", async () => {
    const trial = await createUser(db, "lobby-trial@example.com");
    await subscribe(db, trial, { plan: "trial" });
    const g = await publish(trial);
    assert.equal((await room(g.code))?.maxPlayers, 3);
    const ids = [];
    for (const n of ["A", "B", "C"]) ids.push((await join(g.code, n)).player_id);
    assert.match((await errorOf(join(g.code, "D"))) ?? "", /game_full/);
    await kick(g.id, ids[0], trial);
    assert.equal((await join(g.code, "D")).restored, false);
    assert.equal((await room(g.code))?.playerCount, 3);
  });

  it("a removed participant can't come back with their old session", async () => {
    await freeSlots(host);
    const g = await publish(host);
    const token = generatePlayerToken();
    const p = await join(g.code, "Ann", token);
    await kick(g.id, p.player_id);
    assert.match((await errorOf(join(g.code, "Ann", generatePlayerToken(), token))) ?? "", /player_removed/);
    assert.equal((await playerState(token))?.me.state, "removed");
  });

  it("a Bring Me session is not a BingoSnap participant (wrong_game_type)", async () => {
    await freeSlots(host);
    const bm = await bringMe(host);
    const token = generatePlayerToken();
    await join(bm.code, "Bea", token);
    assert.match((await errorOf(playerState(token))) ?? "", /wrong_game_type/);
  });
});

describe("realtime", () => {
  it("joins, removals and the start each broadcast a state hint on the game's private channel", async () => {
    await freeSlots(host);
    const g = await publish(host);
    await db.query("delete from realtime.messages");
    const p = await join(g.code, "Ann");
    await join(g.code, "Ben");
    await kick(g.id, p.player_id);
    await start(g.id);
    const rows = (await db.query<{ topic: string; private: boolean; payload: Record<string, unknown> }>(
      "select topic, private, payload from realtime.messages order by id")).rows;
    assert.ok(rows.length >= 6, `join, join, kick, start game, countdown, hunt (got ${rows.length})`);
    assert.ok(rows.every((r) => r.topic === `game:${g.id}` && r.private));
    assert.ok(rows.every((r) => Object.keys(r.payload).sort().join() === "phase,scope,version"), "hints carry no player data");
    // Phase 2: joins are 'roster' (players debounce), the removal and the start are 'all'
    assert.deepEqual(rows.slice(0, 3).map((r) => r.payload.scope), ["roster", "roster", "all"]);
    assert.ok(rows.slice(3).every((r) => r.payload.scope === "all"));
  });

  it("only the owner and this game's guests may listen", async () => {
    await freeSlots(host);
    const g = await publish(host);
    const can = (actor: Parameters<typeof as>[1]) => as(db, actor, async () =>
      (await db.query<{ ok: boolean }>("select public.can_listen_game_topic($1) ok", [`game:${g.id}`])).rows[0].ok);
    assert.equal(await can(user(host)), true);
    assert.notEqual(await can(user(other)), true);
  });
});

describe("start", () => {
  it("starts the game, runs the 3 s countdown and opens the hunt at its end, in one step", async () => {
    await freeSlots(host);
    const g = await publish(host);
    const token = generatePlayerToken();
    await join(g.code, "Ann", token);
    const s = await start(g.id);
    assert.deepEqual([s.status, s.lifecycle, s.phase], ["active", "live", "active"]);
    assert.ok(s.countdownEndsAt && s.board.huntStartedAt);
    assert.equal(Date.parse(s.board.huntStartedAt!), Date.parse(s.countdownEndsAt!), "the hunt opens when the countdown ends");
    assert.equal(Date.parse(s.board.huntEndsAt!) - Date.parse(s.board.huntStartedAt!), 600_000);
    const delta = Date.parse(s.countdownEndsAt!) - Date.parse(s.serverNow);
    assert.ok(delta > 2000 && delta <= 3100, `countdown ~3 s (got ${delta})`);
    const p = await playerState(token);
    assert.equal(p?.status, "active", "players see the game start");
    assert.equal(p?.me.layout, null, "challenges stay hidden during the countdown");
  });

  it("refuses an empty room, a stale version, another host, and an expired pass; a refusal changes nothing", async () => {
    await freeSlots(host);
    const g = await publish(host);
    assert.match((await errorOf(start(g.id))) ?? "", /no_players/);
    await join(g.code, "Ann");
    const v = await ver(g.id);
    assert.match((await errorOf(start(g.id, host, v - 1))) ?? "", /stale_state/);
    assert.match((await errorOf(start(g.id, other, v))) ?? "", /game_not_found/);
    const lapsed = await createUser(db, "lobby-lapsed@example.com");
    await subscribe(db, lapsed, { plan: "starter" });
    const l = await publish(lapsed);
    await join(l.code, "Zed");
    await endCurrentPass(db, lapsed);
    assert.match((await errorOf(start(l.id, lapsed, await ver(l.id)))) ?? "", /subscription_required/);
    const after = await hostState(l.id, lapsed);
    assert.deepEqual([after.status, after.phase, after.countdownEndsAt], ["lobby", "lobby", null]);
    assert.deepEqual([(await hostState(g.id)).status, await ver(g.id)], ["lobby", v]);
  });

  it("can't start twice", async () => {
    await freeSlots(host);
    const g = await publish(host);
    await join(g.code, "Ann");
    await start(g.id);
    assert.match((await errorOf(start(g.id))) ?? "", /invalid_transition/);
  });

  it("is executable by signed-in hosts only", async () => {
    assert.match((await errorOf(as(db, anon, () => db.query("select public.bingo_start(gen_random_uuid(), 1)")))) ?? "", /permission denied/);
  });
});
