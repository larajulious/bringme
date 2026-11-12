/**
 * Phase 6 integration: signed Polar webhook -> lib/billing/webhook.ts -> fake Polar API ->
 * REAL apply_payment_event in PGlite (migrations 1..11). Concurrent deliveries on real
 * PostgreSQL: tests/concurrency/engine-concurrency.mjs.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";

import { parseWebhookEnv } from "../../lib/billing/config.ts";
import { handlePolarWebhook, type WebhookDeps } from "../../lib/billing/webhook.ts";
import { as, createDb, createUser, endCurrentPass } from "./harness.ts";

const svc = { role: "service_role" } as const;
const ORG = "44444444-4444-4444-8444-444444444444";
const STARTER = "11111111-1111-4111-8111-111111111111";
const PRO = "33333333-3333-4333-8333-333333333333";
const SECRET = "whsec_" + Buffer.from("bringme-test-webhook-key-0123456789").toString("base64");
const env = (over: Record<string, string> = {}) => parseWebhookEnv({
  NODE_ENV: "development", POLAR_SERVER: "sandbox", POLAR_ACCESS_TOKEN: "t", POLAR_WEBHOOK_SECRET: SECRET, POLAR_ORGANIZATION_ID: ORG, ...over });

let db: PGlite;
let n = 0;
const polarOrders = new Map<string, Record<string, unknown>>();
const polarCheckouts = new Map<string, Record<string, unknown>>();
let failApplyOnce = false;
let failFetchOnce = false;

function deps(config = env()): WebhookDeps {
  return {
    config,
    async fetchOrder(id) { if (failFetchOnce) { failFetchOnce = false; throw new Error("polar_unreachable"); } return polarOrders.get(id) ?? null; },
    async fetchCheckout(id) { return polarCheckouts.get(id) ?? null; },
    async apply(eventId, type, summary, effect) {
      if (failApplyOnce) { failApplyOnce = false; throw new Error("db:08006"); }
      return (await as(db, svc, () => db.query<{ r: string }>("select public.apply_payment_event('polar',$1,$2,$3,$4) r",
        [eventId, type, JSON.stringify(summary), JSON.stringify(effect)]))).rows[0].r;
    },
  };
}

let wh = 0;
function delivery(type: string, data: Record<string, unknown>, opts: { id?: string; secret?: string; ts?: number; tamper?: boolean } = {}) {
  const id = opts.id ?? `msg_${++wh}`;
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ type, timestamp: new Date().toISOString(), data });
  const key = Buffer.from((opts.secret ?? SECRET).slice(6), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
  const headers = new Map([["webhook-id", id], ["webhook-timestamp", ts], ["webhook-signature", `v1,${sig}`]]);
  return { headers: { get: (k: string) => headers.get(k) ?? null }, body: opts.tamper ? body.replace("order", "0rder") : body, id };
}
const send = (d: ReturnType<typeof delivery>, config = env()) => handlePolarWebhook(deps(config), d);

/** A host with a verified Starter PHP checkout (our order snapshot), and Polar's matching order. */
async function purchase(opts: { plan?: "starter" | "pro"; currency?: "PHP" | "USD" } = {}) {
  const plan = opts.plan ?? "starter";
  const product = plan === "starter" ? STARTER : PRO;
  const u = await createUser(db, `wh-${++n}@example.com`);
  const o = (await as(db, svc, () => db.query<{ order_id: string; amount_minor: number }>(
    "select * from public.start_checkout_order($1,$2,$3,'sandbox',$4)", [u, plan, opts.currency ?? "PHP", product]))).rows[0];
  const checkout = `co_${n}`;
  await as(db, svc, () => db.query("select public.attach_verified_checkout($1,$2,$3,$4,$5,null,$6,now() + interval '1 hour')",
    [o.order_id, checkout, product, (opts.currency ?? "PHP").toLowerCase(), o.amount_minor, `https://sandbox.polar.sh/c/${checkout}`]));
  const polarId = `ord_${n}`;
  const amount = o.amount_minor;
  const polar: Record<string, unknown> = {
    id: polarId, status: "paid", paid: true, currency: (opts.currency ?? "PHP").toLowerCase(),
    subtotal_amount: amount, discount_amount: 0, net_amount: amount, tax_amount: 0, total_amount: amount, refunded_amount: 0,
    billing_reason: "purchase", product_id: product, checkout_id: checkout, customer_id: `cus_${n}`,
    customer: { external_id: u, organization_id: ORG }, product: { organization_id: ORG }, metadata: { bringme_order_id: o.order_id },
  };
  polarOrders.set(polarId, polar);
  polarCheckouts.set(checkout, { id: checkout, status: "open" });
  return { u, order: o.order_id, polarId, checkout, polar, amount };
}
const setPolar = (id: string, over: Record<string, unknown>) => polarOrders.set(id, { ...polarOrders.get(id), ...over });
const orderRow = async (id: string) => (await db.query<Record<string, unknown>>(
  "select status::text, polar_order_id, paid_amount_minor, refunded_amount_minor, review_reason from public.pass_orders where id=$1", [id])).rows[0];
