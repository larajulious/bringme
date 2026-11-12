/** Disposable email protection (migrations 20261112000029 + 000030): real SQL on PGlite. */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";

import { DISPOSABLE_EMAIL_MESSAGE } from "../../lib/auth/disposable.ts";
import { as, createDb, createUser, errorOf } from "./harness.ts";

const svc = { role: "service_role" } as const;
let db: PGlite;

/** What Supabase Auth sends to the hook (only the parts we read). */
const event = (email: string | null) => JSON.stringify({ metadata: { uuid: "x", time: "now", name: "before-user-created" }, user: { email } });

async function hook(email: string | null): Promise<Record<string, unknown>> {
  await db.exec("reset role");
  await db.exec("set role supabase_auth_admin");
  try {
    return (await db.query<{ r: Record<string, unknown> }>("select public.hook_before_user_created($1::jsonb) r", [event(email)])).rows[0].r;
  } finally {
    await db.exec("reset role");
  }
}
const blocks = async (email: string) => "error" in (await hook(email));
const status = () => as(db, svc, async () => (await db.query<{ s: { active: { version: number; domains: number }; live_domains: number; versions: { version: number }[] } }>("select public.disposable_email_list_status() s")).rows[0].s);
const activeList = async () => (await db.query<{ d: string[] }>("select domains d from public.disposable_email_list_versions where is_active")).rows[0].d;
const apply = (domains: string[], opts: { shrink?: boolean; min?: number } = {}) =>
  as(db, svc, () => db.query("select public.apply_disposable_email_list($1::text[], 'test', 'ref', $2, $3) r", [domains, opts.min ?? 1000, opts.shrink ?? false]));

before(async () => { db = await createDb(); });

describe("disposable email: initial data", () => {
  it("ships the upstream list as version 1, plus the allowlist", async () => {
    const s = await status();
    assert.equal(s.active.version, 1);
    assert.ok(s.live_domains > 10_000, String(s.live_domains));
    assert.equal(s.active.domains, s.live_domains);
  });

  it("blocks every verified candidate domain; tempmail.com (not on the upstream list) is not blocked", async () => {
    const verified = ["10minutemail.com", "10minutemail.net", "guerrillamail.com", "guerrillamail.net", "guerrillamail.org", "sharklasers.com",
      "grr.la", "temp-mail.org", "mailinator.com", "yopmail.com", "yopmail.fr", "yopmail.net", "maildrop.cc", "trashmail.com", "trashmail.net",
      "mohmal.com", "fakemailgenerator.com", "throwawaymail.com", "getnada.com", "emailondeck.com", "dispostable.com", "tempail.com",
      "mailnesia.com", "mintemail.com", "mytempmail.com"];
    for (const d of verified) assert.ok(await blocks(`someone@${d}`), d);
    assert.equal(await blocks("someone@tempmail.com"), false);
  });
});

describe("disposable email: Before User Created hook", () => {
  it("rejects temporary inboxes with the user-facing message (case, spaces, subdomains)", async () => {
    const r = await hook("Player@MAILINATOR.com");
    assert.deepEqual(r, { error: { http_code: 400, message: DISPOSABLE_EMAIL_MESSAGE } });
    for (const e of ["x@YopMail.FR", " x@inbox.mailinator.com ", "x@a.b.guerrillamail.com", "x@mailinator.com."]) assert.ok(await blocks(e), e);
  });

  it("allows mainstream, privacy and business addresses", async () => {
    for (const e of ["host@gmail.com", "Host@Outlook.com", "a@hotmail.com", "a@yahoo.com", "a@icloud.com", "a@proton.me", "a@protonmail.com",
      "a@pm.me", "a@tuta.io", "a@duck.com", "abc@privaterelay.appleid.com", "x@mozmail.com", "x@simplelogin.com", "x@alias.anonaddy.me",
      "ceo@bringme.fun", "team@acme.com.ph", "a@school.edu"]) {
      assert.deepEqual(await hook(e), {}, e);
    }
  });

  it("never substring-matches", async () => {
    for (const e of ["a@bringmailinator.com", "a@mailinatorfan.ph", "a@mailinator.com.ph", "a@mymailinator.co"]) assert.equal(await blocks(e), false, e);
  });

  it("lets non-email signups through (no email in the event)", async () => {
    assert.deepEqual(await hook(null), {});
    assert.deepEqual((await db.query<{ r: object }>("select public.hook_before_user_created('{}'::jsonb) r")).rows[0].r, {});
  });

  it("allowlist overrides a verified false positive", async () => {
    assert.ok(await blocks("x@grr.la"));
    await db.query("insert into public.disposable_email_allowlist (domain, kind, reason) values ('grr.la', 'false_positive', 'test')");
    assert.equal(await blocks("x@grr.la"), false);
    assert.equal(await blocks("x@sub.grr.la"), false);
    await db.query("delete from public.disposable_email_allowlist where domain = 'grr.la'");
    assert.ok(await blocks("x@grr.la"));
  });
});

