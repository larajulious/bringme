import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";

import { generatePlayerToken, hashToken } from "../../lib/players/token.ts";
import { as, createDb, createUser, errorOf, subscribe } from "./harness.ts";

// Phase 2 (migration 20261113000002): every hint carries a scope; host-only hints go to game:<id>:host.
type Hint = { topic: string; event: string; private: boolean; payload: { version: number; phase: string; scope: string } };

let db: PGlite;
let host: string;
let other: string;
const svc = { role: "service_role" } as const;
const user = (sub: string) => ({ role: "authenticated", sub }) as const;
const uuid = () => crypto.randomUUID();
const META = JSON.stringify({ syncRttMs: 40, syncAgeMs: 2000 });

before(async () => {
  db = await createDb();
  host = await createUser(db, "rt-host@example.com");
  other = await createUser(db, "rt-other@example.com");
  for (const u of [host, other]) await subscribe(db, u, { plan: "pro" });
});
after(async () => { await db.close(); });

const ver = async (id: string) => Number((await db.query<{ v: string }>("select state_version::text v from public.games where id=$1", [id])).rows[0].v);
const act = async (id: string, action: string, winner: string | null = null, owner = host) =>
  as(db, user(owner), async () => db.query("select public.game_transition($1,$2,$3,$4)", [id, action, await ver(id), winner]));
const hints = async (gameId: string) => (await db.query<Hint>(
  "select topic, event, private, payload from realtime.messages where topic in ($1, $2) order by id", [`game:${gameId}`, `game:${gameId}:host`])).rows;
const clear = () => db.query("delete from realtime.messages");
/** [topic kind, scope] of each hint since the last clear(). */
const routes = async (gameId: string) => (await hints(gameId)).map((h) => [h.topic.endsWith(":host") ? "host-topic" : "game-topic", h.payload.scope]);
const hostView = (id: string, sub = host) => as(db, user(sub), async () =>
  (await db.query<{ s: Record<string, unknown> }>("select public.host_game_state($1) s", [id])).rows[0].s);

type Game = { id: string; code: string; tokens: Record<string, string>; ids: Record<string, string> };
async function lobby(names: string[], owner = host): Promise<Game> {
  await db.query("update public.games set status='canceled' where owner_id=$1 and status in ('draft','lobby','live')", [owner]);
  const g = await as(db, user(owner), async () => (await db.query<{ game_id: string; code: string }>("select * from public.create_game_with_rounds('rt', $1)", [["a", "b"]])).rows[0]);
  const out: Game = { id: g.game_id, code: g.code, tokens: {}, ids: {} };
  for (const n of names) await join(out, n);
  return out;
}
async function join(g: Game, name: string) {
  g.tokens[name] = generatePlayerToken();
  g.ids[name] = (await as(db, svc, () => db.query<{ player_id: string }>("select * from public.join_game($1,$2,$3,null)", [g.code, name, hashToken(g.tokens[name])]))).rows[0].player_id;
}
async function liveRound(g: Game) {
  for (const a of ["start_game", "start_countdown", "start_round"]) await act(g.id, a);
  await db.query("update public.game_rounds set opened_at = clock_timestamp() - interval '3 seconds' where game_id=$1 and status='open'", [g.id]);
  return (await db.query<{ r: string }>("select current_round_id r from public.games where id=$1", [g.id])).rows[0].r;
}
async function submit(g: Game, name: string, round: string) {
  const a = uuid();
  await as(db, svc, () => db.query(`select public.begin_submission($1,$2,$3,2950,'${META}')`, [hashToken(g.tokens[name]), round, a]));
  return as(db, svc, async () => (await db.query<{ r: { status: string } }>("select public.complete_submission($1,$2,$3,'{}') r", [hashToken(g.tokens[name]), round, a])).rows[0].r);
}
const subId = async (round: string, playerId: string) =>
  (await db.query<{ id: string }>("select id from public.submissions where round_id=$1 and player_id=$2", [round, playerId])).rows[0].id;
