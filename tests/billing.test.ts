import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { auditProduct } from "../lib/billing/audit.ts";
import { parseBillingEnv, POLAR_API_BASE, publicBillingState, WEBHOOK_HANDLER_READY } from "../lib/billing/config.ts";
import { defaultCurrency, formatMoney, parseCurrency } from "../lib/billing/currency.ts";
import { readCheckoutResponse, verifyCheckout } from "../lib/billing/verify.ts";

const P = { starter: "11111111-1111-4111-8111-111111111111", party: "22222222-2222-4222-8222-222222222222", pro: "33333333-3333-4333-8333-333333333333" };
const sandboxEnv = (over: Record<string, string | undefined> = {}) => ({
  NODE_ENV: "development", BILLING_CHECKOUT_ENABLED: "true", POLAR_SERVER: "sandbox", POLAR_ACCESS_TOKEN: "polar_oat_test",
  POLAR_WEBHOOK_SECRET: "whsec_test", POLAR_ORGANIZATION_ID: "44444444-4444-4444-8444-444444444444", POLAR_PRODUCT_ID_STARTER: P.starter, POLAR_PRODUCT_ID_PARTY: P.party, POLAR_PRODUCT_ID_PRO: P.pro, ...over,
});

describe("billing config: product mapping and environment separation", () => {
  it("maps each paid plan code to its env-configured product in the sandbox API", () => {
    const c = parseBillingEnv(sandboxEnv());
    assert.equal(c.enabled, true);
    if (!c.enabled) return;
    assert.equal(c.environment, "sandbox");
    assert.equal(c.apiBase, "https://sandbox-api.polar.sh");
    assert.deepEqual(c.products, P);
    assert.deepEqual(publicBillingState(c), { checkout: true, environment: "sandbox", plans: ["starter", "party", "pro"] });
    assert.ok(!("trial" in c.products), "the free trial never has a product");
  });

  it("is off by default and when any required setting is missing", () => {
    for (const [over, reason] of [
      [{ BILLING_CHECKOUT_ENABLED: undefined }, "checkout_disabled"],
      [{ POLAR_SERVER: undefined }, "polar_server_missing"],
      [{ POLAR_SERVER: "live" }, "polar_server_invalid"],
      [{ POLAR_ACCESS_TOKEN: "" }, "polar_token_missing"],
      [{ POLAR_WEBHOOK_SECRET: undefined }, "webhook_secret_missing"],
      [{ POLAR_PRODUCT_ID_STARTER: undefined, POLAR_PRODUCT_ID_PARTY: undefined, POLAR_PRODUCT_ID_PRO: undefined }, "no_products_configured"],
      [{ POLAR_PRODUCT_ID_PARTY: "prod_123" }, "invalid_product_id_party"],
      [{ POLAR_PRODUCT_ID_PRO: P.starter }, "duplicate_product_id_starter_pro"],
    ] as const) {
      const c = parseBillingEnv(sandboxEnv(over));
      assert.equal(c.enabled, false, reason);
      if (!c.enabled) assert.ok(c.reasons.includes(reason), `${reason} in ${c.reasons}`);
      assert.deepEqual(publicBillingState(c).plans, []);
    }
  });

  it("a plan without a product is simply not offered (others still are)", () => {
    const c = parseBillingEnv(sandboxEnv({ POLAR_PRODUCT_ID_PRO: undefined }));
    assert.equal(c.enabled, true);
    assert.deepEqual(publicBillingState(c).plans, ["starter", "party"]);
  });

  it("never crosses sandbox and production", () => {
    const prodOutside = parseBillingEnv(sandboxEnv({ POLAR_SERVER: "production", VERCEL_ENV: "preview" }));
    assert.equal(prodOutside.enabled, false);
    if (!prodOutside.enabled) assert.ok(prodOutside.reasons.includes("production_polar_outside_production"));
    const sandboxInProd = parseBillingEnv(sandboxEnv({ VERCEL_ENV: "production" }));
    assert.equal(sandboxInProd.enabled, false);
    if (!sandboxInProd.enabled) assert.ok(sandboxInProd.reasons.includes("sandbox_polar_in_production"));
    assert.equal(POLAR_API_BASE.production, "https://api.polar.sh");
    assert.notEqual(POLAR_API_BASE.sandbox, POLAR_API_BASE.production);
  });

  it("production checkout needs the webhook handler AND explicit operator approval", () => {
    assert.equal(WEBHOOK_HANDLER_READY, true);
    const notApproved = parseBillingEnv(sandboxEnv({ POLAR_SERVER: "production", VERCEL_ENV: "production" }));
    assert.equal(notApproved.enabled, false);
    if (!notApproved.enabled) assert.deepEqual(notApproved.reasons, ["production_not_approved"]);
    const approved = parseBillingEnv(sandboxEnv({ POLAR_SERVER: "production", VERCEL_ENV: "production", BILLING_PRODUCTION_APPROVED: "true" }));
    assert.equal(approved.enabled, true);
    if (approved.enabled) assert.equal(approved.apiBase, "https://api.polar.sh");
  });

  it("an organization id is required", () => {
    const c = parseBillingEnv(sandboxEnv({ POLAR_ORGANIZATION_ID: undefined }));
    assert.equal(c.enabled, false);
    if (!c.enabled) assert.ok(c.reasons.includes("polar_organization_missing"));
  });
});