describe("disposable email: permissions", () => {
  it("browsers can't read the lists or call any function", async () => {
    for (const actor of [{ role: "anon" } as const, { role: "authenticated", sub: "00000000-0000-4000-8000-000000000001" } as const]) {
      for (const sql of [
        "select count(*) from public.disposable_email_domains",
        "select count(*) from public.disposable_email_allowlist",
        "select count(*) from public.disposable_email_list_versions",
        "select public.is_disposable_email('a@mailinator.com')",
        "select public.hook_before_user_created('{}'::jsonb)",
        "select public.disposable_email_list_status()",
        "select public.rollback_disposable_email_list(null)",
        "select public.apply_disposable_email_list(array['a.com'], 'x')",
      ]) {
        assert.match((await as(db, actor, () => errorOf(db.query(sql)))) ?? "", /permission denied/, `${actor.role}: ${sql}`);
      }
    }
  });

  it("Supabase Auth may only run the hook (no table access)", async () => {
    await db.exec("set role supabase_auth_admin");
    try {
      assert.match((await errorOf(db.query("select count(*) from public.disposable_email_domains"))) ?? "", /permission denied/);
      assert.match((await errorOf(db.query("select public.apply_disposable_email_list(array['a.com'], 'x')"))) ?? "", /permission denied/);
    } finally {
      await db.exec("reset role");
    }
  });

  it("the server pre-check (service role) answers per domain", async () => {
    const check = (e: string) => as(db, svc, async () => (await db.query<{ r: boolean }>("select public.is_disposable_email($1) r", [e])).rows[0].r);
    assert.equal(await check("A@Mailinator.Com"), true);
    assert.equal(await check("a@gmail.com"), false);
    assert.equal(await check("not-an-email"), false);
  });
});

describe("disposable email: updates and rollback", () => {
  it("refuses bad lists and keeps the active one", async () => {
    const before = await status();
    const list = await activeList();
    const cases: [string[], RegExp, { shrink?: boolean; min?: number }?][] = [
      [[], /list_too_small/],
      [["mailinator.com"], /list_too_small/],
      [[...list, "not a domain"], /invalid_domains/],
      [[...list, "com"], /invalid_domains/],
      [list.filter((d) => d !== "mailinator.com"), /missing_sentinel: mailinator\.com/],
      [[...list, "gmail.com"], /contains_provider: gmail\.com/],
      [list.slice(0, Math.floor(list.length / 2)).concat(["mailinator.com", "guerrillamail.com", "yopmail.com", "10minutemail.com"]), /list_shrank/],
    ];
    for (const [domains, re, opts] of cases) assert.match((await errorOf(apply(domains, opts))) ?? "", re);
    const after = await status();
    assert.equal(after.active.version, before.active.version);
    assert.equal(after.live_domains, before.live_domains);
  });

  it("applies a valid update atomically, tracks versions, and rolls back", async () => {
    const existing = await createUser(db, "old-host@mailinator.com"); // an account from before the rule
    const v1 = await status();
    const list = await activeList();
    await apply([...list, "brand-new-temp.example"]);
    const v2 = await status();
    assert.equal(v2.active.version, v1.active.version + 1);
    assert.equal(v2.live_domains, v1.live_domains + 1);
    assert.ok(await blocks("x@brand-new-temp.example"));

    const rb = await as(db, svc, async () => (await db.query<{ r: { version: number } }>("select public.rollback_disposable_email_list(null) r")).rows[0].r);
    assert.equal(rb.version, v1.active.version);
    assert.equal((await status()).live_domains, v1.live_domains);
    assert.equal(await blocks("x@brand-new-temp.example"), false);

    // Existing accounts are never touched by list changes (signing in never runs the hook).
    const n = (await db.query<{ n: number }>("select count(*)::int n from auth.users where id = $1", [existing])).rows[0].n;
    assert.equal(n, 1);
    assert.match((await errorOf(as(db, svc, () => db.query("select public.rollback_disposable_email_list(999999)")))) ?? "", /version_not_found/);
  });

  it("a deliberate shrink needs the explicit flag", async () => {
    const list = await activeList();
    const smaller = [...new Set([...list.slice(0, 2000), "mailinator.com", "guerrillamail.com", "yopmail.com", "10minutemail.com"])];
    assert.match((await errorOf(apply(smaller))) ?? "", /list_shrank/);
    await apply(smaller, { shrink: true });
    assert.equal((await status()).live_domains, smaller.length);
    await as(db, svc, () => db.query("select public.rollback_disposable_email_list(null)"));
  });

  it("keeps at most five versions", async () => {
    const list = await activeList();
    for (let i = 0; i < 6; i++) await apply([...list, `extra${i}.example`]);
    assert.ok((await status()).versions.length <= 5);
  });
});
