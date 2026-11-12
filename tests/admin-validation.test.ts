import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseListParams, parsePlanInput, parseSettingsInput, parseSubscriptionAction,
} from "../lib/admin/validation.ts";

const plan = { code: "gold", name: "Gold", price_cents: 999, max_players_per_game: 50, max_games_per_period: 5, max_active_games: 2, max_rounds_per_game: 10 };

describe("parsePlanInput", () => {
  it("accepts a full valid plan and trims", () => {
    const r = parsePlanInput({ ...plan, name: "  Gold " }, "create");
    assert.ok(r.ok && r.value.name === "Gold");
  });
  it("allows unlimited games per period (null)", () => {
    assert.ok(parsePlanInput({ ...plan, max_games_per_period: null }, "create").ok);
  });
  it("rejects bad values", () => {
    for (const [patch, err] of [
      [{ code: "Bad Code" }, "invalid_code"], [{ name: "" }, "invalid_name"], [{ price_cents: -1 }, "invalid_price"],
      [{ price_cents: 9.5 }, "invalid_price"], [{ max_players_per_game: 1 }, "invalid_max_players"],
      [{ max_players_per_game: "50" }, "invalid_max_players"], [{ max_games_per_period: 0 }, "invalid_max_games"],
    ] as const) {
      const r = parsePlanInput({ ...plan, ...patch }, "create");
      assert.deepEqual(r, { ok: false, error: err });
    }
  });
  it("create needs every field; update accepts a subset but never the code", () => {
    assert.equal(parsePlanInput({ code: "gold", name: "Gold" }, "create").ok, false);
    assert.ok(parsePlanInput({ is_active: false }, "update").ok);
    assert.deepEqual(parsePlanInput({ code: "x1" }, "update"), { ok: false, error: "code_immutable" });
    assert.deepEqual(parsePlanInput({}, "update"), { ok: false, error: "nothing_to_update" });
  });
  it("ignores unknown fields (no mass assignment)", () => {
    const r = parsePlanInput({ ...plan, id: "x", created_at: "x", role: "super_admin" }, "create");
    assert.ok(r.ok && !("id" in r.value) && !("role" in r.value));
  });
});

describe("parseSettingsInput", () => {
  const ok = { default_max_players: 20, max_photo_size_mb: 5, photo_retention_days: 30, support_email: "help@bringme.app" };
  it("accepts valid and empty email", () => {
    assert.ok(parseSettingsInput(ok).ok);
    const r = parseSettingsInput({ ...ok, support_email: "" });
    assert.ok(r.ok && r.value.support_email === null);
  });
  it("rejects out-of-range and malformed", () => {
    assert.equal(parseSettingsInput({ ...ok, max_photo_size_mb: 0 }).ok, false);
    assert.equal(parseSettingsInput({ ...ok, max_photo_size_mb: 999 }).ok, false);
    assert.equal(parseSettingsInput({ ...ok, default_max_players: 1 }).ok, false);
    assert.equal(parseSettingsInput({ ...ok, photo_retention_days: 0 }).ok, false);
    assert.equal(parseSettingsInput({ ...ok, support_email: "nope" }).ok, false);
    assert.equal(parseSettingsInput({ ...ok, support_email: 42 }).ok, false);
  });
});

describe("parseSubscriptionAction", () => {
  it("validates each action", () => {
    assert.ok(parseSubscriptionAction({ action: "activate", planCode: "party", days: 30 }).ok);
    assert.ok(parseSubscriptionAction({ action: "set_plan", planCode: "pro" }).ok);
    assert.ok(parseSubscriptionAction({ action: "suspend" }).ok);
    const e = parseSubscriptionAction({ action: "set_expiry", expires: "2030-01-01" });
    assert.ok(e.ok && e.value.action === "set_expiry");
  });
  it("rejects invalid input", () => {
    assert.equal(parseSubscriptionAction({ action: "activate", planCode: "party", days: 0 }).ok, false);
    assert.equal(parseSubscriptionAction({ action: "activate", planCode: "P!", days: 5 }).ok, false);
    assert.equal(parseSubscriptionAction({ action: "set_expiry", expires: "garbage" }).ok, false);
    assert.equal(parseSubscriptionAction({ action: "delete-everything" }).ok, false);
  });
});

describe("parseListParams", () => {
  it("sanitises query parameters", () => {
    assert.deepEqual(parseListParams({ q: " bob ", state: "pending", page: "3" }), { q: "bob", state: "pending", page: 3 });
    assert.deepEqual(parseListParams({ state: "hacker", page: "-4" }), { q: "", state: null, page: 1 });
    assert.equal(parseListParams({ page: "NaN" }).page, 1);
    assert.equal(parseListParams({ q: "x".repeat(500) }).q.length, 100);
  });
});
