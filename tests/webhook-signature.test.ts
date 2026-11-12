import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { verifyWebhookSignature } from "../lib/billing/webhook-signature.ts";

// Published Standard Webhooks / Svix example vector.
const VEC = { secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", id: "msg_p5jXN8AQM9LWM0D4loKWxJek", timestamp: "1614265330",
  signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=", body: '{"test": 2432232314}', nowSeconds: 1614265330 };

describe("Polar webhook signature (Standard Webhooks)", () => {
  it("accepts the Standard Webhooks spec vector (secret passed as-is)", () => {
    assert.deepEqual(verifyWebhookSignature(VEC), { ok: true });
  });
  it("accepts a legacy 'Polar HMAC' secret (key = UTF-8 bytes of the whole whsec_ string)", () => {
    const secret = "whsec_legacy-polar-secret-before-2026-09-08";
    const sig = createHmac("sha256", Buffer.from(secret, "utf8")).update(`${VEC.id}.${VEC.timestamp}.${VEC.body}`).digest("base64");
    assert.deepEqual(verifyWebhookSignature({ ...VEC, secret, signature: `v1,${sig}` }), { ok: true });
  });
  it("accepts when any of several space-separated signatures matches (secret rotation)", () => {
    assert.deepEqual(verifyWebhookSignature({ ...VEC, signature: `v1,AAAA ${VEC.signature}` }), { ok: true });
  });
  it("rejects a tampered body, another id/timestamp, a wrong secret and a wrong version", () => {
    assert.deepEqual(verifyWebhookSignature({ ...VEC, body: '{"test": 2432232315}' }), { ok: false, reason: "bad_signature" });
    assert.deepEqual(verifyWebhookSignature({ ...VEC, id: "msg_other" }), { ok: false, reason: "bad_signature" });
    assert.deepEqual(verifyWebhookSignature({ ...VEC, secret: "whsec_c29tZXRoaW5nIGVsc2U=" }), { ok: false, reason: "bad_signature" });
    assert.deepEqual(verifyWebhookSignature({ ...VEC, signature: VEC.signature.replace("v1,", "v2,") }), { ok: false, reason: "bad_signature" });
  });
  it("rejects replays outside the 5-minute window and malformed headers", () => {
    assert.deepEqual(verifyWebhookSignature({ ...VEC, nowSeconds: 1614265330 + 301 }), { ok: false, reason: "stale_timestamp" });
    assert.deepEqual(verifyWebhookSignature({ ...VEC, nowSeconds: 1614265330 - 301 }), { ok: false, reason: "stale_timestamp" });
    assert.deepEqual(verifyWebhookSignature({ ...VEC, timestamp: "16142653.30" }), { ok: false, reason: "bad_timestamp" });
    assert.deepEqual(verifyWebhookSignature({ ...VEC, signature: null }), { ok: false, reason: "missing_headers" });
    assert.deepEqual(verifyWebhookSignature({ ...VEC, secret: "" }), { ok: false, reason: "no_secret" });
  });
});
