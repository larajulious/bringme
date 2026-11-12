import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";

import { generatePlayerToken, hashToken } from "../../lib/players/token.ts";
import { as, createDb, createUser, endCurrentPass, errorOf, subscribe } from "./harness.ts";

let db: PGlite;
let alice: string; // subscriber A
let bob: string; // subscriber B
let expired: string; // subscriber with an expired plan
let gameA: string;
let gameB: string;
let roundA: string;
let roundB: string;
let playerA: string; // in game A
let playerB: string; // in game B
let tokenA: string; // raw token of playerA (only the hash is stored)

const asUser = (sub: string) => ({ role: "authenticated", sub }) as const;

/** Phase 7: status/phase may only change through game_transition(). */
const version = async (game: string) =>
  Number((await db.query<{ v: string }>("select state_version::text v from public.games where id=$1", [game])).rows[0].v);
const transition = async (sub: string, game: string, action: string, winner: string | null = null, expected?: number) => {
  const v = expected ?? (await version(game)); // read as superuser: a non-owner could not see the row
  return as(db, asUser(sub), async () =>
    (await db.query<{ s: Record<string, unknown> }>("select public.game_transition($1,$2,$3,$4) as s", [game, action, v, winner])).rows[0].s);
};

before(async () => {
  db = await createDb();
  alice = await createUser(db, "alice@example.com");
  bob = await createUser(db, "bob@example.com");
  expired = await createUser(db, "late@example.com");
  await subscribe(db, alice);
  await subscribe(db, bob);
  await subscribe(db, expired, {
    start: new Date(Date.now() - 60 * 86_400_000).toISOString(),
    end: new Date(Date.now() - 86_400_000).toISOString(),
  });

  // Alice and Bob each own a live game with one open round and one player.
  for (const [owner, label] of [[alice, "A"], [bob, "B"]] as const) {
    const g = await as(db, asUser(owner), async () =>
      (await db.query<{ id: string }>(
        "insert into public.games (owner_id, title) values ($1, $2) returning id",
        [owner, `Game ${label}`],
      )).rows[0].id);
    const r = await as(db, asUser(owner), async () =>
      (await db.query<{ id: string }>(
        `insert into public.game_rounds (game_id, round_no, prompt) values ($1, 1, 'Bring me a shoe') returning id`,
        [g],
      )).rows[0].id);
    await db.query("update public.games set status='lobby' where id=$1", [g]);
    // Guest join happens server-side with the service role.
    const tok = generatePlayerToken();
    if (label === "A") tokenA = tok;
    const p = await as(db, { role: "service_role" }, async () =>
      (await db.query<{ id: string }>(
        "insert into public.players (game_id, nickname, token_hash) values ($1, $2, $3) returning id",
        [g, `guest-${label}`, hashToken(tok)],
      )).rows[0].id);
    await db.query("update public.games set status='live' where id=$1", [g]);
    await db.query("update public.game_rounds set status='open' where id=$1", [r]);
    await db.query("update public.games set phase='active', current_round_id=$2 where id=$1", [g, r]);
    // Phase 8: a submission can only exist after an intent recorded at tap time.
    await db.query("insert into public.submission_intents (game_id, round_id, player_id, attempt_id, claimed_elapsed_ms) values ($1,$2,$3,gen_random_uuid(),500)", [g, r, p]);
    if (label === "A") { gameA = g; roundA = r; playerA = p; } else { gameB = g; roundB = r; playerB = p; }
  }
});

after(async () => { await db.close(); });

describe("subscriber isolation", () => {
  it("Subscriber A cannot read Subscriber B's games or related records", async () => {
    await as(db, asUser(alice), async () => {
      const games = await db.query<{ id: string }>("select id from public.games");
      assert.deepEqual(games.rows.map((r) => r.id), [gameA]);
      for (const [table, id] of [
        ["game_rounds", gameB], ["players", gameB], ["submissions", gameB],
      ] as const) {
        const r = await db.query(`select 1 from public.${table} where ${table === "game_rounds" || table === "players" || table === "submissions" ? "game_id" : "id"} = $1`, [id]);
        assert.equal(r.rows.length, 0, `${table} of game B must be invisible`);
      }
    });
  });

  it("Subscriber A cannot modify or delete Subscriber B's game, rounds or players", async () => {
    await as(db, asUser(alice), async () => {
      const upd = await db.query("update public.games set title='pwned' where id=$1", [gameB]);
      assert.equal(upd.affectedRows, 0);
      const rnd = await db.query("update public.game_rounds set prompt='pwned' where game_id=$1", [gameB]);
      assert.equal(rnd.affectedRows, 0);
      const kick = await db.query("update public.players set kicked_at=now() where game_id=$1", [gameB]);
      assert.equal(kick.affectedRows, 0);
      assert.match((await errorOf(db.query("delete from public.games where id=$1", [gameB]))) ?? "", /permission denied/i);
    });
    const still = await db.query<{ title: string }>("select title from public.games where id=$1", [gameB]);
    assert.equal(still.rows[0].title, "Game B");
  });

  it("Subscriber A cannot create a game or round owned by/for Subscriber B", async () => {
    await as(db, asUser(alice), async () => {
      const g = await errorOf(db.query("insert into public.games (owner_id, title) values ($1,'x')", [bob]));
      assert.match(g ?? "", /row-level security/i);
      const r = await errorOf(db.query(
        "insert into public.game_rounds (game_id, round_no, prompt) values ($1, 9, 'x')", [gameB]));
      assert.match(r ?? "", /row-level security|rounds can only/i);
    });
  });

  it("Subscriber A cannot read player token hashes (even in their own game)", async () => {
    await as(db, asUser(alice), async () => {
      const e = await errorOf(db.query("select token_hash from public.players"));
      assert.match(e ?? "", /permission denied/i);
      const star = await errorOf(db.query("select * from public.players"));
      assert.match(star ?? "", /permission denied/i);
    });
  });

  it("Subscriber A cannot read Subscriber B's photos in storage", async () => {
    const path = `${gameB}/${roundB}/${playerB}.jpg`;
    await db.query("insert into storage.objects (bucket_id, name) values ('submissions', $1)", [path]);
    await db.query("insert into storage.objects (bucket_id, name) values ('submissions', $1)",
      [`${gameA}/${roundA}/${playerA}.jpg`]);
    await as(db, asUser(alice), async () => {
      const r = await db.query<{ name: string }>("select name from storage.objects where bucket_id='submissions'");
      assert.deepEqual(r.rows.map((x) => x.name), [`${gameA}/${roundA}/${playerA}.jpg`]);
      const w = await errorOf(db.query("insert into storage.objects (bucket_id, name) values ('submissions', $1)", [`${gameA}/${roundA}/${playerB}.jpg`]));
      assert.match(w ?? "", /row-level security/i, "clients can never write photos directly");
    });
  });
});

