import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";

import { generatePlayerToken, hashToken } from "../../lib/players/token.ts";
import { as, createDb, createUser, endCurrentPass, errorOf } from "./harness.ts";

type State = {
  version: number; status: string; phase: string; countdownEndsAt: string | null; serverNow: string;
  roundsRemaining: number; playerCount: number; totalRounds: number;
  round: null | { no: number; status: string; prompt: string | null; openedAt: string | null; winnerName: string | null; winnerPlayerId: string | null };
  me?: { id: string; nickname: string; kicked: boolean; isWinner: boolean };
};

let db: PGlite;
let host: string;
let other: string;
const svc = { role: "service_role" } as const;
const user = (sub: string) => ({ role: "authenticated", sub }) as const;

before(async () => {
  db = await createDb();
  host = await createUser(db, "engine-host@example.com");
  other = await createUser(db, "engine-other@example.com");
  for (const u of [host, other]) {
    await as(db, svc, () => db.query("select public.admin_set_subscription($1,'activate','pro',30,null)", [u]));
  }
});
after(async () => { await db.close(); });

type G = { id: string; code: string; tokens: Record<string, string>; ids: Record<string, string> };

/** A lobby with players Ann/Bo/Cy and the given round items. */
async function newGame(owner = host, items = ["a red shoe", "something round"], names = ["Ann", "Bo", "Cy"]): Promise<G> {
  // free the plan's open-game slots used by earlier tests (superuser: trigger-validated)
  await db.query("update public.games set status='canceled' where owner_id=$1 and status in ('draft','lobby','live')", [owner]);
  const g = await as(db, user(owner), async () =>
    (await db.query<{ game_id: string; code: string }>("select * from public.create_game_with_rounds('Engine test', $1)", [items])).rows[0]);
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  for (const n of names) {
    tokens[n] = generatePlayerToken();
    const r = await as(db, svc, () => db.query<{ player_id: string }>("select * from public.join_game($1,$2,$3,null)", [g.code, n, hashToken(tokens[n])]));
    ids[n] = r.rows[0].player_id;
  }
  return { id: g.game_id, code: g.code, tokens, ids };
}

const ver = async (id: string) => Number((await db.query<{ v: string }>("select state_version::text v from public.games where id=$1", [id])).rows[0].v);
const act = async (g: G, action: string, opts: { winner?: string | null; expected?: number; sub?: string } = {}) => {
  const v = opts.expected ?? (await ver(g.id));
  return as(db, user(opts.sub ?? host), async () =>
    (await db.query<{ s: State }>("select public.game_transition($1,$2,$3,$4) as s", [g.id, action, v, opts.winner ?? null])).rows[0].s);
};
const playerView = async (g: G, who = "Ann") =>
  (await as(db, svc, () => db.query<{ s: State }>("select public.player_game_state($1) as s", [hashToken(g.tokens[who])]))).rows[0].s;
const hostView = async (g: G) =>
  (await as(db, user(host), () => db.query<{ s: State }>("select public.host_game_state($1) as s", [g.id]))).rows[0].s;

/** A photo from `who` in the current round, approved by the host (the only way to become the winner). */
async function approvedPhoto(g: G, who: string, elapsedMs: number) {
  await db.query("update public.game_rounds set opened_at = clock_timestamp() - ($2 || ' milliseconds')::interval where id=(select current_round_id from public.games where id=$1)", [g.id, String(elapsedMs + 40)]);
  const round = (await db.query<{ id: string }>("select current_round_id id from public.games where id=$1", [g.id])).rows[0].id;
  const attempt = crypto.randomUUID();
  const h = hashToken(g.tokens[who]);
  await as(db, svc, () => db.query("select public.begin_submission($1,$2,$3,$4,'{}')", [h, round, attempt, elapsedMs]));
  await as(db, svc, () => db.query("select public.complete_submission($1,$2,$3,'{}')", [h, round, attempt]));
  const sub = (await db.query<{ id: string }>("select id from public.submissions where round_id=$1 and player_id=$2", [round, g.ids[who]])).rows[0].id;
  await as(db, user(host), () => db.query("select public.review_submission($1,'approve')", [sub]));
  return sub;
}

const ALL = ["start_game", "start_countdown", "start_round", "close_submissions", "move_to_review", "announce_winner", "next_round", "end_game"];
/** Everything except `valid` must be rejected, and must leave the state untouched. */
async function assertOnly(g: G, valid: string[], label: string) {
  for (const a of ALL.filter((x) => !valid.includes(x))) {
    const before = await ver(g.id);
    const e = await errorOf(act(g, a));
    assert.match(e ?? "", /invalid_transition|no_players|no_rounds_left/, `${label}: ${a} must be rejected (got: ${e})`);
    assert.equal(await ver(g.id), before, `${label}: rejected ${a} must not change state`);
  }
}

