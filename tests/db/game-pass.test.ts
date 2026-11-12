/**
 * Game Pass ledger (migrations 20261112000001..7). IDs refer to the acceptance matrix in
 * GAME_PASS_DESIGN.md §9. Time travel = test.shift_ledger / test.end_current (shim).
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";

import { generatePlayerToken, hashToken } from "../../lib/players/token.ts";
import { as, confirmUser, createDb, createUser, endCurrentPass, errorOf, newPGlite, shiftLedger } from "./harness.ts";

const DAY = 86_400;
const WEEK = 7 * DAY;
const svc = { role: "service_role" } as const;
const user = (sub: string) => ({ role: "authenticated", sub }) as const;
const migrationsDir = join(import.meta.dirname, "..", "..", "supabase", "migrations");
const allFiles = readdirSync(migrationsDir).filter((n) => n.endsWith(".sql")).sort();
const GAME_PASS_FILES = allFiles.filter((f) => f >= "20261112");

let db: PGlite;
let n = 0;
const host = async (label = "h") => createUser(db, `${label}-${++n}@example.com`);
const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];

type Row = Record<string, unknown>;
const timeline = (u: string) =>
  db.query<{ plan_code: string; source: string; state: string; consumed_seconds: string; remaining_seconds: string; disposition: string }>(
    "select * from public.pass_timeline_for($1) order by seq", [u]).then((r) => r.rows);
const ent = (u: string) => one<Row & { plan_code: string; max_players_per_game: number }>("select * from public.pass_entitlement($1)", [u]);
const access = (u: string) => one<{ state: string; plan_code: string | null; current_period_end: Date | null }>("select * from public.access_state_for($1)", [u]);
const segs = (u: string) =>
  db.query<{ plan: string; starts_at: Date; ends_at: Date; secs: string }>(
    `select pl.code plan, s.starts_at, s.ends_at, extract(epoch from (s.ends_at - s.starts_at))::text secs
       from public.pass_segments s join public.game_passes p on p.id = s.pass_id
       join public.subscription_plans pl on pl.id = p.plan_id where s.user_id = $1 order by s.starts_at`, [u]).then((r) => r.rows);

let evt = 0;
async function order(u: string, plan: string, currency = "PHP") {
  return (await as(db, svc, () => db.query<{ order_id: string; amount_minor: number; polar_product_id: string }>(
    "select * from public.create_pass_order($1,$2,$3)", [u, plan, currency]))).rows[0];
}
const pay = (o: { order_id: string; amount_minor: number; polar_product_id: string }, currency: string, over: Row = {}, eventId = `evt_${++evt}`) =>
  as(db, svc, async () => (await db.query<{ r: string }>("select public.apply_payment_event('polar',$1,'order.paid','{}',$2) r", [eventId, JSON.stringify({
    kind: "order_paid", order_id: o.order_id, polar_order_id: `po_${o.order_id}`, polar_product_id: o.polar_product_id,
    currency, amount_minor: o.amount_minor, ...over })])).rows[0].r);
async function buy(u: string, plan: string, currency = "PHP") {
  const o = await order(u, plan, currency);
  assert.equal(await pay(o, currency), "applied");
  return o;
}
const effect = (eventId: string, e: Row) =>
  as(db, svc, async () => (await db.query<{ r: string }>("select public.apply_payment_event('polar',$1,'x','{}',$2) r", [eventId, JSON.stringify(e)])).rows[0].r);
const passOf = (orderId: string) => one<{ id: string; disposition: string }>("select id, disposition from public.game_passes where order_id=$1", [orderId]);

before(async () => {
  db = await createDb();
  // Products exist in Polar for every paid price (Phase 3 fills these for real).
  await db.query("update public.plan_prices pp set polar_product_id = 'prod_' || p.code || '_' || pp.currency from public.subscription_plans p where p.id = pp.plan_id and not p.is_trial");
});

describe("plan catalogue and prices", () => {
  it("has the four final plans: players, tier, 7 days (exact seconds), trial flag", async () => {
    const r = (await db.query<Row>(
      "select code, tier, is_trial, max_players_per_game, duration_seconds from public.subscription_plans where code in ('trial','starter','party','pro') order by tier")).rows;
    assert.deepEqual(r, [
      { code: "trial", tier: 0, is_trial: true, max_players_per_game: 3, duration_seconds: WEEK },
      { code: "starter", tier: 1, is_trial: false, max_players_per_game: 10, duration_seconds: WEEK },
      { code: "party", tier: 2, is_trial: false, max_players_per_game: 50, duration_seconds: WEEK },
      { code: "pro", tier: 3, is_trial: false, max_players_per_game: 100, duration_seconds: WEEK },
    ]);
  });

  it("keeps the audited non-player limits (open games, rounds, period cap)", async () => {
    const r = (await db.query<Row>("select code, max_active_games, max_rounds_per_game, max_games_per_period from public.subscription_plans where code in ('trial','starter','party','pro') order by tier")).rows;
    assert.deepEqual(r.map((x) => [x.code, x.max_active_games, x.max_rounds_per_game, x.max_games_per_period]),
      [["trial", 1, 5, null], ["starter", 1, 5, null], ["party", 3, 15, null], ["pro", 10, 40, null]]);
  });

  it("stores PHP and USD separately, in integer minor units with 2-digit precision", async () => {
    const r = (await db.query<{ code: string; currency: string; amount_minor: number; display: string }>(
      `select p.code, pp.currency, pp.amount_minor, to_char(pp.amount_minor / 100.0, 'FM999990.00') display
         from public.plan_prices pp join public.subscription_plans p on p.id = pp.plan_id where pp.is_active order by p.tier, pp.currency`)).rows;
    assert.deepEqual(r.map((x) => `${x.code} ${x.currency} ${x.amount_minor} ${x.display}`), [
      "trial PHP 0 0.00", "trial USD 0 0.00",
      "starter PHP 9900 99.00", "starter USD 199 1.99",
      "party PHP 19900 199.00", "party USD 349 3.49",
      "pro PHP 29900 299.00", "pro USD 499 4.99",
    ]);
    const types = (await db.query<{ data_type: string }>("select data_type from information_schema.columns where table_name='plan_prices' and column_name='amount_minor'")).rows[0];
    assert.equal(types.data_type, "integer", "no floating point money");
  });

  it("refuses a zero price for paid plans, a non-zero trial price, unknown currencies, and a 2nd active price", async () => {
    const pid = async (c: string) => (await one<{ id: string }>("select id from public.subscription_plans where code=$1", [c])).id;
    assert.match((await errorOf(db.query("insert into public.plan_prices (plan_id, currency, amount_minor, is_active) values ($1,'PHP',0,false)", [await pid("party")]))) ?? "", /paid_price_must_be_positive/);
    assert.match((await errorOf(db.query("insert into public.plan_prices (plan_id, currency, amount_minor, is_active) values ($1,'USD',100,false)", [await pid("trial")]))) ?? "", /trial_price_must_be_zero/);
    assert.match((await errorOf(db.query("insert into public.plan_prices (plan_id, currency, amount_minor) values ($1,'EUR',100)", [await pid("party")]))) ?? "", /check constraint/);
    assert.match((await errorOf(db.query("insert into public.plan_prices (plan_id, currency, amount_minor) values ($1,'PHP',100)", [await pid("party")]))) ?? "", /duplicate key|plan_prices_one_active/);
  });

  it("anon can read prices for the pricing page, but not Polar identifiers", async () => {
    const r = await as(db, { role: "anon" }, () => db.query("select currency, amount_minor from public.plan_prices"));
    assert.equal(r.rows.length, 8);
    assert.match((await errorOf(as(db, { role: "anon" }, () => db.query("select polar_product_id from public.plan_prices")))) ?? "", /permission denied/);
  });
});

describe("free trial", () => {
  it("T-1 starts once, immediately, for exactly 7 days with 3 players", async () => {
    const u = await host("trial");
    await confirmUser(db, u);   // Phase 3: confirming the account grants the trial automatically
    const e = await ent(u);
    assert.equal(e.plan_code, "trial");
    assert.equal(e.max_players_per_game, 3);
    assert.equal(e.source, "trial");
    const s = await segs(u);
    assert.equal(s.length, 1);
    assert.equal(Number(s[0].secs), WEEK);
    assert.equal((await access(u)).state, "active");
    const ev = await one<{ n: string }>("select count(*)::text n from public.entitlement_events where user_id=$1 and action='trial_started'", [u]);
    assert.equal(ev.n, "1");
  });

  it("T-2 can never restart (second call, new session, after expiry)", async () => {
    const u = await host("trial2");
    await confirmUser(db, u);   // Phase 3: confirming the account grants the trial automatically
    assert.match((await errorOf(as(db, user(u), () => db.query("select public.start_trial()")))) ?? "", /trial_already_used/);
    await shiftLedger(db, u, 8 * DAY);
    assert.equal((await access(u)).state, "expired");
    assert.match((await errorOf(as(db, user(u), () => db.query("select public.start_trial()")))) ?? "", /trial_already_used/);
    const c = await one<{ n: string }>("select count(*)::text n from public.game_passes where user_id=$1 and source='trial'", [u]);
    assert.equal(c.n, "1");
    // the unique index is the last line of defence, even for trusted roles
    assert.match((await errorOf(db.query(
      "insert into public.game_passes (user_id, plan_id, source, max_players, duration_seconds) select $1, id, 'trial', 3, 1 from public.subscription_plans where code='trial'", [u]))) ?? "", /game_passes_one_trial_per_user|duplicate key/);
  });

  it("T-4 eligibility: unconfirmed email, suspended, deactivated and super admins are refused", async () => {
    const unconfirmed = await host("unconf");
    await db.query("update auth.users set email_confirmed_at = null where id=$1", [unconfirmed]);
    assert.match((await errorOf(as(db, user(unconfirmed), () => db.query("select public.start_trial()")))) ?? "", /email_unconfirmed/);
    const deact = await host("deact");
    await as(db, svc, () => db.query("select public.admin_set_account_active($1, false)", [deact]));
    assert.match((await errorOf(as(db, user(deact), () => db.query("select public.start_trial()")))) ?? "", /deactivated/);
    const boss = await host("boss");
    await db.query("update public.profiles set role='super_admin' where id=$1", [boss]);
    assert.match((await errorOf(as(db, user(boss), () => db.query("select public.start_trial()")))) ?? "", /not_subscriber/);
    const sus = await host("sus");
    await db.query("update public.profiles set hosting_suspended_at = now() where id=$1", [sus]);
    assert.match((await errorOf(as(db, user(sus), () => db.query("select public.start_trial()")))) ?? "", /suspended/);
    assert.match((await errorOf(as(db, { role: "anon" }, () => db.query("select public.start_trial()")))) ?? "", /permission denied/);
  });

  it("T-5 a host with paid history is not eligible", async () => {
    const u = await host("paidfirst");
    await buy(u, "starter");
    await confirmUser(db, u);
    assert.equal((await one<{ n: string }>("select count(*)::text n from public.game_passes where user_id=$1 and source='trial'", [u])).n, "0");
    const el = (await as(db, user(u), () => db.query<{ eligible: boolean; reason: string }>("select * from public.my_trial_eligibility()"))).rows[0];
    assert.deepEqual([el.eligible, el.reason], [false, "has_paid_history"]);
  });

  it("T-6 buying a paid pass ends the trial at once; trial time is not restored later", async () => {
    const u = await host("trialbuy");
    await confirmUser(db, u);   // Phase 3: confirming the account grants the trial automatically
    await shiftLedger(db, u, DAY);
    await buy(u, "starter");
    assert.equal((await ent(u)).plan_code, "starter");
    const t = await timeline(u);
    assert.deepEqual(t.map((x) => [x.plan_code, x.state]), [["trial", "forfeited"], ["starter", "active"]]);
    await endCurrentPass(db, u);
    assert.equal((await access(u)).state, "expired", "no trial time comes back after the paid pass");
  });
});

describe("purchases, queue, upgrades (half-open UTC intervals)", () => {
  it("P-1 first purchase is active immediately for exactly 7 days", async () => {
    const u = await host("p1");
    const o = await buy(u, "party", "USD");
    const e = await ent(u);
    assert.deepEqual([e.plan_code, e.max_players_per_game, e.source, e.payment_status], ["party", 50, "purchase", "paid"]);
    assert.equal(Number((await segs(u))[0].secs), WEEK);
    const ord = await one<Row>("select status, currency, amount_minor, paid_amount_minor from public.pass_orders where id=$1", [o.order_id]);
    assert.deepEqual(ord, { status: "paid", currency: "USD", amount_minor: 349, paid_amount_minor: 349 });
  });

  it("P-2 the same plan again queues 7 more days directly after (no gap, no overlap)", async () => {
    const u = await host("p2");
    await buy(u, "starter");
    await buy(u, "starter");
    const s = await segs(u);
    assert.equal(s.length, 2);
    assert.equal(s[0].ends_at.getTime(), s[1].starts_at.getTime(), "queued pass starts exactly when the first ends");
    assert.deepEqual(s.map((x) => Number(x.secs)), [WEEK, WEEK]);
    assert.deepEqual((await timeline(u)).map((x) => x.state), ["active", "queued"]);
    const a = await access(u);
    assert.equal(a.current_period_end!.getTime(), s[1].ends_at.getTime(), "access ends after the whole queue");
  });

  it("P-3 an upgrade activates now; the paused remainder resumes later; total paid time is kept", async () => {
    const u = await host("p3");
    await buy(u, "starter");
    await shiftLedger(db, u, 2 * DAY);
    await buy(u, "pro");
    assert.equal((await ent(u)).plan_code, "pro");
    const t = await timeline(u);
    const starter = t.find((x) => x.plan_code === "starter")!;
    assert.equal(starter.state, "paused");
    assert.ok(Math.abs(Number(starter.remaining_seconds) - 5 * DAY) < 5, "about 5 days left");
    const segsAfter = await segs(u);
    assert.deepEqual(segsAfter.map((x) => x.plan), ["starter", "pro", "starter"]);
    const starterTotal = segsAfter.filter((x) => x.plan === "starter").reduce((a, x) => a + Number(x.secs), 0);
    assert.ok(Math.abs(starterTotal - WEEK) < 1e-3, `starter total ${starterTotal}`);
    assert.equal(segsAfter[1].ends_at.getTime(), segsAfter[2].starts_at.getTime());
    const pre = await one<{ n: string }>("select count(*)::text n from public.entitlement_events where user_id=$1 and action='pass_preempted'", [u]);
    assert.equal(pre.n, "1");
  });

  it("P-4/P-5 lower tiers queue after higher ones: Pro -> Party -> Starter", async () => {
    const u = await host("p5");
    await buy(u, "pro");
    await buy(u, "starter");
    await buy(u, "party");
    assert.deepEqual((await segs(u)).map((x) => x.plan), ["pro", "party", "starter"]);
  });

  it("P-6 switching at the boundary needs no job: the next pass is active once the previous ends", async () => {
    const u = await host("p6");
    await buy(u, "party");
    await buy(u, "starter");
    await endCurrentPass(db, u);
    assert.equal((await ent(u)).plan_code, "starter");
    const b = await one<{ inside: boolean }>(
      "select tstzrange(starts_at, ends_at, '[)') @> ends_at as inside from public.pass_segments where user_id=$1 order by starts_at limit 1", [u]);
    assert.equal(b.inside, false, "access ends exactly at ends_at");
  });

  it("P-7 an expired pass reads as expired, never as a failed payment", async () => {
    const u = await host("p7");
    const o = await buy(u, "starter");
    await endCurrentPass(db, u);
    assert.equal((await access(u)).state, "expired");
    assert.equal((await one<{ status: string }>("select status from public.pass_orders where id=$1", [o.order_id])).status, "paid");
    assert.equal((await timeline(u))[0].state, "consumed");
  });

  it("P-9 a sold pass keeps its player cap if the plan is edited later", async () => {
    const u = await host("p9");
    await buy(u, "party");
    await db.query("update public.subscription_plans set max_players_per_game = 40 where code='party'");
    assert.equal((await ent(u)).max_players_per_game, 50);
    await db.query("update public.subscription_plans set max_players_per_game = 50 where code='party'");
  });

  it("P-10 seven days is exact whatever the session time zone (DST)", async () => {
    const u = await host("p10");
    await db.query("set timezone = 'America/New_York'");
    try {
      await buy(u, "starter");
      await buy(u, "starter");
    } finally {
      await db.query("set timezone = 'UTC'");
    }
    assert.deepEqual((await segs(u)).map((x) => Number(x.secs)), [WEEK, WEEK]);
  });

  it("never stores overlapping access, even through the service role", async () => {
    const u = await host("ovl");
    await buy(u, "starter");
    const p = await one<{ id: string }>("select id from public.game_passes where user_id=$1", [u]);
    const e = await errorOf(as(db, svc, () => db.query(
      "insert into public.pass_segments (pass_id, user_id, starts_at, ends_at) values ($1,$2, now() + interval '1 day', now() + interval '2 days')", [p.id, u])));
    assert.match(e ?? "", /pass_segments_no_overlap|exclusion/);
    const bad = await one<{ n: string }>(`select count(*)::text n from public.pass_segments a join public.pass_segments b
      on a.user_id=b.user_id and a.id<b.id and tstzrange(a.starts_at,a.ends_at,'[)') && tstzrange(b.starts_at,b.ends_at,'[)')`);
    assert.equal(bad.n, "0");
  });
});

describe("payment evidence and webhook idempotency", () => {
  it("W-2 the same event id twice grants once", async () => {
    const u = await host("w2");
    const o = await order(u, "starter");
    assert.equal(await pay(o, "PHP", {}, "evt_dup"), "applied");
    assert.equal(await pay(o, "PHP", {}, "evt_dup"), "duplicate");
    assert.equal(await pay(o, "PHP", {}, "evt_other_delivery"), "duplicate_effect", "same Polar order again");
    const c = await one<{ n: string }>("select count(*)::text n from public.game_passes where user_id=$1", [u]);
    assert.equal(c.n, "1");
    const ev = await one<{ outcome: string; processed: boolean }>("select outcome, processed_at is not null processed from public.payment_events where event_id='evt_dup'");
    assert.deepEqual(ev, { outcome: "applied", processed: true });
  });

  it("W-4 wrong product, currency or a short amount is held for review and grants nothing", async () => {
    for (const [over, reason] of [[{ polar_product_id: "prod_pro_PHP" }, "product_mismatch"], [{ currency: "USD" }, "currency_mismatch"], [{ amount_minor: 100 }, "amount_mismatch"]] as const) {
      const u = await host("w4");
      const o = await order(u, "starter");
      assert.equal(await pay(o, over.currency ?? "PHP", over), "needs_review");
      const st = await one<{ status: string; review_reason: string }>("select status, review_reason from public.pass_orders where id=$1", [o.order_id]);
      assert.deepEqual([st.status, st.review_reason], ["needs_review", reason]);
      assert.equal((await access(u)).state, "pending");
    }
  });

  it("an admin can approve a reviewed order (audited); rejection grants nothing", async () => {
    const boss = await host("rev-boss");
    await db.query("update public.profiles set role='super_admin' where id=$1", [boss]);
    const u = await host("rev");
    const o = await order(u, "starter");
    await pay(o, "PHP", { amount_minor: 9000 });
    assert.match((await errorOf(as(db, svc, () => db.query("select public.admin_review_order($1,$2,'approve','')", [boss, o.order_id])))) ?? "", /reason_required/);
    await as(db, svc, () => db.query("select public.admin_review_order($1,$2,'approve','customer used a coupon')", [boss, o.order_id]));
    assert.equal((await ent(u)).plan_code, "starter");
    const ev = await one<{ actor_id: string }>("select actor_id from public.entitlement_events where order_id=$1 and action='order_paid'", [o.order_id]);
    assert.equal(ev.actor_id, boss);
  });

  it("W-5 an event for an unknown order is stored as unmatched", async () => {
    assert.equal(await effect("evt_unknown", { kind: "order_paid", order_id: crypto.randomUUID(), polar_order_id: "po_x" }), "unmatched");
    assert.equal(await effect("evt_junk", { kind: "order_paid", order_id: "not-a-uuid'; drop table x;--" }), "unmatched");
    assert.equal(await effect("evt_noise", { kind: "checkout.created" }), "ignored");
  });

  it("W-6 a late 'expired' never undoes a payment; failed/abandoned checkouts grant nothing", async () => {
    const u = await host("w6");
    const o = await buy(u, "starter");
    assert.equal(await effect("evt_late_exp", { kind: "order_expired", order_id: o.order_id }), "ignored");
    assert.equal((await one<{ status: string }>("select status from public.pass_orders where id=$1", [o.order_id])).status, "paid");

    const v = await host("w6b");
    const f = await order(v, "party");
    assert.equal(await effect("evt_fail", { kind: "order_failed", order_id: f.order_id }), "applied");
    assert.equal((await access(v)).state, "pending");
    assert.equal(await pay(f, "PHP"), "needs_review", "money for a failed checkout is never silently ignored or granted");
    assert.equal(await passOf(f.order_id), undefined);
  });

  it("W-7/W-10 abandoned checkouts expire after 24 h; at most 3 pending per host", async () => {
    const u = await host("w7");
    const price = await one<{ id: string; plan_id: string }>("select pp.id, pp.plan_id from public.plan_prices pp join public.subscription_plans p on p.id=pp.plan_id where p.code='starter' and pp.currency='PHP' and pp.is_active");
    const old = await one<{ id: string }>("insert into public.pass_orders (user_id, plan_id, plan_price_id, currency, amount_minor, created_at) values ($1,$2,$3,'PHP',9900, now() - interval '25 hours') returning id", [u, price.plan_id, price.id]);
    await order(u, "starter"); await order(u, "starter"); await order(u, "starter");
    assert.equal((await one<{ status: string }>("select status from public.pass_orders where id=$1", [old.id])).status, "expired");
    assert.match((await errorOf(order(u, "starter"))) ?? "", /too_many_pending_orders/);
    assert.equal((await access(u)).state, "pending");
  });

  it("refuses the trial, unknown currencies and plans without a Polar product", async () => {
    const u = await host("np");
    assert.match((await errorOf(order(u, "trial"))) ?? "", /plan_not_purchasable/);
    assert.match((await errorOf(order(u, "starter", "EUR"))) ?? "", /invalid_currency/);
    await db.query("update public.plan_prices set polar_product_id = null where currency='USD' and plan_id=(select id from public.subscription_plans where code='pro')");
    assert.match((await errorOf(order(u, "pro", "USD"))) ?? "", /plan_not_purchasable/);
    await db.query("update public.plan_prices set polar_product_id = 'prod_pro_USD' where currency='USD' and plan_id=(select id from public.subscription_plans where code='pro')");
  });
});

describe("refunds, admin grants, suspension", () => {
  it("R-1 a full refund revokes the active pass at once; the queued pass takes over", async () => {
    const u = await host("r1");
    const a = await buy(u, "pro");
    await buy(u, "starter");
    assert.equal(await effect("evt_ref1", { kind: "order_refunded", order_id: a.order_id, refunded_amount_minor: a.amount_minor }), "applied");
    assert.equal((await passOf(a.order_id)).disposition, "revoked");
    assert.equal((await ent(u)).plan_code, "starter");
    assert.equal((await one<{ status: string }>("select status from public.pass_orders where id=$1", [a.order_id])).status, "refunded");
    assert.equal(await effect("evt_ref1b", { kind: "order_refunded", order_id: a.order_id, refunded_amount_minor: a.amount_minor }), "duplicate_effect", "the same refund seen again is a no-op (Phase 6)");
    assert.equal(await effect("evt_ref1c", { kind: "order_refunded", order_id: a.order_id, refunded_amount_minor: a.amount_minor + 1 }), "needs_review", "a refund larger than what was paid is still flagged");
  });

  it("R-2 refunding a queued pass removes it from the queue only", async () => {
    const u = await host("r2");
    await buy(u, "pro");
    const q = await buy(u, "party");
    await effect("evt_ref2", { kind: "order_refunded", order_id: q.order_id, refunded_amount_minor: q.amount_minor });
    assert.deepEqual((await segs(u)).map((x) => x.plan), ["pro"]);
  });

  it("R-3 a partial refund keeps the pass and flags the order", async () => {
    const u = await host("r3");
    const o = await buy(u, "party");
    assert.equal(await effect("evt_part", { kind: "order_refunded", order_id: o.order_id, refunded_amount_minor: 100 }), "applied");
    const st = await one<Row>("select status, refunded_amount_minor, review_reason from public.pass_orders where id=$1", [o.order_id]);
    assert.deepEqual(st, { status: "partially_refunded", refunded_amount_minor: 100, review_reason: "partial_refund" });
    assert.equal((await ent(u)).plan_code, "party");
  });

  it("disputes revoke the pass", async () => {
    const u = await host("disp");
    const o = await buy(u, "starter");
    assert.equal(await effect("evt_disp", { kind: "order_disputed", polar_order_id: `po_${o.order_id}` }), "applied");
    assert.equal((await access(u)).state, "expired");
  });

  it("R-4/R-5 admin grants need a real admin actor and a reason; they are audited", async () => {
    const boss = await host("grant-boss");
    await db.query("update public.profiles set role='super_admin' where id=$1", [boss]);
    const u = await host("granted");
    assert.match((await errorOf(as(db, svc, () => db.query("select public.admin_grant_pass($1,$2,'party',7,'  ')", [boss, u])))) ?? "", /reason_required/);
    assert.match((await errorOf(as(db, svc, () => db.query("select public.admin_grant_pass($1,$2,'party',7,'x')", [u, u])))) ?? "", /forbidden/);
    assert.match((await errorOf(as(db, user(boss), () => db.query("select public.admin_grant_pass($1,$2,'party',7,'x')", [boss, u])))) ?? "", /permission denied/);
    await as(db, svc, () => db.query("select public.admin_grant_pass($1,$2,'party',7,'prize for the quiz night')", [boss, u]));
    const e = await ent(u);
    assert.deepEqual([e.plan_code, e.source], ["party", "admin_grant"]);
    assert.equal(Number((await segs(u))[0].secs), WEEK);
    const ev = await one<{ actor_kind: string; actor_id: string }>("select actor_kind, actor_id from public.entitlement_events where user_id=$1 and action='pass_granted'", [u]);
    assert.deepEqual(ev, { actor_kind: "admin", actor_id: boss });
  });

  it("R-6 admin revoke, and paid passes cannot be re-planned or re-dated by admins", async () => {
    const u = await host("r6");
    await buy(u, "party");
    assert.match((await errorOf(as(db, svc, () => db.query("select public.admin_set_subscription($1,'set_plan','pro')", [u])))) ?? "", /paid_pass_immutable/);
    assert.match((await errorOf(as(db, svc, () => db.query("select public.admin_set_subscription($1,'set_expiry',null,null,now() + interval '30 days')", [u])))) ?? "", /paid_pass_immutable/);
    const p = await one<{ id: string }>("select id from public.game_passes where user_id=$1", [u]);
    await as(db, svc, () => db.query("select public.admin_revoke_pass(null,$1,'chargeback by phone')", [p.id]));
    assert.equal((await access(u)).state, "expired");
    assert.match((await errorOf(as(db, svc, () => db.query("select public.admin_revoke_pass(null,$1,'again')", [p.id])))) ?? "", /pass_not_revocable/);
  });

  it("R-7 suspension blocks hosting while pass time keeps running; unsuspend restores", async () => {
    const u = await host("r7");
    await buy(u, "starter");
    await as(db, svc, () => db.query("select public.admin_set_suspended(null,$1,true,'abuse report')", [u]));
    assert.equal((await access(u)).state, "suspended");
    assert.match((await errorOf(as(db, user(u), () => db.query("insert into public.games (owner_id, title) values ($1,'x')", [u])))) ?? "", /subscription_required/);
    await shiftLedger(db, u, DAY);
    await as(db, svc, () => db.query("select public.admin_set_suspended(null,$1,false,'resolved')", [u]));
    assert.equal((await access(u)).state, "active");
    assert.ok(Math.abs(Number((await timeline(u))[0].remaining_seconds) - 6 * DAY) < 5, "the suspended day was consumed");
  });
});

describe("games: capacity follows the pass", () => {
  const create = async (u: string) =>
    (await as(db, user(u), () => db.query<{ game_id: string; code: string }>("select * from public.create_game_with_rounds('Pass game', array['a','b'])"))).rows[0];
  const joinN = async (code: string, k: number, prefix: string) => {
    for (let i = 0; i < k; i++) await as(db, svc, () => db.query("select * from public.join_game($1,$2,$3,null)", [code, `${prefix}${i}`, hashToken(generatePlayerToken())]));
  };
  const transition = async (u: string, g: string, action: string) => {
    const v = (await one<{ v: string }>("select state_version::text v from public.games where id=$1", [g])).v;
    return as(db, user(u), () => db.query("select public.game_transition($1,$2,$3,null)", [g, action, Number(v)]));
  };

  it("G-1 a Party room holds 50 and a trial room 3 (not the platform default of 20)", async () => {
    const u = await host("g1");
    await buy(u, "party");
    const g = await create(u);
    assert.equal((await one<{ max_players: number }>("select max_players from public.games where id=$1", [g.game_id])).max_players, 50);
    const t = await host("g1t");
    await confirmUser(db, t);
    const tg = await create(t);
    await joinN(tg.code, 3, "p");
    assert.match((await errorOf(joinN(tg.code, 1, "q"))) ?? "", /game_full/);
  });

  it("G-2 upgrading during a lobby raises its capacity immediately", async () => {
    const u = await host("g2");
    await buy(u, "starter");
    const g = await create(u);
    await joinN(g.code, 10, "p");
    assert.match((await errorOf(joinN(g.code, 1, "x"))) ?? "", /game_full/);
    await buy(u, "pro");
    assert.equal((await one<{ max_players: number }>("select max_players from public.games where id=$1", [g.game_id])).max_players, 100);
    assert.equal(await errorOf(joinN(g.code, 1, "y")), null);
    const info = (await as(db, svc, () => db.query<{ max_players: number }>("select * from public.public_room_info($1)", [g.code]))).rows[0];
    assert.equal(info.max_players, 100);
  });

  it("G-3 a downgrade-by-expiry blocks starting an over-full room until players are removed", async () => {
    const u = await host("g3");
    await buy(u, "party");
    await buy(u, "starter");
    const g = await create(u);
    await joinN(g.code, 11, "p");
    await endCurrentPass(db, u);   // Party ends; queued Starter (10) is now active
    assert.match((await errorOf(transition(u, g.game_id, "start_game"))) ?? "", /player_limit_exceeded/);
    await db.query("update public.players set kicked_at = now() where id = (select id from public.players where game_id=$1 limit 1)", [g.game_id]);
    assert.equal(await errorOf(transition(u, g.game_id, "start_game")), null);
    assert.equal((await one<{ max_players: number }>("select max_players from public.games where id=$1", [g.game_id])).max_players, 10);
  });

  it("G-5 without a pass: no create/start, but an open lobby can still be cancelled", async () => {
    const u = await host("g5");
    await buy(u, "starter");
    const g = await create(u);
    await joinN(g.code, 1, "p");
    await endCurrentPass(db, u);
    assert.match((await errorOf(transition(u, g.game_id, "start_game"))) ?? "", /subscription_required/);
    assert.equal(await errorOf(transition(u, g.game_id, "cancel")), null);
  });
});

describe("RLS, privileges and ledger immutability", () => {
  it("S-1 no client role can write any ledger/payment table", async () => {
    const u = await host("s1");
    for (const actor of [user(u), { role: "anon" } as const]) {
      for (const t of ["game_passes", "pass_segments", "pass_orders", "payment_events", "entitlement_events", "plan_prices"]) {
        const e = await errorOf(as(db, actor, () => db.query(`delete from public.${t}`)));
        assert.match(e ?? "", /permission denied/, `${actor.role} delete ${t}`);
        const i = await errorOf(as(db, actor, () => db.query(`insert into public.${t} default values`)));
        assert.match(i ?? "", /permission denied/, `${actor.role} insert ${t}`);
      }
    }
  });

  it("S-2 hosts read only their own ledger, and never admin notes or Polar ids", async () => {
    const a = await host("s2a");
    const b = await host("s2b");
    await buy(a, "starter");
    await buy(b, "party");
    const mine = await as(db, user(a), () => db.query<{ user_id: string }>("select user_id from public.game_passes"));
    assert.deepEqual([...new Set(mine.rows.map((r) => r.user_id))], [a]);
    const orders = await as(db, user(a), () => db.query<{ user_id: string }>("select user_id from public.pass_orders"));
    assert.deepEqual([...new Set(orders.rows.map((r) => r.user_id))], [a]);
    assert.match((await errorOf(as(db, user(a), () => db.query("select grant_reason from public.game_passes")))) ?? "", /permission denied/);
    assert.match((await errorOf(as(db, user(a), () => db.query("select polar_order_id from public.pass_orders")))) ?? "", /permission denied/);
    assert.match((await errorOf(as(db, user(a), () => db.query("select * from public.payment_events")))) ?? "", /permission denied/);
    assert.equal((await as(db, user(a), () => db.query("select * from public.entitlement_events"))).rows.length, 0, "audit log is admin-only");
    const own = await as(db, user(a), () => db.query<{ plan_code: string }>("select plan_code from public.my_pass_timeline()"));
    assert.deepEqual(own.rows.map((r) => r.plan_code), ["starter"]);
    assert.match((await errorOf(as(db, user(a), () => db.query("select * from public.admin_pass_timeline($1)", [b])))) ?? "", /forbidden/);
  });

  it("S-6 server-only functions are not callable by clients", async () => {
    const u = await host("s6");
    for (const sql of [
      "select public.apply_payment_event('polar','e','t','{}','{}')",
      "select * from public.create_pass_order($1,'starter','PHP')",
      "select public.admin_grant_pass(null,$1,'pro',30,'x')",
      "select public.replan_passes($1)",
      "select public.grant_pass($1,$1,'purchase',1,null,'host',null,null)",
    ]) {
      for (const actor of [user(u), { role: "anon" } as const]) {
        const params = sql.includes("$1") ? [u] : [];
        assert.match((await errorOf(as(db, actor, () => db.query(sql, params)))) ?? "", /permission denied/, `${actor.role}: ${sql}`);
      }
    }
  });

  it("S-3/S-4 audit rows and consumed time are immutable, even for trusted roles", async () => {
    const u = await host("s3");
    await buy(u, "starter");
    await shiftLedger(db, u, DAY);
    assert.match((await errorOf(db.query("update public.entitlement_events set action='x' where user_id=$1", [u]))) ?? "", /audit_log_append_only/);
    assert.match((await errorOf(db.query("delete from public.entitlement_events where user_id=$1", [u]))) ?? "", /audit_log_append_only/);
    assert.match((await errorOf(db.query("update public.pass_segments set starts_at = starts_at + interval '1 hour' where user_id=$1", [u]))) ?? "", /ledger_history_immutable/);
    assert.match((await errorOf(db.query("delete from public.pass_segments where user_id=$1", [u]))) ?? "", /ledger_history_immutable/);
    assert.match((await errorOf(db.query("delete from public.game_passes where user_id=$1", [u]))) ?? "", /ledger_rows_are_never_deleted/);
    assert.match((await errorOf(db.query("delete from public.pass_orders where user_id=$1", [u]))) ?? "", /orders_are_never_deleted/);
    assert.match((await errorOf(db.query("update public.pass_orders set status='pending' where user_id=$1", [u]))) ?? "", /invalid_order_transition/);
    assert.match((await errorOf(db.query("delete from auth.users where id=$1", [u]))) ?? "", /foreign key|violates/, "the ledger blocks hard-deleting a host");
  });

  it("legacy subscriptions are frozen after the cutover", async () => {
    const u = await host("frozen");
    const e = await errorOf(as(db, svc, () => db.query(
      "insert into public.subscriptions (user_id, plan_id, current_period_end) select $1, id, now() + interval '1 day' from public.subscription_plans where code='party'", [u])));
    assert.match(e ?? "", /subscriptions_frozen/);
  });
});

// ------------------------------------------------------------------ migration ----
/** Shim + migrations up to (not including) the Game Pass files, plus live-shaped data. */
async function preGamePassDb(): Promise<PGlite> {
  const d = newPGlite();
  await d.exec(readFileSync(join(import.meta.dirname, "supabase-shim.sql"), "utf8"));
  for (const f of allFiles.filter((x) => x < "20261112")) await d.exec(readFileSync(join(migrationsDir, f), "utf8"));
  return d;
}
const applyGamePass = async (d: PGlite) => { for (const f of GAME_PASS_FILES) await d.exec(readFileSync(join(migrationsDir, f), "utf8")); };
const counts = async (d: PGlite) => Object.fromEntries(await Promise.all(
  ["profiles", "subscription_plans", "subscriptions", "games", "game_rounds", "players", "submissions"].map(async (t) =>
    [t, Number((await d.query<{ n: string }>(`select count(*)::text n from public.${t}`)).rows[0].n)] as const)));