describe("guest players (no Supabase Auth)", () => {
  it("a guest (anon role) has no access to any game table", async () => {
    await as(db, { role: "anon" }, async () => {
      for (const t of ["games", "game_rounds", "players", "submissions", "subscriptions", "profiles"]) {
        const e = await errorOf(db.query(`select * from public.${t}`));
        assert.match(e ?? "", /permission denied/i, `anon must not read ${t}`);
      }
    });
  });

  it("a guest cannot control a game (start, finish, open rounds, kick, score)", async () => {
    await as(db, { role: "anon" }, async () => {
      for (const sql of [
        `update public.games set status='finished'`,
        `update public.game_rounds set status='closed'`,
        `update public.players set kicked_at=now()`,
        `update public.submissions set points_awarded=100`,
        `delete from public.games`,
        `insert into public.games (owner_id, title) values ('${alice}', 'x')`,
      ]) {
        assert.match((await errorOf(db.query(sql))) ?? "", /permission denied/i, sql);
      }
    });
    // Same for a random signed-in user who does not own the game.
    await as(db, asUser(expired), async () => {
      assert.match((await errorOf(db.query("update public.games set status='finished' where id=$1", [gameA]))) ?? "", /permission denied/i);
      assert.match((await errorOf(transition(expired, gameA, "end_game", null, 0))) ?? "", /game_not_found/);
    });
  });

  it("a guest cannot insert players or submissions via the client API", async () => {
    await as(db, { role: "anon" }, async () => {
      assert.match((await errorOf(db.query(
        "insert into public.players (game_id, nickname, token_hash) values ($1,'x',$2)", [gameA, "a".repeat(64)]))) ?? "", /permission denied/i);
      assert.match((await errorOf(db.query(
        "insert into public.submissions (game_id, round_id, player_id, storage_path) values ($1,$2,$3,'x')", [gameA, roundA, playerA]))) ?? "", /permission denied/i);
    });
  });

  it("a guest token only ever resolves to its own player; wrong/forged tokens match nothing", async () => {
    const mine = tokenA;
    await as(db, { role: "service_role" }, async () => {
      const ok = await db.query<{ id: string }>("select id from public.players where token_hash=$1", [hashToken(mine)]);
      assert.equal(ok.rows[0].id, playerA);
      const forged = await db.query("select 1 from public.players where token_hash=$1", [hashToken(generatePlayerToken())]);
      assert.equal(forged.rows.length, 0);
      // The raw token itself is never stored.
      const raw = await db.query("select 1 from public.players where token_hash=$1", [mine]);
      assert.equal(raw.rows.length, 0);
    });
  });

  it("a guest cannot submit for a player of another game (cross-game forgery)", async () => {
    // Server bug / forged body: player from game B, round from game A.
    const e = await errorOf(as(db, { role: "service_role" }, () => db.query(
      "insert into public.submissions (game_id, round_id, player_id, storage_path) values ($1,$2,$3,$4)",
      [gameA, roundA, playerB, `${gameA}/${roundA}/${playerB}.jpg`])));
    assert.match(e ?? "", /foreign key|violates|intent_required/i);
  });

  it("a storage path pointing at someone else's folder is rejected by constraint", async () => {
    const e = await errorOf(as(db, { role: "service_role" }, () => db.query(
      "insert into public.submissions (game_id, round_id, player_id, storage_path) values ($1,$2,$3,$4)",
      [gameA, roundA, playerA, `${gameB}/${roundB}/${playerB}.jpg`])));
    assert.match(e ?? "", /check constraint/i);
  });

  it("a guest cannot submit twice in one round", async () => {
    const path = `${gameA}/${roundA}/${playerA}.jpg`;
    const insert = () => as(db, { role: "service_role" }, () => db.query(
      "insert into public.submissions (game_id, round_id, player_id, storage_path) values ($1,$2,$3,$4)",
      [gameA, roundA, playerA, path]));
    assert.equal(await errorOf(insert()), null, "first submission succeeds");
    assert.match((await errorOf(insert())) ?? "", /duplicate key|unique/i, "second is rejected by the DB");
  });

  it("submissions are rejected once the round is closed", async () => {
    await db.query("update public.game_rounds set status='closed' where id=$1", [roundB]);
    // the tap happened AFTER the round closed: not a straggler
    await db.query("delete from public.submission_intents where round_id=$1", [roundB]);
    await db.query("insert into public.submission_intents (game_id, round_id, player_id, attempt_id, claimed_elapsed_ms) values ($1,$2,$3,gen_random_uuid(),500)", [gameB, roundB, playerB]);
    const e = await errorOf(as(db, { role: "service_role" }, () => db.query(
      "insert into public.submissions (game_id, round_id, player_id, storage_path) values ($1,$2,$3,$4)",
      [gameB, roundB, playerB, `${gameB}/${roundB}/${playerB}.jpg`])));
    assert.match(e ?? "", /round_not_open/);
  });
});