describe("state machine: happy path", () => {
  it("walks lobby → countdown → active → reviewing → winner_announced → next round → finished", async () => {
    const g = await newGame();
    let s = await hostView(g);
    assert.deepEqual([s.status, s.phase, s.playerCount, s.totalRounds], ["lobby", "lobby", 3, 2]);
    const versions = [s.version];
    const step = async (action: string, expectPhase: string, opts: { winner?: string | null } = {}) => {
      s = await act(g, action, opts);
      assert.equal(s.phase, expectPhase, action);
      assert.ok(s.version > versions[versions.length - 1], `${action} must bump the version`);
      versions.push(s.version);
      return s;
    };

    s = await step("start_game", "lobby");
    assert.equal(s.status, "live");

    s = await step("start_countdown", "countdown");
    assert.ok(s.countdownEndsAt, "server-generated countdown end");
    const ahead = Date.parse(s.countdownEndsAt!) - Date.parse(s.serverNow);
    assert.ok(ahead > 3500 && ahead <= 5100, `countdown ≈5s ahead of the server clock (got ${ahead}ms)`);
    assert.equal(s.round?.status, "pending");
    assert.equal((await playerView(g)).round?.prompt ?? null, null, "item hidden from players during the countdown");

    s = await step("start_round", "active");
    assert.equal(s.round?.status, "open");
    assert.ok(Date.parse(s.round!.openedAt!) >= Date.parse(s.countdownEndsAt!) - 5, "official start is not before the countdown ends");
    assert.equal((await playerView(g)).round?.prompt ?? null, null, "still hidden before the official start");
    assert.equal(s.round?.prompt, "a red shoe", "the host always sees it");

    // time passes: the official start moment arrives
    await db.query("update public.game_rounds set opened_at = clock_timestamp() - interval '1 second' where id=(select current_round_id from public.games where id=$1)", [g.id]);
    assert.equal((await playerView(g)).round?.prompt, "a red shoe", "revealed once the official start has passed");
    await approvedPhoto(g, "Bo", 600); // the winner needs an approved photo

    s = await step("close_submissions", "active");
    assert.equal(s.round?.status, "closed");
    s = await step("move_to_review", "reviewing");
    s = await step("announce_winner", "winner_announced", { winner: g.ids.Bo });
    assert.equal(s.round?.winnerName, "Bo");
    assert.equal((await playerView(g, "Bo")).me?.isWinner, true);
    assert.equal((await playerView(g, "Ann")).me?.isWinner, false);

    s = await step("next_round", "lobby");
    assert.equal(s.round, null, "back to waiting for the next round");
    assert.equal(s.status, "live");
    assert.equal(s.roundsRemaining, 1);

    s = await step("start_countdown", "countdown");
    assert.equal(s.round?.no, 2);
    s = await step("start_round", "active");
    await db.query("update public.game_rounds set opened_at = clock_timestamp() - interval '1 second' where status='open' and game_id=$1", [g.id]);
    s = await step("close_submissions", "active");
    s = await step("move_to_review", "reviewing");
    s = await step("announce_winner", "winner_announced", { winner: null });
    assert.equal(s.round?.winnerName, null, "no winner is allowed");
    assert.match((await errorOf(act(g, "next_round"))) ?? "", /no_rounds_left/);

    s = await step("end_game", "finished");
    assert.equal(s.status, "finished");
    assert.equal((await playerView(g)).phase, "finished");
    assert.deepEqual(versions, [...versions].sort((a, b) => a - b), "versions only ever increase");
  });
});

