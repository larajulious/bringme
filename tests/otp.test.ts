import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  OTP_LENGTH, PENDING_TTL_MS, RESEND_COOLDOWN_MS, cooldownSecondsLeft, isValidEmail, normalizeEmail, parseOtpLength, parsePending, retryAfterMs,
  sanitizeCode,
} from "../lib/auth/otp.ts";

describe("email normalisation + validation", () => {
  it("trims and lowercases so one inbox is one account", () => {
    assert.equal(normalizeEmail("  Host@Example.COM "), "host@example.com");
  });
  it("accepts ordinary addresses", () => {
    for (const ok of ["a@b.co", "first.last+party@mail.bringme.fun", "x_y-z@sub.domain.ph"]) assert.ok(isValidEmail(ok), ok);
  });
  it("rejects empty and malformed input", () => {
    for (const bad of ["", "host", "host@", "@example.com", "host@example", "host@@example.com", "ho st@example.com", "host@example..com", "host@.example.com", `${"a".repeat(250)}@b.co`]) {
      assert.equal(isValidEmail(bad), false, bad);
    }
  });
});

describe("code entry", () => {
  it("defaults to six digits and follows the configured Supabase length (6–10)", () => {
    assert.equal(OTP_LENGTH, parseOtpLength(process.env.NEXT_PUBLIC_AUTH_OTP_LENGTH));
    assert.equal(parseOtpLength(undefined), 6);
    assert.equal(parseOtpLength("8"), 8);
    assert.equal(parseOtpLength("10"), 10);
    for (const bad of ["", "5", "11", "7.5", "eight"]) assert.equal(parseOtpLength(bad), 6, bad);
  });
  it("accepts a full 8-digit code when the project sends 8", () => {
    assert.equal(sanitizeCode("1234 5678", 8), "12345678");
    assert.equal(sanitizeCode("123456789", 8), "12345678");
  });
  it("keeps digits only and caps the length (paste/autofill)", () => {
    assert.equal(sanitizeCode("123 456"), "123456");
    assert.equal(sanitizeCode("123-4567", 6), "123456");
    assert.equal(sanitizeCode("Your code: 987654", 6), "987654");
    assert.equal(sanitizeCode("12a"), "12");
    assert.equal(sanitizeCode(""), "");
  });
});

describe("resend cooldown", () => {
  it("is 60 seconds and counts down in whole seconds", () => {
    assert.equal(RESEND_COOLDOWN_MS, 60_000);
    const sent = 1_000_000;
    assert.equal(cooldownSecondsLeft(sent + RESEND_COOLDOWN_MS, sent), 60);
    assert.equal(cooldownSecondsLeft(sent + RESEND_COOLDOWN_MS, sent + 59_001), 1);
    assert.equal(cooldownSecondsLeft(sent + RESEND_COOLDOWN_MS, sent + 60_000), 0);
    assert.equal(cooldownSecondsLeft(sent + RESEND_COOLDOWN_MS, sent + 999_999), 0);
  });
  it("adopts Supabase's own retry hint when it is rate limited", () => {
    assert.equal(retryAfterMs({ message: "For security purposes, you can only request this after 42 seconds." }), 42_000);
    assert.equal(retryAfterMs({ message: "Email rate limit exceeded" }), null);
    assert.equal(retryAfterMs(null), null);
  });
});

describe("pending verification (refresh recovery)", () => {
  const now = 5_000_000;
  it("restores only a valid email + timestamp", () => {
    assert.deepEqual(parsePending(JSON.stringify({ email: "a@b.co", sentAt: now - 1000 }), now), { email: "a@b.co", sentAt: now - 1000 });
  });
  it("keeps the confirmation-link step, ignores any other kind", () => {
    assert.deepEqual(parsePending(JSON.stringify({ email: "a@b.co", sentAt: now, kind: "link" }), now), { email: "a@b.co", sentAt: now, kind: "link" });
    assert.deepEqual(parsePending(JSON.stringify({ email: "a@b.co", sentAt: now, kind: "admin" }), now), { email: "a@b.co", sentAt: now });
  });
  it("drops anything extra, malformed, stale or from the future", () => {
    assert.deepEqual(parsePending(JSON.stringify({ email: "a@b.co", sentAt: now, code: "123456" }), now), { email: "a@b.co", sentAt: now });
    for (const raw of [null, "", "{", "[]", JSON.stringify({ email: "nope", sentAt: now }), JSON.stringify({ email: "a@b.co" }),
      JSON.stringify({ email: "a@b.co", sentAt: now - PENDING_TTL_MS - 1 }), JSON.stringify({ email: "a@b.co", sentAt: now + 60_000 })]) {
      assert.equal(parsePending(raw, now), null, String(raw));
    }
  });
});