describe("roles", () => {
  it("public signup cannot grant Super Admin via client metadata", async () => {
    const sneaky = await createUser(db, "sneaky@example.com", { role: "super_admin", user_role: "super_admin", is_super_admin: true });
    const p = await db.query<{ role: string }>("select role from public.profiles where id=$1", [sneaky]);
    assert.equal(p.rows[0].role, "subscriber");
    await as(db, asUser(sneaky), async () => {
      const r = await db.query<{ ok: boolean }>("select public.is_super_admin() as ok");
      assert.equal(r.rows[0].ok, false);
    });
  });

  it("a user cannot promote themselves through a profile update", async () => {
    await as(db, asUser(alice), async () => {
      const e = await errorOf(db.query("update public.profiles set role='super_admin' where id=$1", [alice]));
      assert.match(e ?? "", /permission denied/i);
      const ok = await db.query("update public.profiles set display_name='Alice' where id=$1", [alice]);
      assert.equal(ok.affectedRows, 1, "harmless fields remain editable");
    });
    const p = await db.query<{ role: string }>("select role from public.profiles where id=$1", [alice]);
    assert.equal(p.rows[0].role, "subscriber");
  });

  it("a user cannot insert a profile with an elevated role", async () => {
    await as(db, asUser(alice), async () => {
      const e = await errorOf(db.query("insert into public.profiles (id, role) values (gen_random_uuid(), 'super_admin')"));
      assert.match(e ?? "", /permission denied/i);
    });
  });

  it("the role trigger blocks role changes from any non-trusted DB role", async () => {
    // Even if someone later widens column grants by mistake, the trigger holds.
    await db.exec("grant update (role) on public.profiles to authenticated");
    try {
      await as(db, asUser(alice), async () => {
        const e = await errorOf(db.query("update public.profiles set role='super_admin' where id=$1", [alice]));
        assert.match(e ?? "", /trusted server/i);
      });
    } finally {
      await db.exec("revoke update (role) on public.profiles from authenticated");
    }
  });

  it("only trusted roles (service role / SQL editor) can set super_admin, and admin reads work", async () => {
    const boss = await createUser(db, "boss@example.com");
    await as(db, { role: "service_role" }, () => db.query("update public.profiles set role='super_admin' where id=$1", [boss]));
    await as(db, asUser(boss), async () => {
      assert.equal((await db.query("select 1 from public.games")).rows.length, 2, "admin can read all games");
      assert.equal((await db.query("update public.games set title='x'")).affectedRows, 0, "but cannot write through RLS");
    });
  });
});

describe("subscription entitlement", () => {
  it("expired subscriber cannot create a game", async () => {
    await as(db, asUser(expired), async () => {
      const e = await errorOf(db.query("insert into public.games (owner_id, title) values ($1,'late')", [expired]));
      assert.match(e ?? "", /subscription_required/);
    });
  });

  it("user without any subscription cannot create a game", async () => {
    const free = await createUser(db, "nosub@example.com");
    await as(db, asUser(free), async () => {
      assert.match((await errorOf(db.query("insert into public.games (owner_id, title) values ($1,'x')", [free]))) ?? "", /subscription_required/);
    });
  });

  it("a subscriber whose plan expires after drafting cannot start the game, but can cancel it", async () => {
    const u = await createUser(db, "lapsing@example.com");
    await subscribe(db, u);
    const g = await as(db, asUser(u), async () => (await db.query<{ game_id: string }>(
      "select * from public.create_game_with_rounds('lapse', array['a'])")).rows[0].game_id);
    await as(db, { role: "service_role" }, () => db.query("insert into public.players (game_id, nickname, token_hash) values ($1,'p',$2)", [g, hashToken(generatePlayerToken())]));
    await endCurrentPass(db, u);
    assert.match((await errorOf(transition(u, g, "start_game"))) ?? "", /subscription_required/);
    assert.equal(await errorOf(transition(u, g, "cancel")), null);
  });

  it("a stale 'active' status after the period end does not entitle (time-based expiry)", async () => {
    const r = await db.query("select * from public.entitlement_for($1)", [expired]);
    assert.equal(r.rows.length, 0);
  });

  it("an expired subscriber cannot add rounds, and cannot bypass via the service role", async () => {
    const e = await errorOf(as(db, { role: "service_role" }, () => db.query(
      "insert into public.games (owner_id, title) values ($1,'x')", [expired])));
    assert.match(e ?? "", /subscription_required/, "triggers bind the service role too");
  });

  it("clients cannot grant themselves a subscription", async () => {
    await as(db, asUser(expired), async () => {
      const e = await errorOf(db.query(
        "insert into public.subscriptions (user_id, plan_id, current_period_end) select $1, id, now() + interval '1 year' from public.subscription_plans limit 1", [expired]));
      assert.match(e ?? "", /permission denied/i);
    });
  });

  it("plan limits are enforced (active games and players are capped)", async () => {
    const u = await createUser(db, "starter@example.com");
    await subscribe(db, u, { plan: "starter" }); // 1 active game, 10 players
    await as(db, asUser(u), async () => {
      await db.query("insert into public.games (owner_id, title, max_players) values ($1,'one',500)", [u]);
      assert.match((await errorOf(db.query("insert into public.games (owner_id, title) values ($1,'two')", [u]))) ?? "", /game_limit_reached/);
      const mp = await db.query<{ max_players: number }>("select max_players from public.games where owner_id=$1", [u]);
      assert.equal(mp.rows[0].max_players, 10, "max_players capped to plan");
    });
  });
});