const reviewSub = (id: string, decision: string) => as(db, user(host), () => db.query("select public.review_submission($1,$2)", [id, decision]));

describe("Bring Me: who each hint is for", () => {
  it("joins are 'roster', a removal is 'all', and every hint is private, minimal and version-stamped", async () => {
    const g = await lobby([]);
    await clear();
    await join(g, "Ann"); await join(g, "Bo"); await join(g, "Cy");
    await as(db, user(host), () => db.query("update public.players set kicked_at = now() where id=$1", [g.ids.Bo]));
    const hs = await hints(g.id);
    assert.deepEqual(await routes(g.id), [["game-topic", "roster"], ["game-topic", "roster"], ["game-topic", "roster"], ["game-topic", "all"]]);
    assert.ok(hs.every((h) => h.private && h.event === "state" && Object.keys(h.payload).sort().join() === "phase,scope,version"));
    const vs = hs.map((h) => h.payload.version);
    assert.deepEqual(vs, [...vs].sort((a, b) => a - b), "versions strictly increase");
    assert.equal(new Set(vs).size, vs.length);
    assert.equal(vs.at(-1), await ver(g.id));
  });

  it("submissions and review decisions go ONLY to the host topic; every phase change reaches everyone", async () => {
    const g = await lobby(["Ann", "Bo"]);
    await clear();
    const round = await liveRound(g);
    assert.equal((await submit(g, "Ann", round)).status, "accepted");
    assert.equal((await submit(g, "Bo", round)).status, "accepted");
    await reviewSub(await subId(round, g.ids.Ann), "approve");
    await reviewSub(await subId(round, g.ids.Bo), "disqualify");
    await act(g.id, "close_submissions");
    await act(g.id, "move_to_review");
    await act(g.id, "announce_winner", g.ids.Ann);
    await act(g.id, "next_round");
    await act(g.id, "end_game");
    assert.deepEqual(await routes(g.id), [
      ["game-topic", "all"], ["game-topic", "all"], ["game-topic", "all"],          // start, countdown, round open
      ["host-topic", "host"], ["host-topic", "host"],                                // two photos
      ["host-topic", "host"], ["host-topic", "host"],                                // two review decisions
      ["game-topic", "all"], ["game-topic", "all"], ["game-topic", "all"],          // close, review, winner
      ["game-topic", "all"], ["game-topic", "all"],                                  // next round, game over
    ]);
    const hs = await hints(g.id);
    const vs = hs.map((h) => h.payload.version);
    assert.deepEqual(vs, [...vs].sort((a, b) => a - b), "one version sequence across both topics");
    assert.equal(new Set(vs).size, vs.length);
    // a player re-reading at any 'all' hint gets a snapshot at least that new (host-only bumps included)
    const lastAll = hs.filter((h) => h.payload.scope === "all").at(-1)!;
    assert.equal(lastAll.payload.version, await ver(g.id), "the game-over hint carries the final version");
    await clear();
    await errorOf(reviewSub(await subId(round, g.ids.Ann), "reset"));
    assert.equal((await hints(g.id)).length, 0, "a finished game sends nothing more");
  });

  it("a winner announcement and the end of a game are never host-only", async () => {
    const g = await lobby(["Ann"]);
    const round = await liveRound(g);
    await submit(g, "Ann", round);
    await reviewSub(await subId(round, g.ids.Ann), "approve");
    for (const a of ["close_submissions", "move_to_review"]) await act(g.id, a);
    await clear();
    await act(g.id, "announce_winner", g.ids.Ann);
    await act(g.id, "end_game");
    assert.deepEqual(await routes(g.id), [["game-topic", "all"], ["game-topic", "all"]]);
    assert.deepEqual((await hints(g.id)).map((h) => h.payload.phase), ["winner_announced", "finished"]);
  });

  it("removing a player DURING a round, cancelling, adding or replaying a round reach everyone", async () => {
    const g = await lobby(["Ann", "Bo"]);
    const round = await liveRound(g);
    await clear();
    await as(db, user(host), () => db.query("update public.players set kicked_at = now() where id=$1", [g.ids.Bo]));
    await as(db, user(host), () => db.query("select public.add_game_round($1,'a late extra item')", [g.id]));
    await act(g.id, "close_submissions");   // replay is offered once photos stopped
    await as(db, user(host), async () => db.query("select public.replay_round($1,$2)", [g.id, await ver(g.id)]));
    await act(g.id, "cancel");
    assert.ok((await routes(g.id)).every(([t, s]) => t === "game-topic" && s === "all"), JSON.stringify(await routes(g.id)));
    assert.equal((await hints(g.id)).length, 5);
    assert.notEqual((await db.query<{ r: string }>("select current_round_id r from public.games where id=$1", [g.id])).rows[0].r, round, "replay switched rounds");
  });

  it("a rejected action or a duplicate photo sends nothing", async () => {
    const g = await lobby(["Ann"]);
    const round = await liveRound(g);
    await submit(g, "Ann", round);
    await clear();
    const a = uuid();
    await as(db, svc, () => db.query(`select public.begin_submission($1,$2,$3,1,'${META}')`, [hashToken(g.tokens.Ann), round, a]));
    await errorOf(act(g.id, "start_round"));
    await errorOf(as(db, user(host), () => db.query("select public.game_transition($1,'close_submissions',99999,null)", [g.id])));
    assert.equal((await hints(g.id)).length, 0);
  });

  it("two games never share hints: each game's events stay on its own topics", async () => {
    const g1 = await lobby(["Ann"], host);
    const g2 = await lobby(["Zed"], other);
    await clear();
    const r1 = await liveRound(g1);
    await submit(g1, "Ann", r1);
    await join(g2, "Yan");
    const t1 = (await hints(g1.id)).map((h) => h.topic), t2 = (await hints(g2.id)).map((h) => h.topic);
    assert.ok(t1.length === 4 && t1.every((t) => t.startsWith(`game:${g1.id}`)));
    assert.deepEqual(t2, [`game:${g2.id}`]);
    const all = (await db.query<{ topic: string }>("select topic from realtime.messages")).rows.map((r) => r.topic);
    assert.equal(all.length, t1.length + t2.length, "nothing on any other topic");
  });
});

