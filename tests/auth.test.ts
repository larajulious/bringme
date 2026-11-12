import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { safeNext } from "../lib/auth/redirect.ts";
import { friendlyAuthError } from "../lib/auth/messages.ts";

describe("safeNext (open-redirect protection)", () => {
  it("allows same-site paths", () => {
    assert.equal(safeNext("/dashboard/subscription"), "/dashboard/subscription");
    assert.equal(safeNext("/dashboard/subscription?buy=party&currency=PHP"), "/dashboard/subscription?buy=party&currency=PHP");
  });
  it("rejects external, protocol-relative and malformed targets", () => {
    for (const bad of ["https://evil.com", "//evil.com", "/\\evil.com", "evil.com", "javascript:alert(1)", "/a\nb", "", null, undefined]) {
      assert.equal(safeNext(bad), "/dashboard", String(bad));
    }
  });
});

describe("friendlyAuthError", () => {
  it("never leaks raw provider messages", () => {
    assert.equal(friendlyAuthError({ code: "invalid_credentials", message: "Invalid login credentials" }), "Something went wrong. Please try again.");
    assert.equal(friendlyAuthError(new Error("db connection string xyz")), "Something went wrong. Please try again.");
  });
});

describe("friendlyAuthError (email OTP)", () => {
  it("maps OTP, rate-limit, delivery, ban and network failures to safe copy", () => {
    assert.match(friendlyAuthError({ code: "otp_expired", message: "Token has expired or is invalid" }), /incorrect or has expired/);
    assert.match(friendlyAuthError({ code: "over_email_send_rate_limit", message: "only request this after 42 seconds" }), /wait a minute/);
    assert.match(friendlyAuthError({ code: "over_request_rate_limit" }), /wait a minute/);
    assert.match(friendlyAuthError({ code: "unexpected_failure", message: "Error sending magic link email: smtp 535" }), /couldn't send your code/);
    assert.match(friendlyAuthError({ code: "email_address_invalid" }), /valid email/);
    assert.match(friendlyAuthError({ code: "user_banned" }), /deactivated/);
    assert.match(friendlyAuthError({ name: "AuthRetryableFetchError", status: 0 }), /connection/);
    assert.match(friendlyAuthError(new TypeError("Failed to fetch")), /connection/);
  });
  it("never echoes the provider message (could contain SMTP details)", () => {
    const out = friendlyAuthError({ code: "unexpected_failure", message: "smtp password rejected for login@mail.bringme.fun" });
    assert.doesNotMatch(out, /smtp|mail\.bringme|password/i);
  });
});