const passOf = async (order: string) => (await db.query<{ disposition: string; secs: number }>(
  `select g.disposition::text, coalesce((select sum(extract(epoch from (s.ends_at - s.starts_at))) from public.pass_segments s where s.pass_id = g.id), 0)::float8 secs
     from public.game_passes g where g.order_id=$1`, [order])).rows;
const eventsCount = async () => Number((await db.query<{ n: string }>("select count(*)::text n from public.payment_events")).rows[0].n);
const plan = async (u: string) => (await db.query<{ plan_code: string }>("select plan_code from public.pass_entitlement($1)", [u])).rows[0]?.plan_code ?? null;

before(async () => { db = await createDb(); });

describe("signature gate", () => {
  it("invalid signature, tampered body, wrong secret, stale timestamp -> 403 and NOTHING is stored", async () => {
    const p = await purchase();
    const before = await eventsCount();
    for (const d of [
      delivery("order.paid", { id: p.polarId }, { tamper: true }),
      delivery("order.paid", { id: p.polarId }, { secret: "whsec_" + Buffer.from("attacker").toString("base64") }),
      delivery("order.paid", { id: p.polarId }, { ts: Math.floor(Date.now() / 1000) - 3600 }),
    ]) {
      const r = await send(d);
      assert.deepEqual([r.status, r.body.error], [403, "invalid_signature"]);
    }
    const noHeaders = await handlePolarWebhook(deps(), { headers: { get: () => null }, body: "{}" });
    assert.equal(noHeaders.status, 403);
    assert.equal(await eventsCount(), before);
    assert.equal((await orderRow(p.order)).status, "pending");
    assert.deepEqual(await passOf(p.order), []);
  });

  it("webhook not configured -> 503 (Polar retries), nothing processed", async () => {
    const r = await handlePolarWebhook(deps(parseWebhookEnv({})), delivery("order.paid", { id: "x" }));
    assert.equal(r.status, 503);
  });
});