describe("host topic authorization", () => {
  it("only the owning host may listen to game:<id>:host; guests, other hosts and visitors may not; nobody may publish", async () => {
    const g = await lobby(["Ann"]);
    const can = (actor: Parameters<typeof as>[1], topic: string) => as(db, actor, async () =>
      (await db.query<{ ok: boolean }>("select public.can_listen_game_topic($1) ok", [topic])).rows[0].ok);
    const guest = { role: "anon", claims: { kind: "guest", game_id: g.id, sub: g.ids.Ann } } as const;
    const hostTopic = `game:${g.id}:host`;
    assert.equal(await can(user(host), hostTopic), true, "owner");
    assert.equal(await can(user(other), hostTopic), false, "another host");
    assert.equal(await can(guest, hostTopic), false, "a guest of THIS game");
    assert.equal(await can({ role: "anon", claims: { kind: "guest", game_id: `${g.id}:host` } }, hostTopic), false, "a forged game_id claim");
    assert.equal(await can({ role: "anon" }, hostTopic), false, "a visitor");
    assert.equal(await can(guest, `game:${g.id}`), true, "the guest keeps its own game's topic");
    for (const t of [`game:${g.id}:hostx`, `game:${g.id}:HOST`, `game:${g.id}:host:x`, `xgame:${g.id}:host`]) {
      assert.equal(await can(user(host), t), false, `malformed topic ${t}`);
    }
    // through the actual realtime.messages policy, as Realtime evaluates it
    const round = await liveRound(g);
    await submit(g, "Ann", round);
    const listen = (actor: Parameters<typeof as>[1]) => as(db, actor, async () => {
      await db.query("select set_config('realtime.topic', $1, false)", [hostTopic]);
      return (await db.query("select 1 from realtime.messages where topic = $1", [hostTopic])).rows.length;
    });
    assert.ok((await listen(user(host))) > 0);
    assert.equal(await listen(guest), 0);
    assert.equal(await listen(user(other)), 0);
    assert.match((await errorOf(as(db, user(host), () => db.query("insert into realtime.messages (topic, event, payload) values ($1,'state','{}')", [hostTopic])))) ?? "", /row-level security|permission denied/i);
  });

  it("the new internals are not callable by clients", async () => {
    for (const sql of [
      "select public.broadcast_game(gen_random_uuid(), 1, 'lobby', 'host')",
      "select public.bump_game_version(gen_random_uuid(), 'all')",
      "select public.host_sync_keys(gen_random_uuid(), 'host')",
    ]) {
      for (const actor of [user(host), { role: "anon" } as const]) {
        assert.match((await errorOf(as(db, actor, () => db.query(sql)))) ?? "", /permission denied/i, sql);
      }
    }
  });
});

