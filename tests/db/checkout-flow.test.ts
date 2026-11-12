/** Phase 5: idempotent start, abandoned/failed checkouts, return status (migration 20261112000010). */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";

import { as, createDb, createUser, errorOf } from "./harness.ts";

const svc = { role: "service_role" } as const;
const user = (sub: string) => ({ role: "authenticated", sub }) as const;
const PROD = "11111111-1111-4111-8111-111111111111";
let db: PGlite;
let n = 0;
const host = () => createUser(db, `co-${++n}@example.com`);
const start = async (u: string, plan = "starter", currency = "PHP") =>
  (await as(db, svc, () => db.query<{ order_id: string; amount_minor: number; reused: boolean; in_flight: boolean; checkout_url: string | null }>(
    "select * from public.start_checkout_order($1,$2,$3,'sandbox',$4)", [u, plan, currency, PROD]))).rows[0];
const attach = (o: string, co: string, url: string | null, expires: string | null, amount = 9900, currency = "php") =>
  as(db, svc, async () => (await db.query<{ r: string }>("select public.attach_verified_checkout($1,$2,$3,$4,$5,null,$6,$7::timestamptz) r",
    [o, co, PROD, currency, amount, url, expires])).rows[0].r);
const status = async (u: string, co: string) =>
  (await as(db, user(u), () => db.query<{ s: Record<string, unknown> }>("select public.my_checkout_status($1) s", [co]))).rows[0].s;
const soon = () => new Date(Date.now() + 30 * 60_000).toISOString();
const passes = async (u: string) => Number((await db.query<{ n: string }>("select count(*)::text n from public.game_passes where user_id=$1", [u])).rows[0].n);
const orders = async (u: string) => Number((await db.query<{ n: string }>("select count(*)::text n from public.pass_orders where user_id=$1", [u])).rows[0].n);

before(async () => { db = await createDb(); });

describe("idempotent checkout start", () => {
  it("double click while the first request is still creating the Polar session -> in_flight, same order", async () => {
    const u = await host();
    const a = await start(u);
    const b = await start(u);
    assert.equal(a.reused, false);
    assert.deepEqual([b.order_id, b.in_flight, b.reused], [a.order_id, true, false]);
    assert.equal(await orders(u), 1);
  });

  it("after verification, a repeat click gets the SAME checkout URL", async () => {
    const u = await host();
    const a = await start(u);
    assert.equal(await attach(a.order_id, `co_${u}`, "https://sandbox.polar.sh/checkout/a", soon()), "ok");
    const b = await start(u);
    assert.deepEqual([b.order_id, b.reused, b.checkout_url], [a.order_id, true, "https://sandbox.polar.sh/checkout/a"]);
    assert.equal(await orders(u), 1);
  });

  it("a different plan or currency is a new order; an expiring checkout is not reused", async () => {
    const u = await host();
    const a = await start(u);
    await attach(a.order_id, `co_a_${u}`, "https://sandbox.polar.sh/checkout/a", new Date(Date.now() + 60_000).toISOString());
    const b = await start(u);
    assert.notEqual(b.order_id, a.order_id, "expires in < 2 min -> fresh checkout");
    const c = await start(u, "starter", "USD");
    assert.notEqual(c.order_id, b.order_id);
    assert.equal(c.amount_minor, 199);
  });

  it("never reuses for a suspended account, and refuses manipulated attach URLs", async () => {
    const u = await host();
    const a = await start(u);
    await attach(a.order_id, `co_s_${u}`, "https://sandbox.polar.sh/checkout/s", soon());
    await db.query("update public.profiles set hosting_suspended_at = now() where id=$1", [u]);
    assert.match((await errorOf(start(u))) ?? "", /account_suspended/);
    await db.query("update public.profiles set hosting_suspended_at = null where id=$1", [u]);
    const v = await host();
    const o = await start(v);
    assert.equal(await attach(o.order_id, `co_bad_${v}`, "javascript:alert(1)", soon()), "invalid_checkout_url");
    assert.equal((await db.query<{ status: string }>("select status::text from public.pass_orders where id=$1", [o.order_id])).rows[0].status, "canceled");
  });

  it("is server-only", async () => {
    const u = await host();
    assert.match((await errorOf(as(db, user(u), () => db.query("select * from public.start_checkout_order($1,'starter','PHP','sandbox',$2)", [u, PROD])))) ?? "", /permission denied/);
  });
});