describe("game state machine", () => {
  it("rejects invalid transitions and edits to closed games", async () => {
    assert.match((await errorOf(db.query("update public.games set status='draft' where id=$1", [gameB]))) ?? "", /invalid_game_transition/);
    assert.equal(await errorOf(db.query("update public.games set status='finished' where id=$1", [gameB])), null);
    assert.equal((await db.query<{ phase: string }>("select phase from public.games where id=$1", [gameB])).rows[0].phase, "finished", "phase follows status");
    await as(db, asUser(bob), async () => {
      assert.match((await errorOf(db.query("update public.games set title='again' where id=$1", [gameB]))) ?? "", /game_is_closed/);
    });
  });
});

describe("access status and manual activation (Phase 3)", () => {
  const status = (sub: string) =>
    as(db, asUser(sub), async () =>
      (await db.query<{ state: string; plan_code: string | null }>("select * from public.my_access_status()")).rows[0]);
  const admin = (user: string, action: string, plan: string | null = null, days: number | null = null) =>
    as(db, { role: "service_role" }, () =>
      db.query("select public.admin_set_subscription($1,$2,$3,$4)", [user, action, plan, days]));

  it("a brand-new signup is 'pending' and cannot create games", async () => {
    const u = await createUser(db, "fresh@example.com");
    assert.equal((await status(u)).state, "pending");
    await as(db, asUser(u), async () => {
      assert.match((await errorOf(db.query("insert into public.games (owner_id, title) values ($1,'x')", [u]))) ?? "", /subscription_required/);
    });
  });

  it("admin activation makes the subscriber 'active' and able to host", async () => {
    const u = await createUser(db, "activate-me@example.com");
    assert.equal(await errorOf(admin(u, "activate", "party", 30)), null);
    assert.equal((await status(u)).state, "active");
    await as(db, asUser(u), async () => {
      assert.equal(await errorOf(db.query("insert into public.games (owner_id, title) values ($1,'x')", [u])), null);
    });
  });

  it("suspension blocks creating and starting games; reactivation restores access", async () => {
    const u = await createUser(db, "suspend-me@example.com");
    await admin(u, "activate", "party", 30);
    const g = await as(db, asUser(u), async () => (await db.query<{ id: string }>(
      "insert into public.games (owner_id, title) values ($1,'d') returning id", [u])).rows[0].id);
    await admin(u, "suspend");
    assert.equal((await status(u)).state, "suspended");
    await as(db, asUser(u), async () => {
      assert.match((await errorOf(db.query("insert into public.games (owner_id, title) values ($1,'y')", [u]))) ?? "", /subscription_required/);
    });
    assert.match((await errorOf(db.query("update public.games set status='lobby' where id=$1", [g]))) ?? "", /subscription_required/, "the DB trigger blocks it even for trusted roles");
    await admin(u, "activate", "party", 7);
    assert.equal((await status(u)).state, "active");
    // Game Pass: re-activation lifts the suspension and adds a (queued) pass; the ledger keeps both.
    const passes = await db.query("select 1 from public.game_passes where user_id=$1", [u]);
    assert.equal(passes.rows.length, 2, "both grants are kept as passes");
    assert.equal((await db.query("select 1 from public.profiles where id=$1 and hosting_suspended_at is null", [u])).rows.length, 1);
  });

  it("an ended subscription reads as 'expired'", async () => {
    assert.equal((await status(expired)).state, "expired");
  });

  it("activation validates plan, days, action and target", async () => {
    const u = await createUser(db, "validate@example.com");
    assert.match((await errorOf(admin(u, "activate", "nope", 30))) ?? "", /unknown_plan/);
    assert.match((await errorOf(admin(u, "activate", "party", 9999))) ?? "", /invalid_days/);
    assert.match((await errorOf(admin(u, "suspend"))) ?? "", /no_live_subscription/);
    assert.match((await errorOf(admin(u, "frobnicate"))) ?? "", /invalid_action/);
    assert.match((await errorOf(admin(randomUuid(), "activate", "party", 30))) ?? "", /user_not_found/);
  });

  it("only the service role can run activation; clients and anon cannot", async () => {
    const u = await createUser(db, "self-activate@example.com");
    for (const actor of [asUser(u), { role: "anon" } as const]) {
      const e = await errorOf(as(db, actor, () => db.query("select public.admin_set_subscription($1,'activate','party',30)", [u])));
      assert.match(e ?? "", /permission denied/i);
    }
  });

  it("the subscriber list is visible to super admins only", async () => {
    const boss = await createUser(db, "boss2@example.com");
    await as(db, { role: "service_role" }, () => db.query("update public.profiles set role='super_admin' where id=$1", [boss]));
    const rows = await as(db, asUser(boss), async () => (await db.query("select * from public.admin_list_subscribers()")).rows);
    assert.ok(rows.length >= 3);
    assert.ok(rows.every((r) => !("token_hash" in (r as object))));
    const e = await errorOf(as(db, asUser(alice), () => db.query("select * from public.admin_list_subscribers()")));
    assert.match(e ?? "", /forbidden/);
    assert.match((await errorOf(as(db, { role: "anon" }, () => db.query("select * from public.admin_list_subscribers()")))) ?? "", /permission denied/i);
  });
});

function randomUuid() {
  return crypto.randomUUID();
}