describe("currency selection", () => {
  it("accepts only PHP and USD", () => {
    assert.equal(parseCurrency("php"), "PHP");
    assert.equal(parseCurrency(" USD "), "USD");
    for (const v of ["EUR", "", null, 99, "PHP; USD"]) assert.equal(parseCurrency(v), null);
  });
  it("defaults to PHP for the Philippines (country or locale), else USD", () => {
    assert.equal(defaultCurrency({ country: "PH" }), "PHP");
    assert.equal(defaultCurrency({ country: null, acceptLanguage: "en-PH,en;q=0.9" }), "PHP");
    assert.equal(defaultCurrency({ acceptLanguage: "fil" }), "PHP");
    assert.equal(defaultCurrency({ country: "US", acceptLanguage: "en-US" }), "USD");
    assert.equal(defaultCurrency({}), "USD");
  });
  it("formats exact minor units", () => {
    assert.equal(formatMoney(9900, "PHP"), "₱99.00");
    assert.equal(formatMoney(29900, "PHP"), "₱299.00");
    assert.equal(formatMoney(199, "USD"), "$1.99");
    assert.equal(formatMoney(349, "USD"), "$3.49");
  });
});

describe("checkout response verification (never redirect to a different charge)", () => {
  const expected = { productId: P.starter, currency: "PHP" as const, amountMinor: 9900 };
  const resp = (over: Record<string, unknown> = {}) => ({
    id: "co_1", url: "https://sandbox.polar.sh/checkout/abc", status: "open", product_id: P.starter,
    currency: "php", amount: 9900, discount_amount: 0, net_amount: 9900, tax_amount: null, total_amount: 9900, tax_behavior: "inclusive", ...over,
  });
  const check = (over: Record<string, unknown>) => verifyCheckout(expected, readCheckoutResponse(resp(over)));

  it("accepts the exact product, currency and amount", () => {
    assert.deepEqual(check({}), { ok: true });
    assert.deepEqual(check({ tax_amount: 1061, total_amount: 9900 }), { ok: true }, "VAT included in the price");
  });
  it("refuses a USD checkout when PHP was shown (Polar picked another currency)", () => {
    assert.deepEqual(check({ currency: "usd", amount: 199, total_amount: 199 }), { ok: false, reason: "currency_mismatch" });
  });
  it("refuses a wrong amount, wrong product, discount, tax on top, or wrong total", () => {
    assert.deepEqual(check({ amount: 9800 }), { ok: false, reason: "amount_mismatch" });
    assert.deepEqual(check({ product_id: P.pro }), { ok: false, reason: "product_mismatch" });
    assert.deepEqual(check({ discount_amount: 100 }), { ok: false, reason: "discount_applied" });
    assert.deepEqual(check({ tax_behavior: "exclusive", tax_amount: null }), { ok: false, reason: "tax_not_inclusive" });
    assert.deepEqual(check({ tax_amount: 1188, total_amount: 11088 }), { ok: false, reason: "total_mismatch" });
    assert.deepEqual(check({ status: "expired" }), { ok: false, reason: "checkout_not_open" });
  });
  it("refuses malformed or non-https responses", () => {
    assert.equal(readCheckoutResponse(null), null);
    assert.equal(readCheckoutResponse({ id: "x", url: "http://evil.example", currency: "php", amount: 9900 }), null);
    assert.equal(readCheckoutResponse({ id: "x", url: "https://ok.example", currency: "php", amount: -1 }), null);
    assert.deepEqual(verifyCheckout(expected, null), { ok: false, reason: "invalid_response" });
  });
});

describe("Polar product audit (read-only)", () => {
  const plan = { code: "starter", prices: { PHP: 9900, USD: 199 } };
  const product = (over: Record<string, unknown> = {}) => ({
    id: P.starter, is_archived: false, is_recurring: false, recurring_interval: null,
    prices: [
      { amount_type: "fixed", price_currency: "usd", price_amount: 199, is_archived: false, tax_behavior: "inclusive" },
      { amount_type: "fixed", price_currency: "php", price_amount: 9900, is_archived: false, tax_behavior: "inclusive" },
    ], ...over,
  });
  it("passes a one-time product with exact PHP and USD prices", () => assert.deepEqual(auditProduct(plan, product()), []));
  it("flags recurring, archived, missing currency, wrong amount, non-fixed and tax-on-top prices", () => {
    assert.match(auditProduct(plan, product({ is_recurring: true, recurring_interval: "week" })).join(), /RECURRING/);
    assert.match(auditProduct(plan, product({ is_archived: true })).join(), /archived/);
    assert.match(auditProduct(plan, product({ prices: [product().prices[0]] })).join(), /no PHP price/);
    assert.match(auditProduct(plan, product({ prices: [product().prices[0], { ...product().prices[1], price_amount: 10000 }] })).join(), /PHP price is 10000, expected 9900/);
    assert.match(auditProduct(plan, product({ prices: [product().prices[0], { ...product().prices[1], amount_type: "custom" }] })).join(), /expected fixed/);
    assert.match(auditProduct(plan, product({ prices: [product().prices[0], { ...product().prices[1], tax_behavior: "exclusive" }] })).join(), /tax on top/);
    assert.match(auditProduct(plan, null).join(), /not found/);
  });
  it("ignores archived historical prices", () => {
    const p = product({ prices: [...product().prices, { amount_type: "fixed", price_currency: "php", price_amount: 8900, is_archived: true }] });
    assert.deepEqual(auditProduct(plan, p), []);
  });
});
