/** Phase 5 checkout flow (lib/billing/checkout-flow.ts) with fake DB + fake Polar. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { startCheckout, returnState, type CheckoutDeps, type StartedOrder } from "../lib/billing/checkout-flow.ts";
import { parseBillingEnv } from "../lib/billing/config.ts";

const P = { starter: "11111111-1111-4111-8111-111111111111", party: "22222222-2222-4222-8222-222222222222", pro: "33333333-3333-4333-8333-333333333333" };
const PRICES: Record<string, Record<string, number>> = { starter: { PHP: 9900, USD: 199 }, party: { PHP: 19900, USD: 349 }, pro: { PHP: 29900, USD: 499 } };
const config = parseBillingEnv({
  NODE_ENV: "development", BILLING_CHECKOUT_ENABLED: "true", POLAR_SERVER: "sandbox", POLAR_ACCESS_TOKEN: "t", POLAR_WEBHOOK_SECRET: "w", POLAR_ORGANIZATION_ID: "44444444-4444-4444-8444-444444444444",
  POLAR_PRODUCT_ID_STARTER: P.starter, POLAR_PRODUCT_ID_PARTY: P.party, POLAR_PRODUCT_ID_PRO: P.pro,
});

type Call = { name: string; args: unknown };
function fakes(opts: {
  polar?: (a: { productId: string; currency: string }) => unknown;
  startOrder?: (a: { planCode: string; currency: string }) => StartedOrder;
  attachResult?: string;
  urlAfter?: number;
} = {}) {
  const calls: Call[] = [];
  let reads = 0;
  const deps: CheckoutDeps = {
    config,
    buyer: { userId: "user-1", email: "host@example.com", ip: "203.0.113.9" },
    siteUrl: "https://bringme.example",
    sleep: async () => {},
    async startOrder(a) {
      calls.push({ name: "startOrder", args: a });
      return opts.startOrder?.(a) ?? { order_id: "order-1", amount_minor: PRICES[a.planCode][a.currency], currency: a.currency, reused: false, in_flight: false, checkout_url: null };
    },
    async readOrderUrl() { reads++; return opts.urlAfter !== undefined && reads >= opts.urlAfter ? "https://sandbox.polar.sh/checkout/same" : null; },
    async createCheckout(a) {
      calls.push({ name: "createCheckout", args: a });
      return opts.polar ? opts.polar(a) : {
        id: "co_1", url: "https://sandbox.polar.sh/checkout/co_1", status: "open", product_id: a.productId,
        currency: a.currency.toLowerCase(), amount: PRICES[a.planCode][a.currency], discount_amount: 0, tax_amount: null,
        total_amount: PRICES[a.planCode][a.currency], tax_behavior: "inclusive", expires_at: "2026-11-11T13:00:00Z",
      };
    },
    async attach(a) { calls.push({ name: "attach", args: a }); return opts.attachResult ?? "ok"; },
    async cancel(orderId, reason) { calls.push({ name: "cancel", args: { orderId, reason } }); },
  };
  const names = () => calls.map((c) => c.name);
  const arg = (n: string) => calls.find((c) => c.name === n)?.args as Record<string, unknown>;
  return { deps, calls, names, arg };
}

describe("checkout start", () => {
  it("authenticated buyer: server-chosen product, currency and correlation; redirect URL returned", async () => {
    const f = fakes();
    const r = await startCheckout(f.deps, { planCode: "party", currency: "PHP" });
    assert.deepEqual(r, { ok: true, status: 201, url: "https://sandbox.polar.sh/checkout/co_1", reused: false, environment: "sandbox" });
    const c = f.arg("createCheckout");
    assert.equal(c.productId, P.party);
    assert.equal(c.currency, "PHP");
    assert.equal(c.orderId, "order-1", "trusted correlation = our order id");
    assert.equal(c.userId, "user-1", "Polar customer bound to the authenticated user");
    assert.equal(c.customerEmail, "host@example.com");
    assert.match(String(c.successUrl), /\/dashboard\/subscription\/checkout\?checkout_id=\{CHECKOUT_ID\}$/);
    assert.match(String(c.returnUrl), /checkout=canceled/);
    assert.deepEqual((f.arg("attach") as { url: string }).url, "https://sandbox.polar.sh/checkout/co_1");
  });

  it("manipulated body: price, amount, product, user and environment fields are ignored", async () => {
    const f = fakes();
    await startCheckout(f.deps, { planCode: "starter", currency: "USD", amount: 1, amount_minor: 1, price: 0, productId: P.pro, polar_product_id: P.pro, userId: "victim", environment: "production" });
    const c = f.arg("createCheckout");
    assert.equal(c.productId, P.starter);
    assert.equal(c.userId, "user-1");
    assert.equal(Object.keys(c).includes("amount"), false);
    assert.deepEqual(f.arg("startOrder"), { planCode: "starter", currency: "USD", environment: "sandbox", productId: P.starter });
  });

  it("wrong plan id (unknown, trial, injection) and unsupported currency are refused before anything is created", async () => {
    for (const planCode of ["platinum", "trial", "starter' or 1=1", 42, undefined]) {
      const f = fakes();
      assert.deepEqual(await startCheckout(f.deps, { planCode, currency: "PHP" }), { ok: false, status: 400, code: "unknown_plan" });
      assert.deepEqual(f.names(), []);
    }
    for (const currency of ["EUR", "", "php;usd", null]) {
      const f = fakes();
      assert.deepEqual(await startCheckout(f.deps, { planCode: "starter", currency }), { ok: false, status: 400, code: "invalid_currency" });
      assert.deepEqual(f.names(), []);
    }
  });

  it("checkout disabled or a plan without a product mapping -> nothing created", async () => {
    const off = fakes();
    off.deps.config = parseBillingEnv({});
    assert.deepEqual(await startCheckout(off.deps, { planCode: "starter", currency: "PHP" }), { ok: false, status: 503, code: "checkout_unavailable" });
    const partial = fakes();
    partial.deps.config = parseBillingEnv({ NODE_ENV: "development", BILLING_CHECKOUT_ENABLED: "true", POLAR_SERVER: "sandbox", POLAR_ACCESS_TOKEN: "t", POLAR_WEBHOOK_SECRET: "w", POLAR_ORGANIZATION_ID: "44444444-4444-4444-8444-444444444444", POLAR_PRODUCT_ID_STARTER: P.starter });
    assert.deepEqual(await startCheckout(partial.deps, { planCode: "pro", currency: "PHP" }), { ok: false, status: 409, code: "plan_not_purchasable" });
    assert.deepEqual([...off.names(), ...partial.names()], []);
  });

  it("wrong product mapping returned by Polar -> order canceled, no URL", async () => {
    const f = fakes({ polar: (a) => ({ id: "co_x", url: "https://sandbox.polar.sh/c/x", status: "open", product_id: P.pro, currency: a.currency.toLowerCase(), amount: 9900, total_amount: 9900 }) });
    const r = await startCheckout(f.deps, { planCode: "starter", currency: "PHP" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.deepEqual([r.status, r.code], [409, "pricing_unavailable"]);
    assert.deepEqual(f.arg("cancel"), { orderId: "order-1", reason: "product_mismatch" });
  });

  it("Polar charging USD for a PHP choice, or another amount -> refused", async () => {
    for (const over of [{ currency: "usd", amount: 199, total_amount: 199 }, { amount: 9000, total_amount: 9000 }]) {
      const f = fakes({ polar: (a) => Object.assign({ id: "co_y", url: "https://sandbox.polar.sh/c/y", status: "open", product_id: a.productId, currency: "php", amount: 9900, total_amount: 9900 }, over) });
      const r = await startCheckout(f.deps, { planCode: "starter", currency: "PHP" });
      assert.equal(r.ok, false);
      assert.ok(f.names().includes("cancel"));
    }
  });

  it("DB-side mismatch is also refused even if the local check passed", async () => {
    const f = fakes({ attachResult: "checkout_reused" });
    const r = await startCheckout(f.deps, { planCode: "starter", currency: "PHP" });
    assert.equal(r.ok, false);
  });

  it("double click: an open verified checkout is reused (no second Polar session)", async () => {
    const f = fakes({ startOrder: () => ({ order_id: "order-1", amount_minor: 9900, currency: "PHP", reused: true, in_flight: false, checkout_url: "https://sandbox.polar.sh/checkout/co_1" }) });
    const r = await startCheckout(f.deps, { planCode: "starter", currency: "PHP" });
    assert.deepEqual(r, { ok: true, status: 200, url: "https://sandbox.polar.sh/checkout/co_1", reused: true, environment: "sandbox" });
    assert.equal(f.names().includes("createCheckout"), false);
  });

  it("racing click while the first is still talking to Polar: waits and returns the same URL", async () => {
    const inFlight = { order_id: "order-1", amount_minor: 9900, currency: "PHP", reused: false, in_flight: true, checkout_url: null };
    const f = fakes({ startOrder: () => inFlight, urlAfter: 3 });
    const r = await startCheckout(f.deps, { planCode: "starter", currency: "PHP" });
    assert.deepEqual(r, { ok: true, status: 200, url: "https://sandbox.polar.sh/checkout/same", reused: true, environment: "sandbox" });
    assert.equal(f.names().includes("createCheckout"), false);
    const stuck = fakes({ startOrder: () => inFlight });
    const r2 = await startCheckout(stuck.deps, { planCode: "starter", currency: "PHP" });
    assert.equal(r2.ok, false);
    if (!r2.ok) assert.equal(r2.code, "checkout_in_progress");
  });

  it("Polar unreachable or malformed response -> order closed, 502, nothing to redirect to", async () => {
    const down = fakes({ polar: () => { throw new Error("polar_unreachable"); } });
    const r = await startCheckout(down.deps, { planCode: "starter", currency: "PHP" });
    assert.equal(r.ok, false);
    assert.deepEqual(down.arg("cancel"), { orderId: "order-1", reason: "polar_unreachable" });
    const junk = fakes({ polar: () => ({ hello: "world" }) });
    await startCheckout(junk.deps, { planCode: "starter", currency: "PHP" });
    assert.deepEqual(junk.arg("cancel"), { orderId: "order-1", reason: "invalid_response" });
  });

  it("order-level refusals map to stable codes", async () => {
    for (const [msg, status, code] of [["too_many_pending_orders", 429, "too_many_pending_orders"], ["account_suspended", 403, "account_suspended"], ["boom", 500, "order_failed"]] as const) {
      const f = fakes({ startOrder: () => { throw new Error(msg); } });
      assert.deepEqual(await startCheckout(f.deps, { planCode: "starter", currency: "PHP" }), { ok: false, status, code });
    }
  });
});

describe("pricing safety", () => {
  it("a price Polar doesn't charge exactly (needs sync) is refused before any Polar session", async () => {
    const f = fakes();
    f.deps.priceSynced = async () => false;
    const r = await startCheckout(f.deps, { planCode: "starter", currency: "PHP" });
    assert.deepEqual(r, { ok: false, status: 409, code: "pricing_out_of_sync" });
    assert.equal(f.names().includes("createCheckout"), false);
    assert.deepEqual(f.arg("cancel"), { orderId: "order-1", reason: "pricing_out_of_sync" });
  });
  it("an in-sync price proceeds", async () => {
    const f = fakes();
    f.deps.priceSynced = async () => true;
    assert.equal((await startCheckout(f.deps, { planCode: "starter", currency: "PHP" })).ok, true);
  });
});

describe("return page state (never grants)", () => {
  it("success redirect without a paid webhook stays 'pending verification'", () => {
    assert.equal(returnState({ found: true, status: "pending" }, "succeeded"), "pending_verification");
    assert.equal(returnState({ found: true, status: "pending" }, "confirmed"), "pending_verification");
    assert.equal(returnState({ found: true, status: "pending" }, null), "pending_verification");
    assert.equal(returnState({ found: true, status: "paid", passGranted: false }, null), "pending_verification");
  });
  it("only a paid order WITH its pass is 'confirmed'", () => {
    assert.equal(returnState({ found: true, status: "paid", passGranted: true }, null), "confirmed");
  });
  it("failed, expired, canceled, review, unfinished and unknown checkouts", () => {
    assert.equal(returnState({ found: true, status: "pending" }, "failed"), "unsuccessful");
    assert.equal(returnState({ found: true, status: "failed" }, null), "unsuccessful");
    assert.equal(returnState({ found: true, status: "pending" }, "expired"), "expired");
    assert.equal(returnState({ found: true, status: "canceled" }, null), "canceled");
    assert.equal(returnState({ found: true, status: "needs_review" }, null), "review");
    assert.equal(returnState({ found: true, status: "pending" }, "open"), "not_completed");
    assert.equal(returnState({ found: false }, "succeeded"), "not_found");
  });
});