describe("admin dashboard data (Phase 4)", () => {
  const adminRpc = (user: string, action: string, plan: string | null = null, days: number | null = null, expires: string | null = null) =>
    as(db, { role: "service_role" }, () =>
      db.query("select public.admin_set_subscription($1,$2,$3,$4,$5)", [user, action, plan, days, expires]));
  let boss: string;

  before(async () => {
    boss = await createUser(db, "overview-boss@example.com");
    await as(db, { role: "service_role" }, () => db.query("update public.profiles set role='super_admin' where id=$1", [boss]));
  });

  it("overview metrics come from real rows and are admin-only", async () => {
    const o = await as(db, asUser(boss), async () => (await db.query<Record<string, string>>("select * from public.admin_overview()")).rows[0]);
    const games = await db.query<{ n: string }>("select count(*)::text n from public.games");
    assert.equal(Number(o.total_games), Number(games.rows[0].n));
    const total = Number(o.total_subscribers);
    const parts = ["active", "pending", "expired", "suspended", "deactivated"].reduce((n, k) => n + Number(o[`${k}_subscribers`]), 0);
    assert.equal(parts, total, "every subscriber is in exactly one state");
    assert.ok(Number(o.active_rooms) >= 0 && Number(o.completed_games) >= 0);
    assert.match((await errorOf(as(db, asUser(alice), () => db.query("select * from public.admin_overview()")))) ?? "", /forbidden/);
    assert.match((await errorOf(as(db, { role: "anon" }, () => db.query("select * from public.admin_overview()")))) ?? "", /permission denied/i);
  });

  it("subscriber list supports search, state filter and pagination", async () => {
    for (let i = 0; i < 3; i++) await createUser(db, `page-test-${i}@example.com`);
    const list = (search: string | null, state: string | null, limit = 20, offset = 0) =>
      as(db, asUser(boss), async () => (await db.query<{ email: string; state: string; total_count: string }>(
        "select * from public.admin_list_subscribers($1,$2,$3,$4)", [search, state, limit, offset])).rows);
    const found = await list("page-test", null);
    assert.equal(found.length, 3);
    assert.equal(Number(found[0].total_count), 3);
    const page = await list("page-test", null, 2, 2);
    assert.equal(page.length, 1);
    assert.equal(Number(page[0].total_count), 3, "total reflects the filter, not the page");
    assert.equal((await list("page_test", null)).length, 0, "_ is literal, not a wildcard");
    assert.equal((await list("%", null)).length, 0, "% is literal");
    assert.ok((await list(null, "pending")).every((r) => r.state === "pending"));
    assert.match((await errorOf(list(null, "bogus"))) ?? "", /invalid_state/);
  });

  it("admin can assign a plan, change expiry, and inactive plans cannot be assigned", async () => {
    const u = await createUser(db, "plan-change@example.com");
    await adminRpc(u, "activate", "starter", 30);
    await adminRpc(u, "set_plan", "pro");
    const p = await db.query<{ code: string }>("select plan_code as code from public.entitlement_for($1)", [u]);
    assert.equal(p.rows[0].code, "pro");

    const end = new Date(Date.now() + 90 * 86_400_000).toISOString();
    await adminRpc(u, "set_expiry", null, null, end);
    const e = await db.query<{ ok: boolean }>("select current_period_end > now() + interval '89 days' as ok from public.entitlement_for($1)", [u]);
    assert.equal(e.rows[0].ok, true);
    assert.match((await errorOf(adminRpc(u, "set_expiry", null, null, new Date(Date.now() - 400 * 86_400_000).toISOString()))) ?? "", /invalid_expiry/);
    assert.match((await errorOf(adminRpc(u, "set_expiry", null, null, new Date(Date.now() + 9 * 365 * 86_400_000).toISOString()))) ?? "", /invalid_expiry/);

    await db.query("update public.subscription_plans set is_active=false where code='pro'");
    assert.match((await errorOf(adminRpc(u, "set_plan", "pro"))) ?? "", /unknown_plan/);
    await db.query("update public.subscription_plans set is_active=true where code='pro'");

    const none = await createUser(db, "no-sub@example.com");
    assert.match((await errorOf(adminRpc(none, "set_plan", "pro"))) ?? "", /no_subscription/);
  });

  it("deactivated accounts lose entitlement and cannot be activated", async () => {
    const u = await createUser(db, "deactivate-me@example.com");
    await adminRpc(u, "activate", "party", 30);
    await as(db, { role: "service_role" }, () => db.query("select public.admin_set_account_active($1, false)", [u]));
    const st = await as(db, asUser(u), async () => (await db.query<{ state: string }>("select * from public.my_access_status()")).rows[0]);
    assert.equal(st.state, "deactivated");
    await as(db, asUser(u), async () => {
      assert.match((await errorOf(db.query("insert into public.games (owner_id, title) values ($1,'x')", [u]))) ?? "", /subscription_required/);
    });
    assert.match((await errorOf(adminRpc(u, "activate", "party", 30))) ?? "", /account_deactivated/);
    await as(db, { role: "service_role" }, () => db.query("select public.admin_set_account_active($1, true)", [u]));
    await adminRpc(u, "activate", "party", 30);
    assert.equal((await as(db, asUser(u), async () => (await db.query<{ state: string }>("select * from public.my_access_status()")).rows[0])).state, "active");
    // clients cannot toggle it
    assert.match((await errorOf(as(db, asUser(u), () => db.query("select public.admin_set_account_active($1, true)", [u])))) ?? "", /permission denied/i);
    assert.match((await errorOf(as(db, asUser(u), () => db.query("update public.profiles set deactivated_at=null where id=$1", [u])))) ?? "", /permission denied/i);
  });

  it("per-period game cap is enforced and resets when a new period is activated", async () => {
    const u = await createUser(db, "period-cap@example.com");
    await db.query("update public.subscription_plans set max_games_per_period = 2, max_active_games = 10 where code='party'");
    await adminRpc(u, "activate", "party", 30);
    const mk = () => as(db, asUser(u), () => db.query("insert into public.games (owner_id, title) values ($1,'g') returning id", [u]));
    assert.equal(await errorOf(mk()), null);
    assert.equal(await errorOf(mk()), null);
    assert.match((await errorOf(mk())) ?? "", /period_game_limit_reached/);
    // Game Pass: a period is one pass. A new period starts when the next pass activates
    // (a second grant while one is running would only queue after it).
    await endCurrentPass(db, u);
    await adminRpc(u, "activate", "party", 30); // new period
    assert.equal(await errorOf(mk()), null);
    await db.query("update public.subscription_plans set max_games_per_period = null, max_active_games = 3 where code='party'");
  });

  it("hosts cannot delete their own games or rounds, so the per-period cap cannot be reset (Phase 11)", async () => {
    const u = await createUser(db, "cap-reset@example.com");
    await db.query("update public.subscription_plans set max_games_per_period = 2, max_active_games = 10 where code='party'");
    await adminRpc(u, "activate", "party", 30);
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      ids.push((await as(db, asUser(u), () => db.query<{ id: string }>("insert into public.games (owner_id, title) values ($1,'g') returning id", [u]))).rows[0].id);
    }
    await as(db, asUser(u), async () => {
      assert.match((await errorOf(db.query("delete from public.games where id=$1", [ids[0]]))) ?? "", /permission denied/i);
      assert.match((await errorOf(db.query("delete from public.game_rounds where game_id=$1", [ids[0]]))) ?? "", /permission denied/i);
      assert.match((await errorOf(db.query("insert into public.games (owner_id, title) values ($1,'g')", [u]))) ?? "", /period_game_limit_reached/);
    });
    assert.equal(Number((await db.query<{ n: string }>("select count(*) n from public.games where owner_id=$1", [u])).rows[0].n), 2);
    await db.query("update public.subscription_plans set max_games_per_period = null, max_active_games = 3 where code='party'");
  });

  it("platform settings: readable by signed-in users, writable only by trusted roles, photo limit syncs to storage", async () => {
    assert.equal((await as(db, asUser(alice), () => db.query("select * from public.platform_settings"))).rows.length, 1);
    assert.match((await errorOf(as(db, asUser(alice), () => db.query("update public.platform_settings set max_photo_size_mb = 20")))) ?? "", /permission denied/i);
    assert.match((await errorOf(as(db, { role: "anon" }, () => db.query("select * from public.platform_settings")))) ?? "", /permission denied/i);
    assert.match((await errorOf(as(db, { role: "service_role" }, () => db.query("update public.platform_settings set max_photo_size_mb = 99")))) ?? "", /check constraint/i);
    await as(db, { role: "service_role" }, () => db.query("update public.platform_settings set max_photo_size_mb = 8, default_max_players = 12"));
    const b = await db.query<{ file_size_limit: string }>("select file_size_limit::text from storage.buckets where id='submissions'");
    assert.equal(Number(b.rows[0].file_size_limit), 8 * 1048576);
    // Game Pass D-8: a host's room holds what their pass allows (the old "platform default
    // capped by plan" silently limited Party/Pro to 20). The default still applies to super admins' games.
    const u = await createUser(db, "defaults@example.com");
    await adminRpc(u, "activate", "pro", 30);
    const g = await as(db, asUser(u), async () => (await db.query<{ max_players: number }>("insert into public.games (owner_id, title) values ($1,'d') returning max_players", [u])).rows[0]);
    assert.equal(g.max_players, 100);
    const ga = await as(db, asUser(boss), async () => (await db.query<{ max_players: number }>("insert into public.games (owner_id, title) values ($1,'admin') returning max_players", [boss])).rows[0]);
    assert.equal(ga.max_players, 12);
    await as(db, { role: "service_role" }, () => db.query("update public.platform_settings set max_photo_size_mb = 5, default_max_players = 20"));
  });

  it("single-subscriber state is admin-only", async () => {
    const r = await as(db, asUser(boss), async () => (await db.query<{ state: string }>("select * from public.admin_subscriber_state($1)", [expired])).rows[0]);
    assert.equal(r.state, "expired");
    assert.match((await errorOf(as(db, asUser(alice), () => db.query("select * from public.admin_subscriber_state($1)", [expired])))) ?? "", /forbidden/);
  });

  it("plans: clients cannot create or edit them", async () => {
    await as(db, asUser(alice), async () => {
      assert.match((await errorOf(db.query("update public.subscription_plans set price_cents = 0"))) ?? "", /permission denied/i);
      assert.match((await errorOf(db.query("insert into public.subscription_plans (code,name,max_active_games,max_players_per_game,max_rounds_per_game) values ('x1','x',1,2,1)"))) ?? "", /permission denied/i);
    });
  });
});

