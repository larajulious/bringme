/** Phase 8: purchase history, plan/price management, revenue (migration 20261112000013). */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";

import { as, confirmUser, createDb, createUser, errorOf } from "./harness.ts";

const svc = { role: "service_role" } as const;
const user = (sub: string) => ({ role: "authenticated", sub }) as const;
const PRODUCT: Record<string, string> = { starter: "11111111-1111-4111-8111-111111111111", party: "22222222-2222-4222-8222-222222222222", pro: "33333333-3333-4333-8333-333333333333" };
let db: PGlite;
let boss: string;
let n = 0;
const host = () => createUser(db, `adm-${++n}@example.com`);
const planId = async (code: string) => (await db.query<{ id: string }>("select id from public.subscription_plans where code=$1", [code])).rows[0].id;
let evt = 0;
async function buy(u: string, plan: string, currency: "PHP" | "USD" = "PHP", env: "sandbox" | "production" = "sandbox") {
  const o = (await as(db, svc, () => db.query<{ order_id: string; amount_minor: number }>(
    "select * from public.start_checkout_order($1,$2,$3,$4,$5)", [u, plan, currency, env, PRODUCT[plan]]))).rows[0];
  const co = `co_adm_${++evt}`;
  await as(db, svc, () => db.query("select public.attach_verified_checkout($1,$2,$3,$4,$5,null,$6,now() + interval '1 hour')", [o.order_id, co, PRODUCT[plan], currency.toLowerCase(), o.amount_minor, `https://x.polar.sh/${co}`]));
  await as(db, svc, () => db.query("select public.apply_payment_event('polar',$1,'order.paid','{}',$2)", [`e_${co}`, JSON.stringify({
    kind: "order_paid", order_id: o.order_id, polar_order_id: `po_${co}`, polar_checkout_id: co, polar_product_id: PRODUCT[plan],
    external_customer_id: u, currency, amount_minor: o.amount_minor, environment: env })]));
  return { order: o.order_id, amount: o.amount_minor, co };
}
const refund = (o: { order: string; amount: number; co: string }, amount: number, full: boolean) =>
  as(db, svc, () => db.query("select public.apply_payment_event('polar',$1,'order.refunded','{}',$2)", [`r_${o.co}_${amount}`, JSON.stringify({
    kind: "order_refunded", order_id: o.order, refunded_amount_minor: amount, full })]));

before(async () => {
  db = await createDb();
  boss = await host();
  await db.query("update public.profiles set role='super_admin' where id=$1", [boss]);
});

describe("purchase history", () => {
  it("hosts see only their own orders, with price, currency, status, activation/expiry and refund", async () => {
    const a = await host();
    const b = await host();
    const o1 = await buy(a, "starter", "PHP");
    const o2 = await buy(a, "party", "USD");
    await refund(o2, 349, true);
    await buy(b, "pro");
    const rows = (await as(db, user(a), () => db.query<Record<string, unknown>>("select * from public.my_purchase_history()"))).rows;
    assert.equal(rows.length, 2);
    const starter = rows.find((r) => r.order_id === o1.order)!;
    assert.deepEqual([starter.plan_code, starter.currency, starter.amount_minor, starter.status, starter.pass_state], ["starter", "PHP", 9900, "paid", "active"]);
    assert.ok(starter.activated_at && starter.expires_at, "activation and expiry dates");
    const party = rows.find((r) => r.order_id === o2.order)!;
    assert.deepEqual([party.currency, party.status, party.refunded_amount_minor, party.pass_state], ["USD", "refunded", 349, "revoked"]);
  });

  it("admin history requires a super admin session", async () => {
    const a = await host();
    await buy(a, "starter");
    assert.equal((await as(db, user(boss), () => db.query("select * from public.admin_purchase_history($1)", [a]))).rows.length, 1);
    assert.match((await errorOf(as(db, user(a), () => db.query("select * from public.admin_purchase_history($1)", [a])))) ?? "", /forbidden/);
    assert.match((await errorOf(as(db, { role: "anon" }, () => db.query("select * from public.my_purchase_history()")))) ?? "", /permission denied/);
  });
});