describe("host snapshot fingerprints", () => {
  it("rosterKey changes on joins and removals only; submissionsKey on photos, reviews and removals only", async () => {
    const g = await lobby(["Ann", "Bo"]);
    const k0 = await hostView(g.id);
    await join(g, "Cy");
    const k1 = await hostView(g.id);
    assert.notEqual(k1.rosterKey, k0.rosterKey, "a join changes the roster");
    const round = await liveRound(g);
    const k2 = await hostView(g.id);
    assert.equal(k2.rosterKey, k1.rosterKey, "phase changes don't");
    await submit(g, "Ann", round);
    const k3 = await hostView(g.id);
    assert.equal(k3.rosterKey, k2.rosterKey, "a photo doesn't change the roster");
    assert.notEqual(k3.submissionsKey, k2.submissionsKey, "…but changes the submissions list");
    await reviewSub(await subId(round, g.ids.Ann), "approve");
    const k4 = await hostView(g.id);
    assert.notEqual(k4.submissionsKey, k3.submissionsKey, "a review decision changes it");
    await reviewSub(await subId(round, g.ids.Ann), "reset");
    await reviewSub(await subId(round, g.ids.Ann), "approve");
    assert.equal((await hostView(g.id)).submissionsKey, k4.submissionsKey, "same rows, same statuses -> same key (it fingerprints content)");
    await as(db, user(host), () => db.query("update public.players set kicked_at = now() where id=$1", [g.ids.Ann]));
    const k5 = await hostView(g.id);
    assert.notEqual(k5.rosterKey, k4.rosterKey);
    assert.notEqual(k5.submissionsKey, k4.submissionsKey, "a removed player's photo leaves the list");
  });

  it("host action responses carry the fingerprints too; player snapshots never do", async () => {
    const g = await lobby(["Ann"]);
    const res = await as(db, user(host), async () => (await db.query<{ s: Record<string, unknown> }>("select public.game_transition($1,'start_game',$2,null) s", [g.id, await ver(g.id)])).rows[0].s);
    assert.equal(typeof res.rosterKey, "string");
    assert.equal(typeof res.submissionsKey, "string");
    const p = await as(db, svc, async () => (await db.query<{ s: Record<string, unknown> }>("select public.player_game_state($1) s", [hashToken(g.tokens.Ann)])).rows[0].s);
    assert.ok(!("rosterKey" in p) && !("submissionsKey" in p));
    assert.equal(p.version, res.version);
  });
});

