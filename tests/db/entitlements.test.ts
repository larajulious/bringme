/**
 * Phase 7: Game Pass enforcement matrix (real SQL, migrations 1..12). Concurrent final-slot
 * joins run on real PostgreSQL in tests/concurrency/engine-concurrency.mjs.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";

import { generatePlayerToken, hashToken } from "../../lib/players/token.ts";
import { as, confirmUser, createDb, createUser, endCurrentPass, errorOf } from "./harness.ts";

const svc = { role: "service_role" } as const;
const user = (sub: string) => ({ role: "authenticated", sub }) as const;
const PRODUCT: Record<string, string> = { starter: "11111111-1111-4111-8111-111111111111", party: "22222222-2222-4222-8222-222222222222", pro: "33333333-3333-4333-8333-333333333333" };
let db: PGlite;
let n = 0;
const host = () => createUser(db, `ent-${++n}@example.com`);
const grant = (u: string, plan: string, days = 7) => as(db, svc, () => db.query("select public.admin_grant_pass(null,$1,$2,$3,'test')", [u, plan, days]));
const create = async (u: string, items = ["a", "b"]) =>
  (await as(db, user(u), () => db.query<{ game_id: string; code: string }>("select * from public.create_game_with_rounds('Limit test', $1)", [items]))).rows[0];
const join = (code: string, name: string) =>
  as(db, svc, () => db.query<{ player_id: string }>("select * from public.join_game($1,$2,$3,null)", [code, name, hashToken(generatePlayerToken())]));
async function fill(code: string, k: number, prefix = "p") { for (let i = 0; i < k; i++) await join(code, `${prefix}${i}`); }
const transition = async (u: string, g: string, action: string) => {
  const v = (await db.query<{ v: string }>("select state_version::text v from public.games where id=$1", [g])).rows[0].v;
  return as(db, user(u), () => db.query("select public.game_transition($1,$2,$3,null)", [g, action, Number(v)]));
};
const ent = async (u: string) => (await db.query<{ plan_code: string; max_players_per_game: number; source: string }>("select * from public.pass_entitlement($1)", [u])).rows[0] ?? null;
const access = async (u: string) => (await db.query<{ state: string }>("select state from public.access_state_for($1)", [u])).rows[0].state;
const active = async (g: string) => Number((await db.query<{ n: string }>("select count(*)::text n from public.players where game_id=$1 and kicked_at is null", [g])).rows[0].n);
let evt = 0;
async function pay(u: string, plan: string) {
  const o = (await as(db, svc, () => db.query<{ order_id: string; amount_minor: number }>(
    "select * from public.start_checkout_order($1,$2,'PHP','sandbox',$3)", [u, plan, PRODUCT[plan]]))).rows[0];
  const co = `co_ent_${++evt}`;
  await as(db, svc, () => db.query("select public.attach_verified_checkout($1,$2,$3,'php',$4,null,$5,now() + interval '1 hour')", [o.order_id, co, PRODUCT[plan], o.amount_minor, `https://sandbox.polar.sh/c/${co}`]));
  const effect = { kind: "order_paid", order_id: o.order_id, polar_order_id: `po_${co}`, polar_checkout_id: co, polar_product_id: PRODUCT[plan],
    external_customer_id: u, currency: "PHP", amount_minor: o.amount_minor, environment: "sandbox" };
  const apply = (id: string) => as(db, svc, async () => (await db.query<{ r: string }>("select public.apply_payment_event('polar',$1,'order.paid','{}',$2) r", [id, JSON.stringify(effect)])).rows[0].r);
  assert.equal(await apply(`evt_${co}`), "applied");
  return { order: o.order_id, apply, co, amount: o.amount_minor };
}

before(async () => { db = await createDb(); });

describe("player capacity per plan (join is atomic; reconnects don't count twice)", () => {
  for (const [plan, cap] of [["trial", 3], ["starter", 10], ["party", 50], ["pro", 100]] as const) {
    it(`${plan}: exactly ${cap} players, the next one gets game_full`, async () => {
      const u = await host();
      if (plan === "trial") await confirmUser(db, u); else await grant(u, plan);
      assert.equal((await ent(u)).max_players_per_game, cap);
      const g = await create(u);
      assert.equal((await db.query<{ m: number }>("select max_players m from public.games where id=$1", [g.game_id])).rows[0].m, cap);
      await fill(g.code, cap);
      assert.match((await errorOf(join(g.code, "one-too-many"))) ?? "", /game_full/);
      assert.equal(await active(g.game_id), cap);
      const info = (await as(db, svc, () => db.query<{ player_count: string; max_players: number }>("select * from public.public_room_info($1)", [g.code]))).rows[0];
      assert.deepEqual([Number(info.player_count), info.max_players], [cap, cap], "join page sees 'room full'");
    });
  }

  it("a reconnecting player (same cookie) is restored without taking a new slot", async () => {
    const u = await host();
    await confirmUser(db, u);
    const g = await create(u);
    const tok = generatePlayerToken();
    await as(db, svc, () => db.query("select * from public.join_game($1,'Ann',$2,null)", [g.code, hashToken(tok)]));
    await fill(g.code, 2, "x");
    const back = (await as(db, svc, () => db.query<{ restored: boolean }>("select * from public.join_game($1,'Ann',$2,$3)", [g.code, hashToken(generatePlayerToken()), hashToken(tok)]))).rows[0];
    assert.equal(back.restored, true);
    assert.equal(await active(g.game_id), 3);
  });
});

describe("unauthorized capacity / plan modification", () => {
  it("a host can't raise a room above the pass, nor touch plans, passes or segments", async () => {
    const u = await host();
    await confirmUser(db, u);
    const g = await create(u);
    await as(db, user(u), () => db.query("update public.games set max_players = 500 where id=$1", [g.game_id]));
    assert.equal((await db.query<{ m: number }>("select max_players m from public.games where id=$1", [g.game_id])).rows[0].m, 3, "capped to the trial");
    for (const sql of [
      "update public.subscription_plans set max_players_per_game = 500",
      "update public.game_passes set max_players = 500",
      "update public.pass_segments set ends_at = ends_at + interval '30 days'",
      "insert into public.game_passes (user_id, plan_id, source, max_players, duration_seconds) select $1, id, 'admin_grant', 100, 999999 from public.subscription_plans where code='pro'",
    ]) {
      const e = await errorOf(as(db, user(u), () => db.query(sql, sql.includes("$1") ? [u] : [])));
      assert.match(e ?? "", /permission denied/, sql);
    }
    assert.equal((await ent(u)).max_players_per_game, 3);
  });

  it("restoring a removed player can't exceed the pass (the bypass closed by migration 12)", async () => {
    const u = await host();
    await confirmUser(db, u);
    const g = await create(u);
    await fill(g.code, 3);
    const a = (await db.query<{ id: string }>("select id from public.players where game_id=$1 order by joined_at limit 1", [g.game_id])).rows[0].id;
    await as(db, user(u), () => db.query("update public.players set kicked_at = now() where id=$1", [a]));
    await join(g.code, "newcomer");
    assert.match((await errorOf(as(db, user(u), () => db.query("update public.players set kicked_at = null where id=$1", [a])))) ?? "", /game_full/);
    assert.equal(await active(g.game_id), 3);
    // with a free slot, restoring still works
    const b = (await db.query<{ id: string }>("select id from public.players where game_id=$1 and nickname='newcomer'", [g.game_id])).rows[0].id;
    await as(db, user(u), () => db.query("update public.players set kicked_at = now() where id=$1", [b]));
    assert.equal(await errorOf(as(db, user(u), () => db.query("update public.players set kicked_at = null where id=$1", [a]))), null);
  });
});

describe("expiry is immediate (time alone, no job)", () => {
  it("expired trial: no create, no start; dashboard still readable and says 'trial ended'", async () => {
    const u = await host();
    await confirmUser(db, u);
    const g = await create(u);
    await fill(g.code, 1);
    await endCurrentPass(db, u);
    assert.equal(await access(u), "expired");
    assert.match((await errorOf(create(u))) ?? "", /subscription_required/);
    assert.match((await errorOf(transition(u, g.game_id, "start_game"))) ?? "", /subscription_required/);
    const s = (await as(db, user(u), () => db.query<{ s: { trialEndedNoPass: boolean; state: string } }>("select public.my_game_pass_summary() s"))).rows[0].s;
    assert.deepEqual([s.state, s.trialEndedNoPass], ["expired", true]);
    assert.equal(await errorOf(as(db, user(u), () => db.query("select * from public.games where owner_id=$1", [u]))), null, "history readable");
  });

  it("expired paid pass: blocked; buying again activates immediately", async () => {
    const u = await host();
    await pay(u, "party");
    await endCurrentPass(db, u);
    assert.equal(await access(u), "expired");
    assert.match((await errorOf(create(u))) ?? "", /subscription_required/);
    await pay(u, "starter");
    assert.equal((await ent(u)).plan_code, "starter");
    assert.equal(await errorOf(create(u)), null);
  });
});

describe("upgrade / repeat purchase policy", () => {
  it("first purchase, purchase during the trial (trial ends), same-tier extension (+7 days, no overlap)", async () => {
    const u = await host();
    await confirmUser(db, u);
    assert.equal((await ent(u)).plan_code, "trial");
    await pay(u, "starter");
    const after = await ent(u);
    assert.deepEqual([after.plan_code, after.max_players_per_game], ["starter", 10]);
    await pay(u, "starter");
    const segs = (await db.query<{ code: string; secs: number }>(
      `select pl.code, extract(epoch from (s.ends_at - s.starts_at))::float8 secs from public.pass_segments s
         join public.game_passes p on p.id = s.pass_id join public.subscription_plans pl on pl.id = p.plan_id
        where s.user_id=$1 and s.ends_at > now() order by s.starts_at`, [u])).rows;
    assert.deepEqual(segs.map((x) => x.code), ["starter", "starter"]);
    assert.ok(Math.abs(segs[1].secs - 604_800) < 1e-3);
    const overlaps = (await db.query<{ n: string }>(`select count(*)::text n from public.pass_segments a join public.pass_segments b
      on a.user_id=b.user_id and a.id<b.id and tstzrange(a.starts_at,a.ends_at,'[)') && tstzrange(b.starts_at,b.ends_at,'[)') where a.user_id=$1`, [u])).rows[0].n;
    assert.equal(overlaps, "0");
  });

  it("higher-tier upgrade raises the cap of an open lobby immediately", async () => {
    const u = await host();
    await pay(u, "starter");
    const g = await create(u);
    await fill(g.code, 10);
    assert.match((await errorOf(join(g.code, "eleventh"))) ?? "", /game_full/);
    await pay(u, "pro");
    assert.equal(await errorOf(join(g.code, "eleventh")), null);
    assert.equal((await ent(u)).max_players_per_game, 100);
  });

  it("queued downgrade: Pro stays until it ends, then Starter's 10-player cap applies (over-full room can't start)", async () => {
    const u = await host();
    await pay(u, "pro");
    await pay(u, "starter");
    assert.equal((await ent(u)).plan_code, "pro");
    const g = await create(u);
    await fill(g.code, 12);
    await endCurrentPass(db, u);
    assert.deepEqual([(await ent(u)).plan_code, (await ent(u)).max_players_per_game], ["starter", 10]);
    assert.match((await errorOf(join(g.code, "late"))) ?? "", /game_full/);
    assert.match((await errorOf(transition(u, g.game_id, "start_game"))) ?? "", /player_limit_exceeded/);
  });

  it("repeated payment events never add days", async () => {
    const u = await host();
    const p = await pay(u, "party");
    assert.equal(await p.apply(`evt_${p.co}`), "duplicate");
    assert.equal(await p.apply(`evt_${p.co}_redelivered`), "duplicate_effect");
    const total = (await db.query<{ s: number }>("select sum(extract(epoch from (ends_at - starts_at)))::float8 s from public.pass_segments where user_id=$1", [u])).rows[0].s;
    assert.ok(Math.abs(total - 604_800) < 1e-3);
  });

  it("revoked and refunded passes stop granting at once; the next queued pass (if any) takes over", async () => {
    const r = await host();
    await grant(r, "pro");
    const pass = (await db.query<{ id: string }>("select id from public.game_passes where user_id=$1", [r])).rows[0].id;
    await as(db, svc, () => db.query("select public.admin_revoke_pass(null,$1,'abuse')", [pass]));
    assert.equal(await access(r), "expired");
    assert.match((await errorOf(create(r))) ?? "", /subscription_required/);

    const f = await host();
    const a = await pay(f, "pro");
    await pay(f, "starter");
    await as(db, svc, () => db.query("select public.apply_payment_event('polar',$1,'order.refunded','{}',$2)", [`ref_${a.co}`, JSON.stringify({
      kind: "order_refunded", order_id: a.order, refunded_amount_minor: a.amount, full: true })]));
    assert.equal((await ent(f)).plan_code, "starter");
  });
});

describe("a running game at expiry (documented policy: finish it, nothing new)", () => {
  it("rounds created before the start can be played; no joins, no new rounds, no new games; results kept", async () => {
    const u = await host();
    await grant(u, "party");
    const g = await create(u, ["a", "b", "c"]);
    await fill(g.code, 2);
    await transition(u, g.game_id, "start_game");
    await endCurrentPass(db, u);
    assert.equal(await errorOf(transition(u, g.game_id, "start_countdown")), null, "the live game continues");
    assert.match((await errorOf(join(g.code, "late"))) ?? "", /game_not_joinable/);
    assert.match((await errorOf(as(db, user(u), () => db.query("insert into public.game_rounds (game_id, round_no, prompt) values ($1, 9, 'extra')", [g.game_id])))) ?? "", /rounds can only be added|subscription_required/);
    assert.match((await errorOf(create(u))) ?? "", /subscription_required/);
    assert.equal(await errorOf(transition(u, g.game_id, "end_game")), null);
    assert.equal(await errorOf(as(db, user(u), () => db.query("select * from public.game_results($1)", [g.game_id]))), null, "results stay readable");
    assert.match((await errorOf(transition(u, g.game_id, "start_game"))) ?? "", /invalid_transition/, "a finished game can't be restarted");
  });
});