describe("plan and price management (audited, never touches Polar)", () => {
  it("a price change keeps the old row as history, creates a new active one, and is audited", async () => {
    const p = await planId("party");
    const before = (await db.query<{ id: string }>("select id from public.plan_prices where plan_id=$1 and currency='PHP' and is_active", [p])).rows[0].id;
    const after = (await as(db, svc, () => db.query<{ id: string }>("select public.admin_set_plan_price($1,$2,'PHP',20900) id", [boss, p]))).rows[0].id;
    assert.notEqual(after, before);
    const rows = (await db.query<{ id: string; amount_minor: number; is_active: boolean }>("select id, amount_minor, is_active from public.plan_prices where plan_id=$1 and currency='PHP' order by created_at", [p])).rows;
    assert.deepEqual(rows.map((r) => [r.amount_minor, r.is_active]), [[19900, false], [20900, true]]);
    const audit = (await db.query<{ action: string; details: { before_minor: number; after_minor: number } }>("select action, details from public.admin_audit_events where target='party' order by id desc limit 1")).rows[0];
    assert.deepEqual([audit.action, audit.details.before_minor, audit.details.after_minor], ["plan_price_changed", 19900, 20900]);
    // orders made at the old price keep pointing at it
    const u = await host();
    await as(db, svc, () => db.query("select public.admin_set_plan_price($1,$2,'PHP',19900)", [boss, p]));
    const o = await buy(u, "party");
    assert.equal((await db.query<{ amount_minor: number }>("select amount_minor from public.pass_orders where id=$1", [o.order])).rows[0].amount_minor, 19900);
  });

  it("refuses invalid currencies, non-zero trial prices, zero paid prices and non-admin actors", async () => {
    const trial = await planId("trial");
    const starter = await planId("starter");
    const call = (actor: string, plan: string, cur: string, amount: number) => errorOf(as(db, svc, () => db.query("select public.admin_set_plan_price($1,$2,$3,$4)", [actor, plan, cur, amount])));
    assert.match((await call(boss, starter, "EUR", 100)) ?? "", /invalid_currency/);
    assert.match((await call(boss, trial, "PHP", 100)) ?? "", /trial_price_must_be_zero/);
    assert.match((await call(boss, starter, "USD", 0)) ?? "", /paid_price_must_be_positive/);
    const h = await host();
    assert.match((await call(h, starter, "USD", 299)) ?? "", /forbidden/);
    assert.match((await errorOf(as(db, user(boss), () => db.query("select public.admin_set_plan_price($1,$2,'USD',299)", [boss, starter])))) ?? "", /permission denied/, "service role only");
  });

  it("plan edits: name, capacity and availability; sold passes keep their cap; price/tier fields can't be edited here", async () => {
    const p = await planId("starter");
    const u = await host();
    await buy(u, "starter");
    await as(db, svc, () => db.query("select public.admin_update_plan($1,$2,$3)", [boss, p, JSON.stringify({ name: "Starter+", max_players_per_game: 12 })]));
    assert.equal((await db.query<{ m: number }>("select max_players_per_game m from public.pass_entitlement($1)", [u])).rows[0].m, 10, "sold pass keeps 10");
    assert.match((await errorOf(as(db, svc, () => db.query("select public.admin_update_plan($1,$2,$3)", [boss, p, JSON.stringify({ price_cents: 1 })])))) ?? "", /field_not_editable/);
    assert.match((await errorOf(as(db, svc, () => db.query("select public.admin_update_plan($1,$2,$3)", [boss, p, JSON.stringify({ tier: 9 })])))) ?? "", /field_not_editable/);
    await as(db, svc, () => db.query("select public.admin_update_plan($1,$2,$3)", [boss, p, JSON.stringify({ name: "Starter", max_players_per_game: 10 })]));
    assert.ok((await db.query("select 1 from public.admin_audit_events where action='plan_updated' and target='starter'")).rows.length >= 2);
  });

  it("trial availability: an unavailable Free Trial plan grants no new trials", async () => {
    const t = await planId("trial");
    await as(db, svc, () => db.query("select public.admin_update_plan($1,$2,$3)", [boss, t, JSON.stringify({ is_active: false })]));
    const u = await host();
    await confirmUser(db, u);
    assert.equal((await db.query("select 1 from public.game_passes where user_id=$1", [u])).rows.length, 0);
    await as(db, svc, () => db.query("select public.admin_update_plan($1,$2,$3)", [boss, t, JSON.stringify({ is_active: true })]));
  });

  it("catalogue audit log is admin-readable only and append-only", async () => {
    const h = await host();
    assert.equal((await as(db, user(h), () => db.query("select * from public.admin_audit_events"))).rows.length, 0);
    assert.ok((await as(db, user(boss), () => db.query("select * from public.admin_audit_events"))).rows.length > 0);
    assert.match((await errorOf(db.query("delete from public.admin_audit_events"))) ?? "", /audit_log_append_only/);
  });
});