describe("state machine: invalid and out-of-order transitions", () => {
  it("allows only the valid action(s) from each phase", async () => {
    const g = await newGame();
    await assertOnly(g, ["start_game"], "lobby (not started)");
    await act(g, "start_game");
    await assertOnly(g, ["start_countdown", "end_game"], "live, waiting");
    await act(g, "start_countdown");
    await assertOnly(g, ["start_round", "end_game"], "countdown");
    await act(g, "start_round");
    await db.query("update public.game_rounds set opened_at = clock_timestamp() - interval '1 second' where status='open' and game_id=$1", [g.id]);
    await assertOnly(g, ["close_submissions", "end_game"], "active (open)");
    await act(g, "close_submissions");
    await assertOnly(g, ["move_to_review", "end_game"], "active (closed)");
    await act(g, "move_to_review");
    await assertOnly(g, ["announce_winner", "end_game"], "reviewing");
    await act(g, "announce_winner");
    await assertOnly(g, ["next_round", "end_game"], "winner_announced");
    await act(g, "end_game");
    await assertOnly(g, [], "finished");
  });

  it("cannot start without players or without rounds, and unknown actions are rejected", async () => {
    const empty = await newGame(host, ["x"], []);
    assert.match((await errorOf(act(empty, "start_game"))) ?? "", /no_players/);
    assert.match((await errorOf(act(empty, "dance"))) ?? "", /invalid_action/);
    assert.equal(await errorOf(act(empty, "cancel")), null, "an empty lobby can be cancelled");
  });

  it("announce_winner is the fastest APPROVED photo of this game's active players; anything else is refused", async () => {
    const g = await newGame();
    const g2 = await newGame(other, ["x"], ["Zed"]);
    await act(g, "start_game"); await act(g, "start_countdown"); await act(g, "start_round");
    await approvedPhoto(g, "Cy", 500); // Cy is fastest...
    await approvedPhoto(g, "Ann", 900);
    await act(g, "close_submissions"); await act(g, "move_to_review");
    assert.match((await errorOf(act(g, "announce_winner", { winner: g2.ids.Zed }))) ?? "", /winner_mismatch/, "player of another game");
    assert.match((await errorOf(act(g, "announce_winner", { winner: crypto.randomUUID() }))) ?? "", /winner_mismatch/);
    assert.match((await errorOf(act(g, "announce_winner", { winner: g.ids.Ann }))) ?? "", /winner_mismatch/, "not the fastest approved");
    assert.match((await errorOf(act(g, "announce_winner"))) ?? "", /winner_mismatch/, "'no winner' while an approved photo exists");
    await as(db, user(host), () => db.query("update public.players set kicked_at=now() where id=$1", [g.ids.Cy]));
    assert.match((await errorOf(act(g, "announce_winner", { winner: g.ids.Cy }))) ?? "", /winner_mismatch/, "removed players can't win");
    assert.equal(await errorOf(act(g, "announce_winner", { winner: g.ids.Ann })), null, "with Cy removed, Ann is the fastest eligible");
  });
});

describe("duplicate and stale Game Master requests", () => {
  it("the same request twice: the second is rejected as stale and changes nothing", async () => {
    const g = await newGame();
    const v = await ver(g.id);
    await act(g, "start_game", { expected: v });
    const after = await hostView(g);
    assert.match((await errorOf(act(g, "start_game", { expected: v }))) ?? "", /stale_state/);
    const strip = (x: State) => ({ ...x, serverNow: undefined });
    assert.deepEqual(strip(await hostView(g)), strip(after));
  });

  it("starting the same round twice (double click / two tabs) opens it exactly once", async () => {
    const g = await newGame();
    await act(g, "start_game"); await act(g, "start_countdown");
    const v = await ver(g.id);
    const first = await act(g, "start_round", { expected: v });
    const second = await errorOf(act(g, "start_round", { expected: v }));
    assert.match(second ?? "", /stale_state/);
    const open = await db.query<{ n: string }>("select count(*)::text n from public.game_rounds where game_id=$1 and status='open'", [g.id]);
    assert.equal(open.rows[0].n, "1");
    assert.equal((await hostView(g)).version, first.version, "the loser did not bump the version");
    // even with a FRESH version, a second start_round is not a valid transition any more
    assert.match((await errorOf(act(g, "start_round"))) ?? "", /invalid_transition/);
  });

  it("a replayed old request cannot move the game after it has progressed", async () => {
    const g = await newGame();
    const v0 = await ver(g.id);
    await act(g, "start_game", { expected: v0 });
    await act(g, "start_countdown");
    assert.match((await errorOf(act(g, "start_countdown", { expected: v0 }))) ?? "", /stale_state/);
    assert.equal((await hostView(g)).phase, "countdown");
  });

  it("the database itself allows only one open round per game (backstop)", async () => {
    const g = await newGame();
    await act(g, "start_game"); await act(g, "start_countdown"); await act(g, "start_round");
    const e = await errorOf(db.query("update public.game_rounds set status='open' where game_id=$1 and status='pending'", [g.id]));
    assert.match(e ?? "", /game_rounds_one_open_per_game|duplicate key|round_limit|invalid_round_transition|unique/i);
  });
});

