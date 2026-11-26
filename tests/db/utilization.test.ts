import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";

import { generatePlayerToken, hashToken } from "../../lib/players/token.ts";
import { as, createDb, createUser, errorOf, subscribe } from "./harness.ts";

// Capacity & health snapshot (migration 20261126000002): admin-only, read-only, counts open rooms correctly.
let db: PGlite;
let boss: string;
let host: string;
const svc = { role: "service_role" } as const;
const user = (sub: string) => ({ role: "authenticated", sub }) as const;

type Snapshot = {
  open_rooms: number; live_rooms: number; players_in_rooms: number; est_connections: number; peak_7d_connections: number;
  storage_bytes: number; db_bytes: number; db_connections: number; db_max_connections: number;
  rooms: { id: string; players: number; tvs: number; status: string; idle_minutes: number }[];
};
const snapshot = async () =>
  as(db, user(boss), async () => (await db.query<{ u: Snapshot }>("select public.admin_utilization() u")).rows[0].u);

async function openRoom(players: number, title: string) {
  const g = await as(db, user(host), async () =>
    (await db.query<{ game_id: string; code: string }>("select * from public.create_game_with_rounds($1, $2)", [title, ["a"]])).rows[0]);
  for (let i = 0; i < players; i++) {
    await as(db, svc, () => db.query("select * from public.join_game($1,$2,$3,null)", [g.code, `${title}${i}`, hashToken(generatePlayerToken())]));
  }
  return g.game_id;
}

before(async () => {
  db = await createDb();
  boss = await createUser(db, "health-boss@example.com");
  await db.query("update public.profiles set role='super_admin' where id=$1", [boss]);
  host = await createUser(db, "health-host@example.com");
  await subscribe(db, host, { plan: "pro" });
});
after(async () => { await db.close(); });

describe("admin_utilization", () => {
  it("is forbidden to non-admins and anon", async () => {
    assert.match((await errorOf(as(db, user(host), () => db.query("select public.admin_utilization()")))) ?? "", /forbidden/);
    assert.match((await errorOf(as(db, { role: "anon" }, () => db.query("select public.admin_utilization()")))) ?? "", /permission denied/);
  });

  it("is empty but well-formed with no rooms", async () => {
    const u = await snapshot();
    assert.equal(u.open_rooms, 0);
    assert.equal(u.est_connections, 0);
    assert.deepEqual(u.rooms, []);
    assert.ok(Number(u.db_bytes) > 0);
    assert.ok(u.db_max_connections > 0);
  });

  it("counts players, host + presenter and TV links per open room; removed players and finished games don't count", async () => {
    const big = await openRoom(5, "big");
    const small = await openRoom(2, "small");
    const done = await openRoom(3, "done");
    const ver = Number((await db.query<{ v: string }>("select state_version::text v from public.games where id=$1", [done])).rows[0].v);
    await as(db, user(host), () => db.query("select public.game_transition($1,'start_game',$2,null)", [done, ver]));
    await db.query("update public.games set status='finished' where id=$1", [done]);
    await db.query("update public.players set kicked_at = now() where id = (select id from public.players where game_id=$1 limit 1)", [small]);
    await db.query("insert into public.game_screens (game_id, token) values ($1, 'abcdefghjkmn')", [big]);
    await db.query("insert into storage.objects (bucket_id, name, metadata) values ('submissions', 'x/y/z.jpg', $1)", [JSON.stringify({ size: 4096 })]);

    const u = await snapshot();
    assert.equal(u.open_rooms, 2);
    assert.equal(u.players_in_rooms, 6); // 5 + (2 - 1 removed)
    assert.equal(u.est_connections, 6 + 2 * 2 + 1); // players + host & presenter per room + 1 TV
    assert.deepEqual(u.rooms.map((r) => [r.id, r.players, r.tvs]), [[big, 5, 1], [small, 1, 0]]);
    assert.equal(Number(u.storage_bytes), 4096);
    // Busiest moment: all three games overlapped while players joined (11 players incl. the removed one's span, 3 rooms).
    assert.ok(u.peak_7d_connections >= 6 + 2 * 2, `peak ${u.peak_7d_connections}`);
  });

  it("is read-only: calling it changes nothing", async () => {
    const before = (await db.query<{ v: string }>("select string_agg(id::text || state_version::text, ',' order by id) v from public.games")).rows[0].v;
    await snapshot();
    const after = (await db.query<{ v: string }>("select string_agg(id::text || state_version::text, ',' order by id) v from public.games")).rows[0].v;
    assert.equal(after, before);
  });
});