/** Mirrors the hosted project (audit §2): 1 admin, 1 Starter host with a 30-day manual
 *  subscription, 2 games (finished + lobby), rounds, a player — plus extra history shapes. */
async function seedLiveShape(d: PGlite) {
  const ids = (await d.query<{ id: string; email: string }>(`insert into auth.users (email, email_confirmed_at) select e, now() from unnest(array[
    'admin@x.io', 'starter@x.io', 'lapsed@x.io', 'canceled@x.io', 'paused@x.io', 'never@x.io']) e returning id, email`)).rows;
  const id = (e: string) => ids.find((x) => x.email === e)!.id;
  await d.query("update public.profiles set role='super_admin' where id=$1", [id("admin@x.io")]);
  const ins = (email: string, plan: string, status: string, start: string, end: string) => d.query(
    `insert into public.subscriptions (user_id, plan_id, status, current_period_start, current_period_end)
     select $1, id, $2::public.subscription_status, now() + $3::interval, now() + $4::interval from public.subscription_plans where code=$5`,
    [id(email), status, start, end, plan]);
  await ins("starter@x.io", "starter", "active", "-2 minutes", "30 days -2 minutes");
  await ins("lapsed@x.io", "party", "active", "-40 days", "-10 days");
  await ins("canceled@x.io", "pro", "canceled", "-5 days", "25 days");
  await ins("paused@x.io", "party", "suspended", "-1 day", "29 days");
  const sub = id("starter@x.io");
  const g = (await d.query<{ id: string }>(
    "insert into public.games (owner_id, title) values ($1,'Night one') returning id", [sub])).rows[0].id;
  await d.query("insert into public.game_rounds (game_id, round_no, prompt) select $1, n, 'item ' || n from generate_series(1,5) n", [g]);
  await d.query("update public.games set status='lobby' where id=$1", [g]);
  await d.query("insert into public.players (game_id, nickname, token_hash) values ($1,'Sam',$2)", [g, hashToken(generatePlayerToken())]);
  return { id };
}