describe("game creation (Phase 5)", () => {
  const create = (sub: string, title: string | null, items: string[]) =>
    as(db, asUser(sub), async () =>
      (await db.query<{ game_id: string; code: string }>("select * from public.create_game_with_rounds($1,$2)", [title, items])).rows[0]);
  const countGames = async (owner: string) =>
    Number((await db.query<{ n: string }>("select count(*)::text n from public.games where owner_id=$1", [owner])).rows[0].n);
  let host: string;

  before(async () => {
    host = await createUser(db, "host5@example.com");
    await as(db, { role: "service_role" }, () => db.query("select public.admin_set_subscription($1,'activate','pro',30,null)", [host]));
  });

  it("creates the game, all rounds in order, and opens the lobby in one call", async () => {
    const g = await create(host, "Friday night", ["a red shoe", "something round", "a banana"]);
    assert.match(g.code, /^[A-Z0-9]{6}$/);
    const game = (await db.query<{ status: string; owner_id: string; title: string }>("select status, owner_id, title from public.games where id=$1", [g.game_id])).rows[0];
    assert.equal(game.status, "lobby");
    assert.equal(game.owner_id, host);
    assert.equal(game.title, "Friday night");
    const rounds = await db.query<{ round_no: number; prompt: string; status: string }>("select round_no, prompt, status from public.game_rounds where game_id=$1 order by round_no", [g.game_id]);
    assert.deepEqual(rounds.rows.map((r) => [r.round_no, r.prompt, r.status]),
      [[1, "a red shoe", "pending"], [2, "something round", "pending"], [3, "a banana", "pending"]]);
  });

  it("title is optional", async () => {
    const g = await create(host, "  ", ["x"]);
    const t = await db.query<{ title: string }>("select title from public.games where id=$1", [g.game_id]);
    assert.equal(t.rows[0].title, "Untitled game");
  });

  it("room codes are unique across many games", async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 40; i++) {
      await db.query("update public.games set status='canceled' where owner_id=$1 and status='lobby'", [host]); // free active-game slots
      codes.add((await create(host, null, ["x"])).code);
    }
    assert.equal(codes.size, 40);
  });

  it("is all-or-nothing: exceeding the plan's round limit leaves no game behind", async () => {
    await db.query("update public.games set status='canceled' where owner_id=$1 and status='lobby'", [host]);
    const before = await countGames(host);
    const tooMany = Array.from({ length: 41 }, (_, i) => `item ${i}`); // pro allows 40
    assert.match((await errorOf(create(host, "big", tooMany))) ?? "", /round_limit_reached/);
    assert.equal(await countGames(host), before);
  });

  it("rejects empty items/lists and leaves nothing behind", async () => {
    const before = await countGames(host);
    assert.match((await errorOf(create(host, "x", []))) ?? "", /items_required/);
    assert.match((await errorOf(create(host, "x", ["ok", "  "]))) ?? "", /empty_item/);
    assert.equal(await countGames(host), before);
  });

  it("pending, expired and deactivated users cannot create games (and nothing is left half-created)", async () => {
    const pending = await createUser(db, "pending5@example.com");
    assert.match((await errorOf(create(pending, "x", ["a"]))) ?? "", /subscription_required/);
    assert.match((await errorOf(create(expired, "x", ["a"]))) ?? "", /subscription_required/);
    assert.equal(await countGames(pending), 0);
    assert.equal(await countGames(expired), 0);
  });

  it("the owner is always the caller; anon cannot call it", async () => {
    const g = await create(host, "mine", ["a"]);
    const o = await db.query<{ owner_id: string }>("select owner_id from public.games where id=$1", [g.game_id]);
    assert.equal(o.rows[0].owner_id, host);
    assert.match((await errorOf(as(db, { role: "anon" }, () => db.query("select * from public.create_game_with_rounds('x', array['a'])")))) ?? "", /permission denied/i);
  });

  it("ownership: another subscriber cannot see, start, cancel or kick players in this lobby", async () => {
    await db.query("update public.games set status='canceled' where owner_id=$1 and status='lobby'", [host]);
    const g = await create(host, "private", ["a"]);
    const player = await as(db, { role: "service_role" }, async () => (await db.query<{ id: string }>(
      "insert into public.players (game_id, nickname, token_hash) values ($1,'pat',$2) returning id",
      [g.game_id, hashToken(generatePlayerToken())])).rows[0].id);

    await as(db, asUser(bob), async () => {
      assert.equal((await db.query("select 1 from public.games where id=$1", [g.game_id])).rows.length, 0);
      assert.equal((await db.query("select 1 from public.game_rounds where game_id=$1", [g.game_id])).rows.length, 0);
      assert.equal((await db.query("select 1 from public.players where game_id=$1", [g.game_id])).rows.length, 0);
      assert.match((await errorOf(db.query("update public.games set status='live' where id=$1", [g.game_id]))) ?? "", /permission denied/i, "no direct status writes");
      assert.equal((await db.query("update public.players set kicked_at=now() where id=$1", [player])).affectedRows, 0);
    });
    for (const action of ["start_game", "cancel", "end_game"]) {
      assert.match((await errorOf(transition(bob, g.game_id, action))) ?? "", /game_not_found/, `${action} by a non-owner`);
    }

    // The owner can kick; the kicked player's token no longer resolves to a live player.
    await as(db, asUser(host), async () => {
      assert.equal((await db.query("update public.players set kicked_at=now() where id=$1 and game_id=$2", [player, g.game_id])).affectedRows, 1);
      const v = await db.query<{ nickname: string }>("select nickname from public.players where game_id=$1 and kicked_at is null", [g.game_id]);
      assert.equal(v.rows.length, 0);
    });
  });

  it("starting requires an unexpired subscription; the lobby can still be cancelled", async () => {
    const u = await createUser(db, "lapse5@example.com");
    await as(db, { role: "service_role" }, () => db.query("select public.admin_set_subscription($1,'activate','party',30,null)", [u]));
    const g = await create(u, "x", ["a"]);
    await endCurrentPass(db, u);
    await as(db, { role: "service_role" }, () => db.query("insert into public.players (game_id, nickname, token_hash) values ($1,'p',$2)", [g.game_id, hashToken(generatePlayerToken())]));
    assert.match((await errorOf(transition(u, g.game_id, "start_game"))) ?? "", /subscription_required/);
    assert.equal(await errorOf(transition(u, g.game_id, "cancel")), null);
  });
});

