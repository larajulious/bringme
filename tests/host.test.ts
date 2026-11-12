import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseGameInput } from "../lib/host/validation.ts";
import { joinUrl, resolveSiteUrl } from "../lib/site/url.ts";
import { qrMatrix, qrPath, QUIET_ZONE } from "../lib/site/qr.ts";

describe("parseGameInput", () => {
  it("accepts an optional title and trims/normalises items", () => {
    const r = parseGameInput({ items: ["  a   red\nshoe ", "banana"] }, 10);
    assert.deepEqual(r, { ok: true, value: { title: "", items: ["a red shoe", "banana"] } });
    assert.ok(parseGameInput({ title: " Friday ", items: ["x"] }, 10).ok);
  });
  it("requires every round to have an item", () => {
    assert.deepEqual(parseGameInput({ items: ["a", "  "] }, 10), { ok: false, error: "empty_item" });
    assert.deepEqual(parseGameInput({ items: [] }, 10), { ok: false, error: "items_required" });
    assert.deepEqual(parseGameInput({}, 10), { ok: false, error: "items_required" });
  });
  it("enforces the plan's round limit and shape", () => {
    assert.deepEqual(parseGameInput({ items: ["a", "b", "c"] }, 2), { ok: false, error: "too_many_items" });
    assert.deepEqual(parseGameInput({ items: [1] }, 5), { ok: false, error: "invalid_item" });
    assert.deepEqual(parseGameInput({ items: ["x".repeat(201)] }, 5), { ok: false, error: "invalid_item" });
    assert.deepEqual(parseGameInput({ title: "t".repeat(81), items: ["a"] }, 5), { ok: false, error: "invalid_title" });
    assert.deepEqual(parseGameInput({ title: 5, items: ["a"] }, 5), { ok: false, error: "invalid_title" });
  });
});

describe("site url + join url", () => {
  it("prefers the configured public URL and normalises it", () => {
    assert.deepEqual(resolveSiteUrl({ NEXT_PUBLIC_SITE_URL: "https://bringme.app/some/path/" }), { url: "https://bringme.app", configured: true });
  });
  it("rejects non-http(s) values and falls back", () => {
    assert.equal(resolveSiteUrl({ NEXT_PUBLIC_SITE_URL: "javascript:alert(1)" }).configured, false);
    assert.equal(resolveSiteUrl({}).url, "http://localhost:3000");
    assert.equal(resolveSiteUrl({ VERCEL_URL: "x.vercel.app" }).url, "https://x.vercel.app");
  });
  it("builds join links only for valid codes", () => {
    assert.equal(joinUrl("https://bringme.app", "AB12CD"), "https://bringme.app/join/AB12CD");
    assert.throws(() => joinUrl("https://bringme.app", "../admin"));
    assert.throws(() => joinUrl("https://bringme.app", "ab12cd"));
  });
});

describe("QR matrix", () => {
  it("is square, has finder patterns and a quiet-zone viewBox", () => {
    const m = qrMatrix("https://bringme.app/play/AB12CD");
    assert.ok(m.length >= 21 && m.every((r) => r.length === m.length));
    // top-left finder pattern: 7x7 ring with a solid 3x3 centre
    for (let i = 0; i < 7; i++) assert.ok(m[0][i] && m[6][i] && m[i][0] && m[i][6]);
    assert.ok(m[3][3] && m[2][2] && m[4][4]);
    const { d, size } = qrPath(m);
    assert.equal(size, m.length + QUIET_ZONE * 2);
    assert.ok(d.startsWith(`M${QUIET_ZONE} ${QUIET_ZONE}`));
  });
  it("is deterministic per URL and differs between URLs", () => {
    const a = JSON.stringify(qrMatrix("https://bringme.app/play/AAAAAA"));
    assert.equal(a, JSON.stringify(qrMatrix("https://bringme.app/play/AAAAAA")));
    assert.notEqual(a, JSON.stringify(qrMatrix("https://bringme.app/play/BBBBBB")));
  });
});

import { parsePlayerName } from "../lib/players/validation.ts";

describe("parsePlayerName", () => {
  it("accepts ordinary, unicode and emoji names and tidies whitespace", () => {
    assert.deepEqual(parsePlayerName("  Ava   Rose "), { ok: true, value: "Ava Rose" });
    assert.deepEqual(parsePlayerName("José 🎉"), { ok: true, value: "José 🎉" });
    assert.deepEqual(parsePlayerName("小明"), { ok: true, value: "小明" });
  });
  it("strips invisible and control characters (no spoofing via zero-width/bidi)", () => {
    assert.deepEqual(parsePlayerName("A​v‮a"), { ok: true, value: "Ava" });
    assert.deepEqual(parsePlayerName("Ava\n\t\u0000"), { ok: true, value: "Ava" });
    assert.equal(parsePlayerName("​​").ok, false);
  });
  it("rejects empty, too long, non-string and symbol-only names", () => {
    for (const bad of ["", "   ", "x".repeat(25), 5, null, undefined, "!!!???", "----"]) {
      assert.deepEqual(parsePlayerName(bad), { ok: false, error: "invalid_nickname" }, String(bad));
    }
    assert.ok(parsePlayerName("x".repeat(24)).ok);
  });
  it("counts code points, not UTF-16 units", () => {
    assert.ok(parsePlayerName("🎉".repeat(24)).ok);
    assert.equal(parsePlayerName("🎉".repeat(25)).ok, false);
  });
});