describe("migration: backfill, re-runs, equivalence and revert", () => {
  it("M-1/M-2/M-3/M-4 backfills live-shaped data exactly, keeps every row, and is re-runnable", async () => {
    const d = await preGamePassDb();
    const { id } = await seedLiveShape(d);
    const before = await counts(d);
    const oldState = async () => (await d.query<{ uid: string; state: string; plan_code: string | null; end: string | null }>(
      "select p.id uid, a.state, a.plan_code, a.current_period_end::text \"end\" from public.profiles p cross join lateral public.access_state_for(p.id) a where p.role='subscriber' order by p.id")).rows;
    const legacyView = await oldState();
    const subRow = (await d.query<{ s: string; e: string }>("select current_period_start::text s, current_period_end::text e from public.subscriptions where user_id=$1", [id("starter@x.io")])).rows[0];

    await applyGamePass(d);
    const after = await counts(d);
    assert.deepEqual(after, { ...before, subscription_plans: before.subscription_plans + 1 }, "only the trial plan is added");

    // M-1: exact interval, plan and cap preserved for the live manual grant
    const s = (await d.query<{ s: string; e: string; source: string; max_players: number }>(
      `select sg.starts_at::text s, sg.ends_at::text e, p.source::text source, p.max_players
         from public.pass_segments sg join public.game_passes p on p.id = sg.pass_id where sg.user_id=$1`, [id("starter@x.io")])).rows;
    assert.deepEqual(s, [{ s: subRow.s, e: subRow.e, source: "legacy_subscription", max_players: 10 }]);

    // M-4: every subscriber's state and plan are identical under the new resolution, and
    // running access (active/suspended) ends at exactly the same instant. Known, intended
    // difference: a CANCELED legacy row now shows when access really stopped instead of the
    // period's nominal end (MIGRATION_VERIFICATION.md).
    const comparable = (rows: typeof legacyView) => rows.map((r) => ({ ...r, end: ["active", "suspended"].includes(r.state) ? r.end : null }));
    assert.deepEqual(comparable(await oldState()), comparable(legacyView));
    assert.deepEqual(legacyView.map((r) => r.state).sort(), ["active", "expired", "expired", "pending", "suspended"]);

    // M-3: history shapes
    const disp = async (email: string) => (await d.query<{ disposition: string; end_reason: string | null }>(
      "select disposition::text, end_reason from public.game_passes where user_id=$1", [id(email)])).rows[0];
    assert.deepEqual(await disp("lapsed@x.io"), { disposition: "granted", end_reason: null });
    assert.deepEqual(await disp("canceled@x.io"), { disposition: "revoked", end_reason: "legacy_canceled" });
    assert.equal((await d.query("select 1 from public.profiles where id=$1 and hosting_suspended_at is not null", [id("paused@x.io")])).rows.length, 1);
    const tl = (await d.query<{ state: string }>("select state from public.pass_timeline_for($1)", [id("lapsed@x.io")])).rows;
    assert.deepEqual(tl.map((r) => r.state), ["consumed"]);
    // legacy hosts can't take the trial
    const el = (await d.query<{ reason: string }>("select * from public.trial_eligibility($1)", [id("starter@x.io")])).rows[0];
    assert.equal(el.reason, "has_paid_history");
    assert.equal((await d.query<{ e: boolean }>("select eligible e from public.trial_eligibility($1)", [id("never@x.io")])).rows[0].e, true);

    // M-2: re-running every Game Pass file changes nothing
    const passes = (await d.query<{ n: string }>("select count(*)::text n from public.game_passes")).rows[0].n;
    const events = (await d.query<{ n: string }>("select count(*)::text n from public.entitlement_events")).rows[0].n;
    await applyGamePass(d);
    assert.equal((await d.query<{ n: string }>("select count(*)::text n from public.game_passes")).rows[0].n, passes);
    assert.equal((await d.query<{ n: string }>("select count(*)::text n from public.entitlement_events")).rows[0].n, events);
    assert.deepEqual(await counts(d), after);
    assert.deepEqual(comparable(await oldState()), comparable(legacyView));

    // existing game keeps working: the lobby still accepts its plan's players and can start
    const lobby = (await d.query<{ id: string; code: string; v: string }>("select id, join_code code, state_version::text v from public.games where owner_id=$1", [id("starter@x.io")])).rows[0];
    await as(d, svc, () => d.query("select * from public.join_game($1,'Ana',$2,null)", [lobby.code, hashToken(generatePlayerToken())]));
    const v = (await d.query<{ v: string }>("select state_version::text v from public.games where id=$1", [lobby.id])).rows[0].v;
    await as(d, user(id("starter@x.io")), () => d.query("select public.game_transition($1,'start_game',$2,null)", [lobby.id, Number(v)]));
  });

  it("stops before changing anything when a running legacy subscription starts in the future", async () => {
    const d = await preGamePassDb();
    const u = (await d.query<{ id: string }>("insert into auth.users (email) values ('future@x.io') returning id")).rows[0].id;
    await d.query(`insert into public.subscriptions (user_id, plan_id, status, current_period_start, current_period_end)
      select $1, id, 'active', now() + interval '1 day', now() + interval '8 days' from public.subscription_plans where code='party'`, [u]);
    for (const f of GAME_PASS_FILES.filter((x) => x < "20261112000006")) await d.exec(readFileSync(join(migrationsDir, f), "utf8"));
    const backfill = readFileSync(join(migrationsDir, "20261112000006_legacy_backfill.sql"), "utf8");
    assert.match((await errorOf(d.exec(`begin;\n${backfill}\ncommit;`))) ?? "", /starting in the future/);
    await d.exec("rollback");
    assert.equal((await d.query("select 1 from public.game_passes")).rows.length, 0);
    const cut = readFileSync(join(migrationsDir, "20261112000007_entitlement_cutover.sql"), "utf8");
    assert.match((await errorOf(d.exec(`begin;\n${cut}\ncommit;`))) ?? "", /running subscriptions without a legacy pass/);
    await d.exec("rollback");
  });

  it("M-5 the compensating revert restores the legacy functions without losing access", async () => {
    const d = await preGamePassDb();
    const { id } = await seedLiveShape(d);
    await applyGamePass(d);
    // after cutover: a brand-new host buys Pro (exists only in the ledger)
    const buyer = (await d.query<{ id: string }>("insert into auth.users (email) values ('buyer@x.io') returning id")).rows[0].id;
    await d.query("update public.plan_prices set polar_product_id = 'prod_pro' where currency='PHP' and plan_id=(select id from public.subscription_plans where code='pro')");
    const o = (await as(d, svc, () => d.query<{ order_id: string }>("select * from public.create_pass_order($1,'pro','PHP')", [buyer]))).rows[0];
    await as(d, svc, () => d.query("select public.apply_payment_event('polar','e1','order.paid','{}',$1)", [JSON.stringify({
      kind: "order_paid", order_id: o.order_id, polar_order_id: "po_1", polar_product_id: "prod_pro", currency: "PHP", amount_minor: 29900 })]));
    const st = async () => (await d.query<{ email: string; state: string; plan_code: string | null }>(
      "select p.email, a.state, a.plan_code from public.profiles p cross join lateral public.access_state_for(p.id) a where p.role='subscriber' order by p.email")).rows;
    const cutover = await st();

    await d.exec(readFileSync(join(import.meta.dirname, "..", "..", "supabase", "rollback", "20261112000007_entitlement_cutover_revert.sql"), "utf8"));
    assert.deepEqual(await st(), cutover, "same access under the legacy functions");
    const legacyEnt = (await d.query<{ plan_code: string; max_players_per_game: number }>("select * from public.entitlement_for($1)", [buyer])).rows[0];
    assert.deepEqual([legacyEnt.plan_code, legacyEnt.max_players_per_game], ["pro", 100]);
    const src = (await d.query<{ src: string }>("select prosrc src from pg_proc where proname='game_transition'")).rows[0].src;
    assert.doesNotMatch(src, /pass_entitlement/, "legacy game_transition restored");
    assert.equal((await d.query("select 1 from public.game_passes")).rows.length > 0, true, "ledger kept");
    assert.ok(id("starter@x.io"));

    // re-apply the whole Game Pass sequence: projections are not converted again, same states
    const passCount = (await d.query<{ n: string }>("select count(*)::text n from public.game_passes")).rows[0].n;
    await applyGamePass(d);
    assert.deepEqual(await st(), cutover);
    assert.equal((await d.query<{ n: string }>("select count(*)::text n from public.game_passes")).rows[0].n, passCount, "no duplicate passes");
  });
});