describe("guest joining (Phase 6)", () => {
  let host: string;
  let code: string;
  let gid: string;
  const join = (c: string, name: string, token = generatePlayerToken(), existing: string | null = null) =>
    as(db, { role: "service_role" }, () => db.query<{ player_id: string; nickname: string; game_id: string; restored: boolean }>(
      "select * from public.join_game($1,$2,$3,$4)", [c, name, hashToken(token), existing ? hashToken(existing) : null]));

  before(async () => {
    host = await createUser(db, "host6@example.com");
    await as(db, { role: "service_role" }, () => db.query("select public.admin_set_subscription($1,'activate','pro',30,null)", [host]));
    const g = await as(db, asUser(host), async () => (await db.query<{ game_id: string; code: string }>(
      "select * from public.create_game_with_rounds('Friday', array['a','b'])")).rows[0]);
    code = g.code; gid = g.game_id;
    await db.query("update public.games set max_players = 3 where id=$1", [gid]);
  });

  it("room info exposes only title/status/counts, by code (case-insensitive)", async () => {
    const r = await as(db, { role: "service_role" }, async () => (await db.query<{ title: string; status: string; player_count: number; max_players: number }>(
      "select * from public.public_room_info($1)", [code.toLowerCase()])).rows[0]);
    assert.deepEqual([r.title, r.status, Number(r.player_count), r.max_players], ["Friday", "lobby", 0, 3]);
    assert.equal((await as(db, { role: "service_role" }, () => db.query("select * from public.public_room_info('ZZZZZZ')"))).rows.length, 0);
  });

  it("a guest joins, and only the token hash is stored", async () => {
    const t = generatePlayerToken();
    const j = (await join(code, "Ava", t)).rows[0];
    assert.equal(j.restored, false);
    const row = (await db.query<{ token_hash: string }>("select token_hash from public.players where id=$1", [j.player_id])).rows[0];
    assert.equal(row.token_hash, hashToken(t));
    assert.notEqual(row.token_hash, t);
    // reconnect with the same cookie restores the same player: no duplicate
    const again = (await join(code, "Whatever", generatePlayerToken(), t)).rows[0];
    assert.equal(again.restored, true);
    assert.equal(again.player_id, j.player_id);
    assert.equal(again.nickname, "Ava", "the stored name wins; a name is never a credential");
    assert.equal(Number((await db.query<{ n: string }>("select count(*)::text n from public.players where game_id=$1 and nickname='Ava'", [gid])).rows[0].n), 1);
  });

  it("a cookie from another game does not restore anyone there", async () => {
    const other = await as(db, asUser(host), async () => (await db.query<{ game_id: string; code: string }>(
      "select * from public.create_game_with_rounds('Other', array['a'])")).rows[0]);
    const t = generatePlayerToken();
    await join(other.code, "Zed", t);
    const j = (await join(code, "Zoe", generatePlayerToken(), t)).rows[0];
    assert.equal(j.restored, false);
    await db.query("update public.games set status='canceled' where id=$1", [other.game_id]);
  });

  it("names are unique per game case-insensitively, and knowing a name does not give access", async () => {
    assert.match((await errorOf(join(code, "AVA"))) ?? "", /duplicate key|unique/i);
    const state = await as(db, { role: "service_role" }, () => db.query("select public.player_game_state($1)", [hashToken("not-a-real-token")]));
    assert.equal((state.rows[0] as { player_game_state: unknown }).player_game_state, null);
  });

  it("enforces max players and does not count removed players", async () => {
    await join(code, "Cy");
    assert.match((await errorOf(join(code, "Di"))) ?? "", /game_full/);
    const ava = (await db.query<{ id: string }>("select id from public.players where game_id=$1 and nickname='Cy'", [gid])).rows[0].id;
    await as(db, asUser(host), () => db.query("update public.players set kicked_at=now() where id=$1", [ava]));
    assert.equal(await errorOf(join(code, "Di")), null, "a slot frees up after a removal");
  });

  it("a removed player cannot reconnect or re-enter with the same cookie", async () => {
    const t = generatePlayerToken();
    const j = (await join(code, "Ed", t).catch(async () => { // game may be full: free a slot first
      await db.query("update public.players set kicked_at=now() where id=(select id from public.players where game_id=$1 and kicked_at is null and nickname='Di')", [gid]);
      return join(code, "Ed", t);
    })).rows[0];
    await as(db, asUser(host), () => db.query("update public.players set kicked_at=now() where id=$1", [j.player_id]));
    assert.match((await errorOf(join(code, "Ed2", generatePlayerToken(), t))) ?? "", /player_removed/);
    const s = (await as(db, { role: "service_role" }, () => db.query<{ s: { me: { kicked: boolean } } }>("select public.player_game_state($1) as s", [hashToken(t)]))).rows[0].s;
    assert.equal(s.me.kicked, true);
  });

  it("finished and cancelled games cannot be joined; unknown codes 404", async () => {
    const g = await as(db, asUser(host), async () => (await db.query<{ game_id: string; code: string }>(
      "select * from public.create_game_with_rounds('Ends', array['a'])")).rows[0]);
    await db.query("update public.games set status='canceled' where id=$1", [g.game_id]);
    assert.match((await errorOf(join(g.code, "Late"))) ?? "", /game_not_joinable/);
    assert.match((await errorOf(join("ZZZZZZ", "Nope"))) ?? "", /game_not_found/);
  });

  it("player state reports live player count, status and kicked flag for the token owner only", async () => {
    const t = generatePlayerToken();
    const g = await as(db, asUser(host), async () => (await db.query<{ game_id: string; code: string }>(
      "select * from public.create_game_with_rounds('State', array['a'])")).rows[0]);
    await join(g.code, "P1", t);
    await join(g.code, "P2");
    const get = async () => (await as(db, { role: "service_role" }, () => db.query<{ s: { status: string; phase: string; playerCount: number; joinCode: string; me: { nickname: string; kicked: boolean } } | null }>(
      "select public.player_game_state($1) as s", [hashToken(t)]))).rows[0].s!;
    const st = await get();
    assert.deepEqual([st.me.nickname, st.playerCount, st.status, st.me.kicked, st.joinCode], ["P1", 2, "lobby", false, g.code]);
    await transition(host, g.game_id, "start_game");
    assert.equal((await get()).status, "live");
    assert.equal((await as(db, { role: "service_role" }, () => db.query<{ s: unknown }>("select public.player_game_state($1) as s", [hashToken("nope")]))).rows[0].s, null);
  });

  it("clients and anon cannot call the guest functions", async () => {
    for (const actor of [{ role: "anon" } as const, asUser(host)]) {
      for (const sql of ["select * from public.public_room_info('ABCDEF')", "select * from public.join_game('ABCDEF','x','a','b')", "select public.player_game_state('a')"]) {
        assert.match((await errorOf(as(db, actor, () => db.query(sql)))) ?? "", /permission denied/i, sql);
      }
    }
  });
});
