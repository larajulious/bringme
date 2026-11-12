import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parsePlanSyncInput } from "../lib/admin/validation.ts";
import { parseCatalogEnv } from "../lib/billing/config.ts";
import { buildPatch, readPolarProduct, verifyProduct } from "../lib/billing/product-sync.ts";
import { describeSync } from "../lib/billing/sync-messages.ts";

const ORG = "44444444-4444-4444-8444-444444444444";
const product = (over: Record<string, unknown> = {}) => readPolarProduct({
  id: "11111111-1111-4111-8111-111111111111", name: "Starter", is_recurring: false, recurring_interval: null, is_archived: false,
  organization_id: ORG, modified_at: null, metadata: { bringme_plan: "starter" },
  prices: [
    { id: "u1", amount_type: "fixed", price_currency: "usd", price_amount: 199, is_archived: false, tax_behavior: "inclusive" },
    { id: "p1", amount_type: "fixed", price_currency: "php", price_amount: 9900, is_archived: false, tax_behavior: "inclusive" },
    { id: "e1", amount_type: "fixed", price_currency: "eur", price_amount: 189, is_archived: false, tax_behavior: "inclusive" },
  ], ...over })!;
const base = { name: "Starter", maxPlayers: 10, phpMinor: 9900, usdMinor: 199 };

describe("minimal Polar patch", () => {
  it("nothing to send when Polar already matches (retries never add prices)", () => assert.equal(buildPatch(product(), base, "starter"), null));
  it("name only", () => assert.deepEqual(buildPatch(product(), { ...base, name: "Starter Night" }, "starter"), { name: "Starter Night" }));
  it("USD change keeps PHP and an unrelated EUR price by id, adds one new USD price", () => {
    assert.deepEqual(buildPatch(product(), { ...base, usdMinor: 2000 }, "starter"), { prices: [{ id: "p1" }, { id: "e1" },
      { amount_type: "fixed", price_currency: "usd", price_amount: 2000, tax_behavior: "inclusive" }] });
  });
  it("tags the product with its plan code when missing", () => {
    assert.deepEqual(buildPatch(product({ metadata: {} }), base, "starter"), { metadata: { bringme_plan: "starter" } });
  });
});

describe("verification of Polar's actual state", () => {
  it("passes only an exact match", () => {
    assert.equal(verifyProduct(product(), base, ORG), null);
    assert.equal(verifyProduct(product(), { ...base, usdMinor: 2000 }, ORG), "usd_amount_199");
    assert.equal(verifyProduct(product(), { ...base, name: "X" }, ORG), "name_not_updated");
    assert.equal(verifyProduct(product(), base, "55555555-5555-4555-8555-555555555555"), "organization_mismatch");
    assert.equal(verifyProduct(product({ is_recurring: true }), base, ORG), "product_is_recurring");
  });
});

describe("input and configuration", () => {
  it("validates name (Polar 3–64), players, exact prices; duration is fixed", () => {
    assert.equal(parsePlanSyncInput({ name: "St", maxPlayers: 10, phpMinor: 9900, usdMinor: 199 }).ok, false);
    assert.equal(parsePlanSyncInput({ name: "Starter", maxPlayers: 1, phpMinor: 9900, usdMinor: 199 }).ok, false);
    assert.equal(parsePlanSyncInput({ name: "Starter", maxPlayers: 10, phpMinor: 0, usdMinor: 199 }).ok, false);
    assert.equal(parsePlanSyncInput({ name: "Starter", maxPlayers: 10, phpMinor: 9900, usdMinor: 19.9 }).ok, false);
    assert.deepEqual(parsePlanSyncInput({ name: "Starter", maxPlayers: 10, phpMinor: 9900, usdMinor: 199, durationSeconds: 1 }), { ok: false, error: "duration_fixed" });
    assert.deepEqual(parsePlanSyncInput({ name: " Starter ", maxPlayers: 10, phpMinor: 9900, usdMinor: 2000 }), { ok: true, value: { name: "Starter", maxPlayers: 10, phpMinor: 9900, usdMinor: 2000 } });
  });
  it("catalog config: sandbox vs production separated; token and org required", () => {
    const c = parseCatalogEnv({ NODE_ENV: "development", POLAR_SERVER: "sandbox", POLAR_ACCESS_TOKEN: "t", POLAR_ORGANIZATION_ID: ORG, POLAR_PRODUCT_ID_STARTER: "11111111-1111-4111-8111-111111111111" });
    assert.equal(c.enabled && c.apiBase, "https://sandbox-api.polar.sh");
    assert.equal(parseCatalogEnv({ NODE_ENV: "development", POLAR_SERVER: "production", POLAR_ACCESS_TOKEN: "t", POLAR_ORGANIZATION_ID: ORG }).enabled, false);
    assert.equal(parseCatalogEnv({ NODE_ENV: "development", POLAR_SERVER: "sandbox", POLAR_ORGANIZATION_ID: ORG }).enabled, false, "no token (the current .env.local)");
  });
});

describe("admin wording never claims success when one system is behind", () => {
  it("synced / local-only are success; failed / polar_ahead / errors are not", () => {
    assert.equal(describeSync({ status: "synced", environment: "sandbox", patched: true }).ok, true);
    assert.match(describeSync({ status: "local_only" }).text, /BringMe! only/);
    for (const r of [{ status: "failed", stage: "polar_update", error: "polar_502" }, { status: "polar_ahead", error: "x" }, { error: "network" }] as const) {
      const d = describeSync(r);
      assert.equal(d.ok, false);
      assert.doesNotMatch(d.text, /saved successfully|synchronized with Polar \(/i);
    }
  });
});