describe("abandoned, failed and returned checkouts", () => {
  it("abandoned (24 h) checkouts expire and never block or grant", async () => {
    const u = await host();
    const a = await start(u);
    await attach(a.order_id, `co_ab_${u}`, "https://sandbox.polar.sh/checkout/ab", soon());
    await db.query("alter table public.pass_orders disable trigger guard_pass_order");
    await db.query("update public.pass_orders set created_at = now() - interval '25 hours' where id=$1", [a.order_id]);
    await db.query("alter table public.pass_orders enable trigger guard_pass_order");
    const b = await start(u);
    assert.notEqual(b.order_id, a.order_id);
    assert.equal((await db.query<{ status: string }>("select status::text from public.pass_orders where id=$1", [a.order_id])).rows[0].status, "expired");
    assert.equal((await status(u, `co_ab_${u}`)).status, "expired");
    assert.equal(await passes(u), 0);
  });

  it("failed checkout (Polar reports failed) closes the order; nothing is granted", async () => {
    const u = await host();
    const a = await start(u);
    await attach(a.order_id, `co_f_${u}`, "https://sandbox.polar.sh/checkout/f", soon());
    const r = (await as(db, svc, () => db.query<{ r: string }>("select public.apply_payment_event('polar',$1,'checkout.failed.poll','{}',$2) r",
      [`poll:co_f_${u}:failed`, JSON.stringify({ kind: "order_failed", order_id: a.order_id })]))).rows[0].r;
    assert.equal(r, "applied");
    assert.equal((await status(u, `co_f_${u}`)).status, "failed");
    assert.equal(await passes(u), 0);
    const again = (await as(db, svc, () => db.query<{ r: string }>("select public.apply_payment_event('polar',$1,'checkout.failed.poll','{}',$2) r",
      [`poll:co_f_${u}:failed`, JSON.stringify({ kind: "order_failed", order_id: a.order_id })]))).rows[0].r;
    assert.equal(again, "duplicate", "repeated polling is idempotent");
  });

  it("success redirect WITHOUT a paid webhook: still pending, no pass, no access", async () => {
    const u = await host();
    const a = await start(u);
    await attach(a.order_id, `co_ok_${u}`, "https://sandbox.polar.sh/checkout/ok", soon());
    const s = await status(u, `co_ok_${u}`);
    assert.deepEqual([s.found, s.status, s.passGranted, s.planCode, s.currency, s.amountMinor], [true, "pending", false, "starter", "PHP", 9900]);
    assert.equal(s.resumeUrl, "https://sandbox.polar.sh/checkout/ok", "an unfinished checkout can be resumed");
    assert.equal(await passes(u), 0);
    assert.equal((await db.query<{ state: string }>("select state from public.access_state_for($1)", [u])).rows[0].state, "pending");
  });

  it("the return page can't see someone else's checkout", async () => {
    const owner = await host();
    const a = await start(owner);
    await attach(a.order_id, `co_own_${owner}`, "https://sandbox.polar.sh/checkout/own", soon());
    const stranger = await host();
    assert.deepEqual(await status(stranger, `co_own_${owner}`), { found: false });
    assert.match((await errorOf(as(db, { role: "anon" }, () => db.query("select public.my_checkout_status('x')")))) ?? "", /permission denied/);
  });

  it("only the verified payment event grants the pass (exactly 7 days)", async () => {
    const u = await host();
    const a = await start(u);
    await attach(a.order_id, `co_pay_${u}`, "https://sandbox.polar.sh/checkout/pay", soon());
    await as(db, svc, () => db.query("select public.apply_payment_event('polar',$1,'order.paid','{}',$2)", [`evt_${u}`, JSON.stringify({
      kind: "order_paid", order_id: a.order_id, polar_order_id: `po_${u}`, polar_product_id: PROD, currency: "PHP", amount_minor: 9900, environment: "sandbox" })]));
    const s = await status(u, `co_pay_${u}`);
    assert.deepEqual([s.status, s.passGranted, s.resumeUrl], ["paid", true, null]);
    const secs = (await db.query<{ s: number }>("select extract(epoch from (ends_at - starts_at))::float8 s from public.pass_segments where user_id=$1", [u])).rows[0].s;
    assert.equal(secs, 604_800);
  });
});