describe("verified fulfilment", () => {
  it("valid paid order -> one 7-day pass, order paid, Polar order id recorded uniquely", async () => {
    const p = await purchase();
    const r = await send(delivery("order.paid", { id: p.polarId }));
    assert.deepEqual([r.status, r.body.outcomes], [202, ["applied"]]);
    const o = await orderRow(p.order);
    assert.deepEqual([o.status, o.polar_order_id, o.paid_amount_minor], ["paid", p.polarId, 9900]);
    assert.deepEqual(await passOf(p.order), [{ disposition: "granted", secs: 604_800 }]);
    assert.equal(await plan(p.u), "starter");
    const ev = (await db.query<{ action: string }>("select action from public.entitlement_events where order_id=$1 order by id", [p.order])).rows.map((x) => x.action);
    assert.ok(ev.includes("order_paid") && ev.includes("pass_granted"), `audit: ${ev}`);
  });

  it("duplicate order.paid (same delivery id) and a second event for the same order grant nothing more", async () => {
    const p = await purchase();
    const d = delivery("order.paid", { id: p.polarId });
    await send(d);
    assert.deepEqual((await send(d)).body.outcomes, ["duplicate"]);
    assert.deepEqual((await send(delivery("order.updated", { id: p.polarId }))).body.outcomes, ["duplicate_effect"]);
    assert.equal((await passOf(p.order)).length, 1);
    assert.equal((await passOf(p.order))[0].secs, 604_800, "retries never add days");
  });

  it("order.created / pending order -> recorded, no activation", async () => {
    const p = await purchase();
    setPolar(p.polarId, { status: "pending", paid: false });
    const r = await send(delivery("order.created", { id: p.polarId }));
    assert.deepEqual(r.body.outcomes, ["ignored"]);
    assert.equal((await orderRow(p.order)).status, "pending");
    assert.deepEqual(await passOf(p.order), []);
    setPolar(p.polarId, { status: "paid", paid: true });
    assert.deepEqual((await send(delivery("order.paid", { id: p.polarId }))).body.outcomes, ["applied"], "then the real payment activates");
  });

  for (const [label, over, reason] of [
    ["unknown product", { product_id: "99999999-9999-4999-8999-999999999999" }, "product_mismatch"],
    ["wrong customer", { customer: { external_id: "00000000-0000-4000-8000-000000000000", organization_id: ORG } }, "customer_mismatch"],
    ["missing customer correlation", { customer: { organization_id: ORG } }, "customer_mismatch"],
    ["wrong checkout", { checkout_id: "co_someone_else" }, "checkout_mismatch"],
    ["wrong currency", { currency: "usd", total_amount: 199, net_amount: 199 }, "currency_mismatch"],
    ["wrong amount", { total_amount: 990, net_amount: 990 }, "amount_mismatch"],
    ["other organization", { product: { organization_id: "55555555-5555-4555-8555-555555555555" } }, "organization_mismatch"],
    ["subscription billing", { billing_reason: "subscription_create" }, "not_a_one_time_purchase"],
    ["discount applied", { discount_amount: 100 }, "discount_applied"],
  ] as const) {
    it(`${label} -> held for review, no pass`, async () => {
      const p = await purchase();
      setPolar(p.polarId, over);
      const r = await send(delivery("order.paid", { id: p.polarId }));
      assert.deepEqual(r.body.outcomes, ["needs_review"]);
      const o = await orderRow(p.order);
      assert.deepEqual([o.status, o.review_reason], ["needs_review", reason]);
      assert.deepEqual(await passOf(p.order), []);
    });
  }

  it("wrong environment: an event processed by the production config never pays a sandbox order; unknown orders are ignored", async () => {
    const p = await purchase();
    const prodCfg = env({ POLAR_SERVER: "production", VERCEL_ENV: "production" });
    assert.deepEqual((await send(delivery("order.paid", { id: p.polarId }), prodCfg)).body.outcomes, ["needs_review"]);
    assert.equal((await orderRow(p.order)).review_reason, "environment_mismatch");
    const q = await send(delivery("order.paid", { id: "ord_not_in_this_environment" }));
    assert.deepEqual([q.status, q.body.outcomes], [202, ["ignored"]]);
  });

  it("taxes: tax included in the price, or added on top, are both accepted; never more days", async () => {
    const inc = await purchase();
    setPolar(inc.polarId, { net_amount: 8839, tax_amount: 1061, total_amount: 9900 });
    assert.deepEqual((await send(delivery("order.paid", { id: inc.polarId }))).body.outcomes, ["applied"]);
    const exc = await purchase();
    setPolar(exc.polarId, { net_amount: 9900, tax_amount: 1188, total_amount: 11088 });
    assert.deepEqual((await send(delivery("order.paid", { id: exc.polarId }))).body.outcomes, ["applied"]);
    assert.equal((await orderRow(exc.order)).paid_amount_minor, 11088, "what the customer actually paid is recorded");
    assert.equal((await passOf(exc.order))[0].secs, 604_800);
  });
});

