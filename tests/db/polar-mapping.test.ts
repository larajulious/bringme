/** Phase 4: order snapshot, verified checkout, webhook environment/product checks (migration 20261112000009). */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";

import { as, createDb, createUser, errorOf } from "./harness.ts";

const svc = { role: "service_role" } as const;
const SANDBOX_STARTER = "11111111-1111-4111-8111-111111111111";
const PROD_STARTER = "99999999-9999-4999-8999-999999999999";
let db: PGlite;
let n = 0;
const host = () => createUser(db, `polar-${++n}@example.com`);
const row = async (id: string) => (await db.query<Record<string, unknown>>(
  "select status::text, currency, amount_minor, polar_environment, polar_product_id, polar_checkout_id, checkout_currency, checkout_amount_minor, review_reason from public.pass_orders where id=$1", [id])).rows[0];
const order = async (u: string, plan = "starter", currency = "PHP", env = "sandbox", product = SANDBOX_STARTER) =>
  (await as(db, svc, () => db.query<{ order_id: string; amount_minor: number; currency: string }>(
    "select * from public.create_checkout_order($1,$2,$3,$4,$5)", [u, plan, currency, env, product]))).rows[0];
const attach = (o: string, checkout: string, product: string, currency: string, amount: number, total: number | null = null) =>
  as(db, svc, async () => (await db.query<{ r: string }>("select public.attach_verified_checkout($1,$2,$3,$4,$5,$6) r", [o, checkout, product, currency, amount, total])).rows[0].r);
let evt = 0;
const paid = (o: string, over: Record<string, unknown>) => as(db, svc, async () => (await db.query<{ r: string }>(
  "select public.apply_payment_event('polar',$1,'order.paid','{}',$2) r", [`e${++evt}`, JSON.stringify({
    kind: "order_paid", order_id: o, polar_order_id: `po_${o}`, polar_product_id: SANDBOX_STARTER, currency: "PHP", amount_minor: 9900,
    environment: "sandbox", ...over })])).rows[0].r);
const passes = async (u: string) => Number((await db.query<{ n: string }>("select count(*)::text n from public.game_passes where user_id=$1", [u])).rows[0].n);

before(async () => { db = await createDb(); });

describe("checkout orders snapshot the server's product mapping", () => {
  it("amount comes from plan_prices for the chosen currency; product + environment are recorded", async () => {
    const u = await host();
    const php = await order(u, "party", "PHP");
    const usd = await order(u, "party", "usd");
    assert.deepEqual([php.amount_minor, php.currency, usd.amount_minor, usd.currency], [19900, "PHP", 349, "USD"]);
    const r = await row(php.order_id);
    assert.deepEqual([r.polar_environment, r.polar_product_id, r.status], ["sandbox", SANDBOX_STARTER, "pending"]);
  });

  it("refuses the trial, unknown currencies, bad environments and malformed product ids", async () => {
    const u = await host();
    assert.match((await errorOf(order(u, "trial"))) ?? "", /plan_not_purchasable/);
    assert.match((await errorOf(order(u, "starter", "EUR"))) ?? "", /invalid_currency/);
    assert.match((await errorOf(order(u, "starter", "PHP", "staging"))) ?? "", /invalid_environment/);
    assert.match((await errorOf(order(u, "starter", "PHP", "sandbox", "prod_starter"))) ?? "", /plan_not_purchasable/);
  });

  it("is server-only", async () => {
    const u = await host();
    for (const sql of ["select * from public.create_checkout_order($1,'starter','PHP','sandbox','11111111-1111-4111-8111-111111111111')",
                       "select public.attach_verified_checkout($1,'c','p','PHP',1,null)", "select public.cancel_unstarted_order($1,'x')"]) {
      assert.match((await errorOf(as(db, { role: "authenticated", sub: u }, () => db.query(sql, [u])))) ?? "", /permission denied/);
    }
  });
});

