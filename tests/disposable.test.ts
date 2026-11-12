import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DISPOSABLE_EMAIL_MESSAGE, MIN_LIST_SIZE, SENTINEL_DOMAINS, checkDomainList, domainCandidates, emailDomain, isDisposableDomain,
  isDomainLike, parseDomainList,
} from "../lib/auth/disposable.ts";
import { friendlyAuthError } from "../lib/auth/messages.ts";

const blocked = new Set(["mailinator.com", "yopmail.fr", "grr.la"]);

describe("disposable email: domain handling", () => {
  it("extracts and normalises the domain (case, spaces, trailing dot, last @)", () => {
    assert.equal(emailDomain(" Host@MailInator.COM "), "mailinator.com");
    assert.equal(emailDomain("a@b@Yopmail.FR."), "yopmail.fr");
    assert.equal(emailDomain("no-at-sign"), null);
    assert.equal(emailDomain("x@"), null);
  });

  it("lists the domain and its parents, never a bare TLD", () => {
    assert.deepEqual(domainCandidates("a.b.mailinator.com"), ["a.b.mailinator.com", "b.mailinator.com", "mailinator.com"]);
    assert.deepEqual(domainCandidates("com"), []);
  });

  it("matches exact domains and subdomains, never substrings", () => {
    assert.equal(isDisposableDomain("mailinator.com", blocked), true);
    assert.equal(isDisposableDomain("MAILINATOR.com", blocked), true);
    assert.equal(isDisposableDomain("inbox.mailinator.com", blocked), true);
    assert.equal(isDisposableDomain("notmailinator.com", blocked), false);
    assert.equal(isDisposableDomain("mailinator.com.evil.ph", blocked), false);
    assert.equal(isDisposableDomain("gmail.com", blocked), false);
  });

  it("an allowlisted domain wins at its level", () => {
    assert.equal(isDisposableDomain("grr.la", blocked, new Set(["grr.la"])), false);
    assert.equal(isDisposableDomain("x.grr.la", blocked, new Set(["grr.la"])), false);
  });

  it("validates domain syntax", () => {
    for (const ok of ["a.co", "10minutemail.com", "xn--80ak6aa92e.com", "mail.example.co.uk"]) assert.ok(isDomainLike(ok), ok);
    for (const bad of ["com", "-a.com", "a-.com", "a..com", "a b.com", "a@b.com", "*.mailinator.com", ""]) assert.ok(!isDomainLike(bad), bad);
  });
});

describe("disposable email: list updates", () => {
  const big = (n: number) => [...SENTINEL_DOMAINS, ...Array.from({ length: n }, (_, i) => `temp${i}.example`)];

  it("parses files with comments, blanks, duplicates and case", () => {
    const { domains, invalid } = parseDomainList("# header\nMailinator.com\n\nmailinator.com\nyopmail.fr # note\nnot a domain\n");
    assert.deepEqual(domains, ["mailinator.com", "yopmail.fr"]);
    assert.deepEqual(invalid, ["not a domain"]);
  });

  it("accepts a healthy list", () => {
    assert.deepEqual(checkDomainList(big(MIN_LIST_SIZE), { currentCount: MIN_LIST_SIZE }), []);
  });

  it("refuses empty, tiny, corrupt or suspicious lists", () => {
    assert.match(checkDomainList([]).join(), /only 0 domains/);
    assert.match(checkDomainList(big(10)).join(), /minimum/);
    assert.match(checkDomainList(big(MIN_LIST_SIZE).slice(1)).join(), /missing expected domains: mailinator\.com/);
    assert.match(checkDomainList([...big(MIN_LIST_SIZE), "gmail.com"], { providers: ["gmail.com"] }).join(), /protected email providers: gmail\.com/);
    assert.match(checkDomainList([...big(MIN_LIST_SIZE), "bad domain"]).join(), /invalid entries/);
  });

  it("refuses a big shrink unless allowed", () => {
    assert.match(checkDomainList(big(MIN_LIST_SIZE), { currentCount: 5000 }).join(), /would shrink/);
    assert.deepEqual(checkDomainList(big(MIN_LIST_SIZE), { currentCount: 5000, allowShrink: true }), []);
  });
});

describe("disposable email: error copy", () => {
  it("maps the Auth hook's rejection to the friendly message", () => {
    assert.equal(friendlyAuthError({ status: 400, message: DISPOSABLE_EMAIL_MESSAGE }), DISPOSABLE_EMAIL_MESSAGE);
    assert.equal(friendlyAuthError({ code: "unexpected_failure", message: `Hook error: ${DISPOSABLE_EMAIL_MESSAGE}` }), DISPOSABLE_EMAIL_MESSAGE);
  });
  it("leaves other errors unchanged", () => {
    assert.equal(friendlyAuthError({ code: "over_email_send_rate_limit" }), "Too many attempts. Please wait a minute and try again.");
  });
});