describe("failed, abandoned, refunds, ordering, failures", () => {
  it("failed payment (checkout failed) and abandoned checkout (expired) close the order without a pass", async () => {
    const f = await purchase();
    polarCheckouts.set(f.checkout, { id: f.checkout, status: "failed" });
    assert.deepEqual((await send(delivery("checkout.updated", { id: f.checkout }))).body.outcomes, ["applied"]);
    assert.equal((await orderRow(f.order)).status, "failed");
    const a = await purchase();
    polarCheckouts.set(a.checkout, { id: a.checkout, status: "expired" });
    assert.deepEqual((await send(delivery("checkout.expired", { id: a.checkout }))).body.outcomes, ["applied"]);
    assert.equal((await orderRow(a.order)).status, "expired");
    const ok = await purchase();
    polarCheckouts.set(ok.checkout, { id: ok.checkout, status: "succeeded" });
    assert.deepEqual((await send(delivery("checkout.updated", { id: ok.checkout }))).body.outcomes, ["ignored"], "a succeeded checkout alone never grants");
    for (const x of [f, a, ok]) assert.deepEqual(await passOf(x.order), []);
  });

  it("full refund (Polar status 'refunded', tax-inclusive net amount) revokes only THAT order's pass", async () => {
    const other = await purchase();
    await send(delivery("order.paid", { id: other.polarId }));
    // same host buys a second pass, then that one is refunded
    const p = await purchase();
    await send(delivery("order.paid", { id: p.polarId }));
    setPolar(p.polarId, { status: "refunded", net_amount: 8839, tax_amount: 1061, refunded_amount: 8839 });
    assert.deepEqual((await send(delivery("order.refunded", { id: p.polarId }))).body.outcomes, ["duplicate_effect", "applied"]);
    assert.equal((await orderRow(p.order)).status, "refunded");
    assert.equal((await passOf(p.order))[0].disposition, "revoked");
    assert.equal((await passOf(other.order))[0].disposition, "granted", "an unrelated order is untouched");
    assert.ok((await db.query("select 1 from public.pass_orders where id=$1", [p.order])).rows.length === 1, "purchase history kept");
  });

  it("partial refund keeps the pass and flags the order", async () => {
    const p = await purchase();
    await send(delivery("order.paid", { id: p.polarId }));
    setPolar(p.polarId, { status: "partially_refunded", refunded_amount: 2000 });
    await send(delivery("order.refunded", { id: p.polarId }));
    const o = await orderRow(p.order);
    assert.deepEqual([o.status, o.refunded_amount_minor, o.review_reason], ["partially_refunded", 2000, "partial_refund"]);
    assert.equal((await passOf(p.order))[0].disposition, "granted");
  });

  it("out-of-order: refund arrives before paid -> payment recorded then refunded; the late order.paid adds nothing", async () => {
    const p = await purchase();
    setPolar(p.polarId, { status: "refunded", refunded_amount: 9900 });
    assert.deepEqual((await send(delivery("order.refunded", { id: p.polarId }))).body.outcomes, ["applied", "applied"]);
    assert.equal((await orderRow(p.order)).status, "refunded");
    assert.equal((await passOf(p.order))[0].disposition, "revoked");
    assert.deepEqual((await send(delivery("order.paid", { id: p.polarId }))).body.outcomes, ["duplicate_effect", "duplicate_effect"]);
    assert.equal((await passOf(p.order)).length, 1);
    polarCheckouts.set(p.checkout, { id: p.checkout, status: "expired" });
    assert.deepEqual((await send(delivery("checkout.expired", { id: p.checkout }))).body.outcomes, ["ignored"], "a late expiry never undoes a payment");
  });

  it("database failure -> error (route answers 503); Polar's retry of the SAME delivery then applies once", async () => {
    const p = await purchase();
    const d = delivery("order.paid", { id: p.polarId });
    failApplyOnce = true;
    await assert.rejects(send(d));
    assert.equal((await orderRow(p.order)).status, "pending");
    assert.deepEqual((await send(d)).body.outcomes, ["applied"]);
    assert.equal((await passOf(p.order)).length, 1);
  });

  it("a failure INSIDE the fulfilment transaction leaves nothing behind (no event, not paid, no pass); retry succeeds", async () => {
    const p = await purchase();
    await db.exec(`create function public.test_boom() returns trigger language plpgsql as $$ begin raise exception 'simulated_disk_full'; end $$;
                   create trigger test_boom before insert on public.game_passes for each row execute function public.test_boom();`);
    const d = delivery("order.paid", { id: p.polarId });
    try {
      await assert.rejects(send(d), /simulated_disk_full/);
    } finally {
      await db.exec("drop trigger test_boom on public.game_passes; drop function public.test_boom();");
    }
    assert.equal((await db.query("select 1 from public.payment_events where event_id like $1", [`${d.id}%`])).rows.length, 0);
    assert.deepEqual([(await orderRow(p.order)).status, (await passOf(p.order)).length], ["pending", 0]);
    assert.deepEqual((await send(d)).body.outcomes, ["applied"]);
  });

  it("Polar API temporarily down -> error (retry); the retry applies", async () => {
    const p = await purchase();
    const d = delivery("order.paid", { id: p.polarId });
    failFetchOnce = true;
    await assert.rejects(send(d), /polar_unreachable/);
    assert.deepEqual((await send(d)).body.outcomes, ["applied"]);
  });

  it("simultaneous deliveries of the same event (serialised by the DB) grant once", async () => {
    const p = await purchase();
    const d = delivery("order.paid", { id: p.polarId });
    const outs = await Promise.all(Array.from({ length: 5 }, () => send(d)));
    assert.deepEqual(outs.map((o) => o.body.outcomes).flat().sort(), ["applied", "duplicate", "duplicate", "duplicate", "duplicate"]);
    assert.equal((await passOf(p.order)).length, 1);
  });
});