describe("authorization", () => {
  it("only the owning Game Master can transition; guests and other hosts cannot", async () => {
    const g = await newGame();
    assert.match((await errorOf(act(g, "start_game", { sub: other }))) ?? "", /game_not_found/);
    assert.match((await errorOf(as(db, { role: "anon" }, () => db.query("select public.game_transition($1,'start_game',0,null)", [g.id])))) ?? "", /permission denied/i);
    assert.match((await errorOf(as(db, svc, () => db.query("select public.game_transition($1,'start_game',0,null)", [g.id])))) ?? "", /permission denied|unauthenticated/i, "not even the service role: it has no host identity");
    assert.match((await errorOf(as(db, user(other), () => db.query("select public.host_game_state($1)", [g.id])))) ?? "", /game_not_found/);
  });

  it("clients cannot write status, phase or version directly", async () => {
    const g = await newGame();
    await as(db, user(host), async () => {
      for (const col of ["phase='active'", "state_version=999", "status='live'", "countdown_ends_at=now()", "current_round_id=null"]) {
        assert.match((await errorOf(db.query(`update public.games set ${col} where id=$1`, [g.id]))) ?? "", /permission denied/i, col);
      }
      assert.match((await errorOf(db.query("update public.game_rounds set status='open' where game_id=$1", [g.id]))) ?? "", /permission denied/i);
      assert.match((await errorOf(db.query("update public.game_rounds set winner_player_id=$2 where game_id=$1", [g.id, g.ids.Ann]))) ?? "", /permission denied/i);
    });
  });

  it("status and phase can never disagree", async () => {
    const g = await newGame();
    assert.match((await errorOf(db.query("update public.games set phase='active' where id=$1", [g.id]))) ?? "", /games_status_phase_check|check constraint/i);
  });

  it("a pass that expires mid-game never interrupts the live game (Game Pass D-10), but blocks new games", async () => {
    const u = await createUser(db, "engine-lapsing@example.com");
    await as(db, svc, () => db.query("select public.admin_set_subscription($1,'activate','pro',30,null)", [u]));
    const g = await newGame(u, ["a"], ["Dee"]);
    await act(g, "start_game", { sub: u });
    await endCurrentPass(db, u);
    assert.equal(await errorOf(act(g, "start_countdown", { sub: u })), null, "rounds created before the start can still be played");
    assert.match((await errorOf(as(db, user(u), () => db.query("insert into public.games (owner_id, title) values ($1,'late')", [u])))) ?? "",
      /subscription_required/, "no new games without a pass");
    assert.equal(await errorOf(act(g, "end_game", { sub: u })), null);
  });
});

describe("players: joining, reconnecting, refresh", () => {
  it("new players can join only before the game starts; existing players always restore", async () => {
    const g = await newGame();
    await act(g, "start_game");
    const join = (name: string, tok: string, existing: string | null) =>
      as(db, svc, () => db.query<{ restored: boolean }>("select * from public.join_game($1,$2,$3,$4)", [g.code, name, hashToken(tok), existing ? hashToken(existing) : null]));
    assert.match((await errorOf(join("Late", generatePlayerToken(), null))) ?? "", /game_not_joinable/);
    const back = await join("Ann", generatePlayerToken(), g.tokens.Ann);
    assert.equal(back.rows[0].restored, true, "a player who refreshed or lost connection is restored");
    assert.equal(Number((await db.query<{ n: string }>("select count(*)::text n from public.players where game_id=$1", [g.id])).rows[0].n), 3, "no duplicates");
  });

  it("a refresh at any point reads back the same authoritative state", async () => {
    const g = await newGame();
    await act(g, "start_game"); await act(g, "start_countdown");
    const a = await playerView(g), b = await playerView(g, "Cy");
    assert.deepEqual([a.phase, a.version, a.countdownEndsAt], [b.phase, b.version, b.countdownEndsAt], "all devices agree");
    assert.equal(a.me?.nickname, "Ann");
    assert.equal(b.me?.nickname, "Cy");
    await act(g, "start_round");
    await db.query("update public.game_rounds set opened_at = clock_timestamp() - interval '2 seconds' where status='open' and game_id=$1", [g.id]);
    const again = await playerView(g);
    assert.deepEqual([again.phase, again.round?.status, again.round?.prompt], ["active", "open", "a red shoe"]);
  });

  it("removed players see themselves as kicked and are excluded from the count", async () => {
    const g = await newGame();
    await as(db, user(host), () => db.query("update public.players set kicked_at=now() where id=$1", [g.ids.Bo]));
    const s = await playerView(g, "Bo");
    assert.equal(s.me?.kicked, true);
    assert.equal(s.playerCount, 2);
  });

  it("the version rises when players join or are removed, so lobby counts can't be overwritten by older data", async () => {
    const g = await newGame(host, ["x"], ["Ann"]);
    const v1 = await ver(g.id);
    await as(db, svc, () => db.query("select * from public.join_game($1,'Newbie',$2,null)", [g.code, hashToken(generatePlayerToken())]));
    const v2 = await ver(g.id);
    await as(db, user(host), () => db.query("update public.players set kicked_at=now() where game_id=$1 and nickname='Newbie'", [g.id]));
    const v3 = await ver(g.id);
    assert.ok(v1 < v2 && v2 < v3, `${v1} < ${v2} < ${v3}`);
  });
});

