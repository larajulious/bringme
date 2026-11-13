import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";

import { generatePlayerToken, hashToken } from "../../lib/players/token.ts";
import { as, createDb, createUser, errorOf, subscribe } from "./harness.ts";

// Migration 20261113000003: public TV links (audience-safe presenter screen, no sign-in).
let db: PGlite;
let host: string;
let other: string;
const svc = { role: "service_role" } as const;
const user = (sub: string) => ({ role: "authenticated", sub }) as const;
const TOKEN = /^[23456789abcdefghjkmnpqrstuvwxyz]{12}$/;

before(async () => {
  db = await createDb();
  host = await createUser(db, "tv-host@example.com");
  other = await createUser(db, "tv-other@example.com");
  for (const u of [host, other]) await subscribe(db, u, { plan: "pro" });
});
after(async () => { await db.close(); });

const ver = async (id: string) => Number((await db.query<{ v: string }>("select state_version::text v from public.games where id=$1", [id])).rows[0].v);
const act = async (id: string, action: string) =>
  as(db, user(host), async () => db.query("select public.game_transition($1,$2,$3,null)", [id, action, await ver(id)]));
async function newGame(owner = host) {
  await db.query("update public.games set status='canceled' where owner_id=$1 and status in ('draft','lobby','live')", [owner]);
  return as(db, user(owner), async () => (await db.query<{ game_id: string; code: string }>(
    "select * from public.create_game_with_rounds('tv', $1)", [["secret item", "second item"]])).rows[0]);
}
const link = (game: string, reset = false, sub = host) =>
  as(db, user(sub), async () => (await db.query<{ t: string }>("select public.screen_link($1,$2) t", [game, reset])).rows[0].t);
const screen = (token: string) =>
  as(db, svc, async () => (await db.query<{ s: Record<string, unknown> | null }>("select public.screen_state($1) s", [token])).rows[0].s);
const canListen = (claims: Record<string, unknown>, topic: string) =>
  as(db, { role: "anon", claims }, async () => (await db.query<{ ok: boolean }>("select public.can_listen_game_topic($1) ok", [topic])).rows[0].ok);

describe("TV links", () => {
  it("the owner gets one stable token; reset replaces it; other hosts and drafts are refused", async () => {
    const g = await newGame();
    const t1 = await link(g.game_id);
    assert.match(t1, TOKEN);
    assert.equal(await link(g.game_id), t1, "same link on every click");
    const t2 = await link(g.game_id, true);
    assert.match(t2, TOKEN);
    assert.notEqual(t2, t1);
    assert.match((await errorOf(link(g.game_id, false, other))) ?? "", /game_not_found/);
    // test setup only: a published game can't go back to draft (triggers off for this one write)
    await db.exec("set session_replication_role = replica");
    await db.query("update public.games set status='draft' where id=$1", [g.game_id]);
    await db.exec("set session_replication_role = default");
    assert.match((await errorOf(link(g.game_id, true))) ?? "", /game_not_open/);
  });

  it("clients can't read the token table or the TV snapshot; anon can't create links", async () => {
    const g = await newGame();
    await link(g.game_id);
    assert.match((await errorOf(as(db, user(host), () => db.query("select * from public.game_screens")))) ?? "", /permission denied/);
    assert.match((await errorOf(as(db, { role: "anon" }, () => db.query("select * from public.game_screens")))) ?? "", /permission denied/);
    assert.match((await errorOf(as(db, user(host), () => db.query("select public.screen_state('abcdefghjkmn')")))) ?? "", /permission denied/);
    assert.match((await errorOf(as(db, { role: "anon" }, () => db.query("select public.screen_link($1)", [g.game_id])))) ?? "", /permission denied/);
  });

  it("the snapshot is the presenter view: join code + roster fingerprint, the item only after GO; old/malformed tokens get nothing", async () => {
    const g = await newGame();
    const t = await link(g.game_id);
    const lobby = await screen(t);
    assert.equal(lobby?.gameType, "bring_me");
    assert.equal(lobby?.gameId, g.game_id);
    assert.equal(lobby?.joinCode, g.code);
    assert.equal(typeof lobby?.rosterKey, "string");

    await as(db, svc, () => db.query("select * from public.join_game($1,'Ann',$2,null)", [g.code, hashToken(generatePlayerToken())]));
    for (const a of ["start_game", "start_countdown", "start_round"]) await act(g.game_id, a);
    const counting = (await screen(t))?.round as { prompt: string | null; openedAt: string } | null;
    assert.ok(counting);
    if (Date.parse(counting.openedAt) > Date.now()) assert.equal(counting.prompt, null, "no item during the countdown");
    await db.query("update public.game_rounds set opened_at = clock_timestamp() - interval '1 second' where game_id=$1 and status='open'", [g.game_id]);
    assert.equal(((await screen(t))?.round as { prompt: string }).prompt, "secret item");

    const fresh = await link(g.game_id, true);
    assert.equal(await screen(t), null, "a reset link stops working at once");
    assert.ok(await screen(fresh));
    assert.equal(await screen("not-a-token"), null);
    assert.equal(await screen("ABCDEFGHJKMN"), null);
  });

  it("Realtime: a screen token may listen to both topics of its game only while the link is current", async () => {
    const g = await newGame();
    const t = await link(g.game_id);
    const main = `game:${g.game_id}`;
    const hostTopic = `${main}:host`;
    const claims = { kind: "screen", game_id: g.game_id, screen_token: t };
    assert.equal(await canListen(claims, main), true);
    assert.equal(await canListen(claims, hostTopic), true);

    const otherGame = await newGame(other);
    await link(otherGame.game_id, false, other);
    assert.equal(await canListen(claims, `game:${otherGame.game_id}`), false, "not another game's topics");
    assert.equal(await canListen({ ...claims, screen_token: "abcdefghjkmn" }, main), false, "a guessed token");
    assert.equal(await canListen({ kind: "guest", game_id: g.game_id }, hostTopic), false, "guests still never get the host topic");

    await link(g.game_id, true);
    assert.equal(await canListen(claims, main), false, "reset cuts off the old TV");
    assert.equal(await canListen(claims, hostTopic), false);
  });
});