describe("existing access", () => {
  it("existing ACTIVE pass: a cheaper purchase queues after it", async () => {
    const p = await purchase();                 // starter
    await as(db, svc, () => db.query("select public.admin_grant_pass(null,$1,'pro',7,'comp')", [p.u]));
    await send(delivery("order.paid", { id: p.polarId }));
    assert.equal(await plan(p.u), "pro");
    const t = (await db.query<{ plan_code: string; state: string }>("select plan_code, state from public.pass_timeline_for($1) order by seq", [p.u])).rows;
    assert.deepEqual(t.map((x) => [x.plan_code, x.state]), [["pro", "active"], ["starter", "queued"]]);
    await endCurrentPass(db, p.u);
    assert.equal(await plan(p.u), "starter", "the paid days start when Pro ends");
  });

  it("existing QUEUED pass: buying Pro starts now, current pass pauses, queue keeps its days", async () => {
    const p = await purchase({ plan: "pro" });
    await as(db, svc, () => db.query("select public.admin_grant_pass(null,$1,'party',7,'comp')", [p.u]));
    await as(db, svc, () => db.query("select public.admin_grant_pass(null,$1,'starter',7,'comp')", [p.u]));
    await send(delivery("order.paid", { id: p.polarId }));
    assert.equal(await plan(p.u), "pro");
    const order = (await db.query<{ code: string }>(
      `select pl.code from public.pass_segments s join public.game_passes g on g.id=s.pass_id join public.subscription_plans pl on pl.id=g.plan_id
        where s.user_id=$1 order by s.starts_at`, [p.u])).rows.map((r) => r.code);
    assert.deepEqual(order.slice(-3), ["pro", "party", "starter"]);
  });
});