describe("Realtime broadcast + channel authorization", () => {
  it("every transition broadcasts a private, version-stamped, payload-minimal message", async () => {
    const g = await newGame();
    await db.query("delete from realtime.messages");
    await act(g, "start_game"); await act(g, "start_countdown"); await act(g, "start_round");
    const rows = (await db.query<{ topic: string; event: string; private: boolean; payload: { version: number; phase: string; prompt?: string } }>(
      "select topic, event, private, payload from realtime.messages order by id")).rows;
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.topic === `game:${g.id}` && r.event === "state" && r.private === true));
    assert.deepEqual(rows.map((r) => r.payload.phase), ["lobby", "countdown", "active"]);
    const versions = rows.map((r) => r.payload.version);
    assert.deepEqual(versions, [...versions].sort((a, b) => a - b));
    assert.ok(rows.every((r) => !("prompt" in r.payload)), "no game content travels over the broadcast");
    assert.equal(versions[2], (await hostView(g)).version, "the last broadcast carries the authoritative version");
  });

  it("a rejected transition broadcasts nothing", async () => {
    const g = await newGame();
    await db.query("delete from realtime.messages");
    await errorOf(act(g, "start_round"));
    await errorOf(act(g, "start_game", { expected: 12345 }));
    assert.equal((await db.query("select 1 from realtime.messages")).rows.length, 0);
  });

  it("a broadcast failure never fails the transition (the DB stays authoritative)", async () => {
    const g = await newGame();
    await db.exec("alter function realtime.send(jsonb, text, text, boolean) rename to send_off; create function realtime.send(jsonb, text, text, boolean) returns void language plpgsql as $$ begin raise exception 'realtime down'; end $$; grant execute on function realtime.send(jsonb, text, text, boolean) to service_role, authenticated, anon;");
    try {
      const s = await act(g, "start_game");
      assert.equal(s.status, "live");
    } finally {
      await db.exec("drop function realtime.send(jsonb, text, text, boolean); alter function realtime.send_off(jsonb, text, text, boolean) rename to send;");
    }
  });

  it("who may listen: the owning host and guests holding that game's token, nobody else; nobody may publish", async () => {
    const g = await newGame();
    const g2 = await newGame(other, ["x"], ["Zed"]);
    await act(g, "start_game");
    const listen = (actor: Parameters<typeof as>[1], game: string) =>
      as(db, actor, async () => {
        await db.query("select set_config('realtime.topic', $1, false)", [`game:${game}`]);
        return (await db.query("select 1 from realtime.messages where topic = $1", [`game:${game}`])).rows.length;
      });
    const guest = (gameId: string) => ({ role: "anon", claims: { kind: "guest", game_id: gameId, sub: crypto.randomUUID() } }) as const;

    assert.ok((await listen(user(host), g.id)) > 0, "owner can listen");
    assert.equal(await listen(user(other), g.id), 0, "another host cannot");
    assert.ok((await listen(guest(g.id), g.id)) > 0, "a guest of this game can");
    assert.equal(await listen(guest(g2.id), g.id), 0, "a guest of another game cannot");
    assert.equal(await listen({ role: "anon" }, g.id), 0, "an unauthenticated visitor cannot");
    assert.equal(await listen({ role: "anon", claims: { kind: "host", game_id: g.id } }, g.id), 0, "claims must say guest");
    for (const actor of [user(host), guest(g.id)]) {
      assert.match((await errorOf(as(db, actor, () => db.query("insert into realtime.messages (topic, event, payload) values ($1,'state','{}')", [`game:${g.id}`])))) ?? "", /row-level security|permission denied/i, "no client can publish");
    }
  });
});