describe("Polar's checkout response must match exactly", () => {
  it("exact product, currency and amount -> ok, recorded", async () => {
    const o = await order(await host());
    assert.equal(await attach(o.order_id, "co_ok", SANDBOX_STARTER, "php", 9900, 9900), "ok");
    const r = await row(o.order_id);
    assert.deepEqual([r.status, r.polar_checkout_id, r.checkout_currency, r.checkout_amount_minor], ["pending", "co_ok", "PHP", 9900]);
  });

  for (const [label, args, reason] of [
    ["USD charged although PHP was shown", ["usd", 199, 199], "currency_mismatch"],
    ["wrong amount", ["php", 9800, null], "amount_mismatch"],
    ["tax added on top", ["php", 9900, 11088], "total_mismatch"],
  ] as const) {
    it(`${label} -> order canceled, never redirected`, async () => {
      const o = await order(await host());
      assert.equal(await attach(o.order_id, `co_${reason}`, SANDBOX_STARTER, args[0], args[1], args[2]), reason);
      const r = await row(o.order_id);
      assert.deepEqual([r.status, r.review_reason], ["canceled", `checkout_${reason}`]);
    });
  }

  it("wrong product (e.g. a production id answered in sandbox) -> canceled", async () => {
    const o = await order(await host());
    assert.equal(await attach(o.order_id, "co_wrongprod", PROD_STARTER, "php", 9900), "product_mismatch");
  });

  it("a checkout id can't be reused for another order; the snapshot can't be rewritten", async () => {
    const a = await order(await host());
    const b = await order(await host());
    await attach(a.order_id, "co_shared", SANDBOX_STARTER, "php", 9900);
    assert.equal(await attach(b.order_id, "co_shared", SANDBOX_STARTER, "php", 9900), "checkout_reused");
    assert.match((await errorOf(db.query("update public.pass_orders set polar_environment='production' where id=$1", [a.order_id]))) ?? "", /order_snapshot_immutable/);
    assert.match((await errorOf(db.query("update public.pass_orders set checkout_amount_minor=1 where id=$1", [a.order_id]))) ?? "", /order_snapshot_immutable/);
    assert.match((await errorOf(attach(a.order_id, "co_again", SANDBOX_STARTER, "php", 9900))) ?? "", /order_not_attachable/);
  });

  it("a failed Polar request closes the order so it never blocks the host", async () => {
    const u = await host();
    const o = await order(u);
    await as(db, svc, () => db.query("select public.cancel_unstarted_order($1,'polar_unreachable')", [o.order_id]));
    assert.equal((await row(o.order_id)).status, "canceled");
    assert.equal(await passes(u), 0);
  });
});

describe("webhook payment is checked against the order's snapshot", () => {
  it("the right sandbox product, currency and amount grant the pass", async () => {
    const u = await host();
    const o = await order(u);
    await attach(o.order_id, `co_${u}`, SANDBOX_STARTER, "php", 9900);
    assert.equal(await paid(o.order_id, {}), "applied");
    assert.equal(await passes(u), 1);
  });

  it("a payment event from the OTHER environment never pays the order", async () => {
    const u = await host();
    const o = await order(u);
    assert.equal(await paid(o.order_id, { environment: "production" }), "needs_review");
    assert.equal((await row(o.order_id)).review_reason, "environment_mismatch");
    assert.equal(await passes(u), 0);
  });

  it("a different product than the server chose is held for review", async () => {
    const u = await host();
    const o = await order(u);
    assert.equal(await paid(o.order_id, { polar_product_id: PROD_STARTER }), "needs_review");
    assert.equal((await row(o.order_id)).review_reason, "product_mismatch");
  });

  it("USD paid for a PHP order, or a short amount, is held for review", async () => {
    for (const [over, reason] of [[{ currency: "USD", amount_minor: 199 }, "currency_mismatch"], [{ amount_minor: 990 }, "amount_mismatch"]] as const) {
      const u = await host();
      const o = await order(u);
      assert.equal(await paid(o.order_id, over), "needs_review");
      assert.equal((await row(o.order_id)).review_reason, reason);
      assert.equal(await passes(u), 0);
    }
  });
});