describe("manual grants, extensions, revocations", () => {
  it("extension = complimentary days of the current plan, queued after the paid pass (paid pass untouched)", async () => {
    const u = await host();
    await buy(u, "party");
    await as(db, svc, () => db.query("select public.admin_grant_pass($1,$2,'party',3,'Extension: outage')", [boss, u]));
    const t = (await db.query<{ source: string; state: string; duration_seconds: string }>("select source::text, state, duration_seconds::text from public.pass_timeline_for($1) order by seq", [u])).rows;
    assert.deepEqual(t.map((x) => [x.source, x.state]), [["purchase", "active"], ["admin_grant", "queued"]]);
    assert.equal(Number(t[0].duration_seconds), 604_800);
  });

  it("revocation is audited with the admin id and moves access to the next pass", async () => {
    const u = await host();
    await as(db, svc, () => db.query("select public.admin_grant_pass($1,$2,'pro',7,'prize')", [boss, u]));
    await as(db, svc, () => db.query("select public.admin_grant_pass($1,$2,'starter',7,'prize')", [boss, u]));
    const pro = (await db.query<{ id: string }>("select id from public.game_passes where user_id=$1 and max_players=100", [u])).rows[0].id;
    await as(db, svc, () => db.query("select public.admin_revoke_pass($1,$2,'entered by mistake')", [boss, pro]));
    assert.equal((await db.query<{ c: string }>("select plan_code c from public.pass_entitlement($1)", [u])).rows[0].c, "starter");
    const ev = (await db.query<{ actor_id: string }>("select actor_id from public.entitlement_events where pass_id=$1 and action='pass_revoked'", [pro])).rows[0];
    assert.equal(ev.actor_id, boss);
  });
});

describe("revenue reporting", () => {
  it("per environment and currency; gross, refunds, net; complimentary access is not revenue", async () => {
    const fresh = await createDb();
    const save = db; db = fresh;
    try {
      boss = await host();
      await db.query("update public.profiles set role='super_admin' where id=$1", [boss]);
      const a = await host(); const b = await host(); const c = await host();
      await buy(a, "starter", "PHP");                  // 9900
      const p2 = await buy(b, "pro", "PHP");           // 29900, partially refunded 10000
      await refund(p2, 10000, false);
      await buy(c, "party", "USD");                    // 349
      await buy(await host(), "starter", "PHP", "production");   // 9900 production
      const comped = await host();
      await as(db, svc, () => db.query("select public.admin_grant_pass($1,$2,'pro',7,'comp')", [boss, comped]));
      const rows = (await as(db, user(boss), () => db.query<Record<string, unknown>>("select * from public.admin_revenue()"))).rows
        .map((r) => [r.environment, r.currency, Number(r.paid_orders), Number(r.gross_minor), Number(r.refunds_minor), Number(r.net_minor)]);
      assert.deepEqual(rows, [
        ["production", "PHP", 1, 9900, 0, 9900],
        ["sandbox", "PHP", 2, 39800, 10000, 29800],
        ["sandbox", "USD", 1, 349, 0, 349],
      ], "no row mixes currencies or environments");
      const counts = (await as(db, user(boss), () => db.query<{ source: string; passes: string }>("select source::text, passes::text from public.admin_pass_counts()"))).rows;
      assert.deepEqual(Object.fromEntries(counts.map((x) => [x.source, Number(x.passes)])), { purchase: 4, admin_grant: 1 });
      assert.match((await errorOf(as(db, user(a), () => db.query("select * from public.admin_revenue()")))) ?? "", /forbidden/);
    } finally {
      db = save;
    }
  });
});