describe("BingoSnap: claims and validations", () => {
  const engine = async (sql: string, params: unknown[] = []) => {
    await db.query("select set_config('bingosnap.engine','on',false)");
    try { await db.query(sql, params); } finally { await db.query("select set_config('bingosnap.engine','off',false)"); }
  };
  type Snap = { version: number; phase: string; me: { id: string; layout: { pos: number; cellId: string }[] | null; submissions: { id: string; status: string }[] } };
  const state = (t: string) => as(db, svc, async () => (await db.query<{ s: Snap }>("select public.bingo_player_state($1) s", [hashToken(t)])).rows[0].s);
  const claim = (t: string, ids: string[]) => as(db, svc, async () => (await db.query<{ s: Snap }>("select public.bingo_submit_claim($1,$2::uuid[],$3::uuid) s", [hashToken(t), ids, uuid()])).rows[0].s);
  const review = (sub: string, d: string) => as(db, user(host), () => db.query("select public.bingo_review_submission($1,$2,null)", [sub, d]));
  const row0 = (s: Snap) => s.me.layout!.filter((c) => c.pos < 3).map((c) => c.cellId);

  async function bingo(names: string[]) {
    await engine("update public.games set status='canceled' where owner_id=$1 and status in ('draft','lobby','live')", [host]);
    const s = await as(db, user(host), async () => (await db.query<{ s: { gameId: string } }>(
      "select public.bingo_save_board(null,0,'RT',3,'traditional',false,600,'ranked',$1,true) s", [Array.from({ length: 9 }, (_, i) => `t${i}`)])).rows[0].s);
    const id = s.gameId;
    const code = (await db.query<{ c: string }>("select join_code c from public.games where id=$1", [id])).rows[0].c;
    const tokens: string[] = [];
    for (const n of names) { const t = generatePlayerToken(); await as(db, svc, () => db.query("select * from public.join_game($1,$2,$3,null)", [code, n, hashToken(t)])); tokens.push(t); }
    await as(db, user(host), async () => db.query("select public.bingo_start($1,$2)", [id, await ver(id)]));
    await engine("update public.bingo_games set hunt_ends_at = now() + interval '300 seconds', hunt_started_at = now() + interval '300 seconds' - make_interval(secs => duration_seconds) where game_id=$1", [id]);
    return { id, tokens };
  }

  it("a claim is host-only; its review is 'claims' (only players holding a claim re-read); results reach everyone", async () => {
    const { id, tokens } = await bingo(["Ann", "Bo"]);
    await clear();
    const out = await claim(tokens[0], row0(await state(tokens[0])));
    assert.equal(out.me.submissions[0].status, "pending", "the claimant gets its own answer directly");
    await review(out.me.submissions[0].id, "verify");
    await review(out.me.submissions[0].id, "reset");
    await review(out.me.submissions[0].id, "reject");
    await as(db, user(host), async () => db.query("select public.bingo_transition($1,'close_hunt',$2)", [id, await ver(id)]));
    await as(db, user(host), async () => db.query("select public.bingo_transition($1,'announce_results',$2)", [id, await ver(id)]));
    assert.deepEqual(await routes(id), [
      ["host-topic", "host"],
      ["game-topic", "claims"], ["game-topic", "claims"], ["game-topic", "claims"],
      ["game-topic", "all"], ["game-topic", "all"],
    ]);
    const ann = await state(tokens[0]);
    assert.equal(ann.me.submissions[0].status, "rejected", "the claimant's re-read shows the decision");
    assert.equal(ann.version, await ver(id));
  });

  it("a review that also settles an expired hunt (active -> reviewing) is sent to everyone", async () => {
    const { id, tokens } = await bingo(["Ann", "Bo"]);
    const out = await claim(tokens[0], row0(await state(tokens[0])));
    await engine("update public.bingo_games set hunt_ends_at = now() - interval '10 seconds' where game_id=$1", [id]);
    await clear();
    await review(out.me.submissions[0].id, "verify");
    assert.deepEqual(await routes(id), [["game-topic", "all"]]);
    assert.equal((await hints(id))[0].payload.phase, "reviewing");
  });
});
