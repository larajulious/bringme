import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { formatRemaining } from "../lib/game-pass/format.ts";

describe("trial / pass remaining time", () => {
  it("formats days, hours and minutes", () => {
    assert.equal(formatRemaining(604_800), "7 days left");
    assert.equal(formatRemaining(6 * 86_400 + 4 * 3_600 + 59), "6 days 4 hours left");
    assert.equal(formatRemaining(86_400 + 3_600), "1 day 1 hour left");
    assert.equal(formatRemaining(3 * 3_600 + 12 * 60), "3 hours 12 minutes left");
    assert.equal(formatRemaining(8 * 60 + 30), "8 minutes left");
    assert.equal(formatRemaining(59), "Less than a minute left");
  });
  it("never shows negative time", () => {
    for (const s of [0, -5, Number.NaN]) assert.equal(formatRemaining(s), "Ended");
  });
});

import { parseMoneyInput, passAction, refundLabel } from "../lib/game-pass/ui.ts";
import { priceSyncFromProduct } from "../lib/billing/price-sync.ts";
import { parsePriceInput, parseSubscriptionAction } from "../lib/admin/validation.ts";

describe("Game Pass action buttons (policy wording)", () => {
  const none = { active: false, isTrial: false, maxPlayers: null };
  it("no pass / expired -> Buy Game Pass", () => assert.equal(passAction(none, 10).label, "Buy Game Pass"));
  it("during the free trial -> Buy Game Pass, which ends the trial", () => {
    const a = passAction({ active: true, isTrial: true, maxPlayers: 3 }, 10);
    assert.deepEqual([a.label, /ends your free trial/.test(a.note)], ["Buy Game Pass", true]);
  });
  it("higher tier -> Upgrade Pass; same tier -> Purchase Again; lower tier -> queued after", () => {
    const party = { active: true, isTrial: false, maxPlayers: 50 };
    assert.equal(passAction(party, 100).label, "Upgrade Pass");
    assert.equal(passAction(party, 50).label, "Purchase Again");
    const lower = passAction(party, 10);
    assert.deepEqual([lower.label, /after your current pass/.test(lower.note)], ["Buy Game Pass", true]);
  });
});

describe("admin price input (exact minor units, no floats)", () => {
  it("parses decimal strings", () => {
    assert.equal(parseMoneyInput("99"), 9900);
    assert.equal(parseMoneyInput("1.99"), 199);
    assert.equal(parseMoneyInput("3.5"), 350);
    assert.equal(parseMoneyInput(" 299.00 "), 29900);
  });
  it("rejects more than two decimals, negatives, separators and junk", () => {
    for (const v of ["1.999", "-1", "1,99", "abc", "", "1e3", "99999999"]) assert.equal(parseMoneyInput(v), null, v);
  });
  it("API body: only PHP/USD and integer minor units", () => {
    assert.deepEqual(parsePriceInput({ currency: "PHP", amountMinor: 9900 }), { ok: true, value: { currency: "PHP", amountMinor: 9900 } });
    assert.deepEqual(parsePriceInput({ currency: "EUR", amountMinor: 100 }), { ok: false, error: "invalid_currency" });
    assert.deepEqual(parsePriceInput({ currency: "USD", amountMinor: 1.99 }), { ok: false, error: "invalid_price" });
    assert.deepEqual(parsePriceInput({ currency: "USD", amountMinor: -1 }), { ok: false, error: "invalid_price" });
  });
});

describe("admin entitlement actions", () => {
  const pass = "11111111-1111-4111-8111-111111111111";
  it("extend needs 1–366 days and a reason; revoke needs a pass id and a reason", () => {
    assert.deepEqual(parseSubscriptionAction({ action: "extend", days: 7, reason: "outage" }), { ok: true, value: { action: "extend", days: 7, reason: "outage" } });
    assert.deepEqual(parseSubscriptionAction({ action: "extend", days: 0, reason: "outage" }), { ok: false, error: "invalid_days" });
    assert.deepEqual(parseSubscriptionAction({ action: "extend", days: 7, reason: " " }), { ok: false, error: "reason_required" });
    assert.deepEqual(parseSubscriptionAction({ action: "revoke", passId: pass, reason: "chargeback" }), { ok: true, value: { action: "revoke", passId: pass, reason: "chargeback" } });
    assert.deepEqual(parseSubscriptionAction({ action: "revoke", passId: "x", reason: "chargeback" }), { ok: false, error: "invalid_pass" });
    assert.deepEqual(parseSubscriptionAction({ action: "unsuspend" }), { ok: true, value: { action: "unsuspend" } });
  });
});

describe("refund labels", () => {
  it("full / partial / none", () => {
    assert.equal(refundLabel("refunded", 9900), "Fully refunded");
    assert.equal(refundLabel("partially_refunded", 2000), "Partially refunded");
    assert.equal(refundLabel("paid", 0), null);
  });
});

describe("Polar price sync (blocks mispriced checkout)", () => {
  const product = (prices: Record<string, unknown>[], over: Record<string, unknown> = {}) => ({ is_recurring: false, recurring_interval: null, is_archived: false, prices, ...over });
  const fixed = (c: string, a: number, extra: Record<string, unknown> = {}) => ({ amount_type: "fixed", price_currency: c, price_amount: a, is_archived: false, ...extra });
  it("ok only when Polar charges exactly the local amount", () => {
    assert.deepEqual(priceSyncFromProduct(product([fixed("usd", 199), fixed("php", 9900)]), { PHP: 9900, USD: 199 }), { PHP: "ok", USD: "ok" });
  });
  it("a local price edit not mirrored in Polar -> mismatch; missing currency; recurring; not found", () => {
    assert.deepEqual(priceSyncFromProduct(product([fixed("usd", 199), fixed("php", 9900)]), { PHP: 10900, USD: 199 }), { PHP: "mismatch", USD: "ok" });
    assert.deepEqual(priceSyncFromProduct(product([fixed("usd", 199)]), { PHP: 9900 }), { PHP: "missing_in_polar" });
    assert.deepEqual(priceSyncFromProduct(product([fixed("php", 9900)], { is_recurring: true, recurring_interval: "week" }), { PHP: 9900 }), { PHP: "not_one_time" });
    assert.deepEqual(priceSyncFromProduct(null, { PHP: 9900 }), { PHP: "product_not_found" });
    assert.deepEqual(priceSyncFromProduct(product([fixed("php", 9900, { tax_behavior: "exclusive" })]), { PHP: 9900 }), { PHP: "mismatch" }, "tax on top");
  });
});
