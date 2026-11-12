import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { confirmFailure, isSameOriginPost, parseEmailOtpType } from "../lib/auth/confirm.ts";

describe("parseEmailOtpType", () => {
  it("accepts email OTP types used by token_hash links", () => {
    for (const t of ["email", "signup", "magiclink", "invite", "recovery", "email_change"]) assert.equal(parseEmailOtpType(t), t);
  });
  it("rejects anything else", () => {
    for (const t of [null, "", "sms", "phone_change", "EMAIL", "email "]) assert.equal(parseEmailOtpType(t), null, String(t));
  });
});

describe("confirmFailure", () => {
  it("maps expired / already-used links", () => assert.equal(confirmFailure({ code: "otp_expired" }), "link_expired"));
  it("maps old PKCE links opened in another browser", () => {
    assert.equal(confirmFailure({ name: "AuthPKCECodeVerifierMissingError" }), "link_other_browser");
    assert.equal(confirmFailure({ code: "pkce_code_verifier_not_found" }), "link_other_browser");
  });
  it("falls back to a generic invalid link", () => {
    assert.equal(confirmFailure(null), "link_invalid");
    assert.equal(confirmFailure({ code: "access_denied" }), "link_invalid");
  });
});

describe("isSameOriginPost (login-CSRF guard)", () => {
  const allowed = ["https://www.bringme.fun"];
  const h = (o: Record<string, string>) => ({ get: (n: string) => o[n] ?? null });
  it("allows same-origin form posts", () => {
    assert.equal(isSameOriginPost(h({ "sec-fetch-site": "same-origin" }), allowed), true);
    assert.equal(isSameOriginPost(h({ origin: "https://www.bringme.fun" }), allowed), true);
  });
  it("refuses posts from other sites", () => {
    assert.equal(isSameOriginPost(h({ "sec-fetch-site": "cross-site", origin: "https://evil.example" }), allowed), false);
    assert.equal(isSameOriginPost(h({ "sec-fetch-site": "same-site" }), allowed), false);
    assert.equal(isSameOriginPost(h({ origin: "https://evil.example" }), allowed), false);
    assert.equal(isSameOriginPost(h({ origin: "null" }), allowed), false);
  });
});
