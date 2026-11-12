/**
 * Admin plan edit -> Polar sync (lib/billing/product-sync.ts + migration 20261112000014).
 * Real SQL on PGlite; Polar is a fake implementing the documented PATCH /v1/products/{id}
 * semantics (keep prices listed as {id}, create the others). Whether Polar archives OMITTED
 * prices isn't documented, so both behaviours are tested.
 */
import { before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";

import { parseWebhookEnv } from "../../lib/billing/config.ts";
import { priceSyncFromProduct } from "../../lib/billing/price-sync.ts";
import { summarize, readPolarProduct, syncPlan, type SyncDeps } from "../../lib/billing/product-sync.ts";
import { readCheckoutResponse, verifyCheckout } from "../../lib/billing/verify.ts";
import { processEvent } from "../../lib/billing/webhook.ts";
import { as, createDb, createUser, errorOf } from "./harness.ts";

const svc = { role: "service_role" } as const;
const ORG = "44444444-4444-4444-8444-444444444444";
const PRODUCT = "11111111-1111-4111-8111-111111111111";
let db: PGlite;
let admin: string;
let starterId: string;

// ----------------------------------------------------------------- fake Polar ----
type FakePrice = { id: string; amount_type: string; price_currency: string; price_amount: number; is_archived: boolean; tax_behavior: string | null };
const polar = {
  product: null as null | Record<string, unknown> & { prices: FakePrice[] },
  archiveOmitted: true, patches: [] as Record<string, unknown>[], created: 0, failPatch: 0, clock: Date.parse("2026-11-11T15:00:00Z"),
  reset() {
    this.product = { id: PRODUCT, name: "Starter", is_recurring: false, recurring_interval: null, is_archived: false, organization_id: ORG,
      modified_at: new Date(this.clock).toISOString(), metadata: {}, prices: [
        { id: "price_usd_199", amount_type: "fixed", price_currency: "usd", price_amount: 199, is_archived: false, tax_behavior: "inclusive" },
        { id: "price_php_9900", amount_type: "fixed", price_currency: "php", price_amount: 9900, is_archived: false, tax_behavior: "inclusive" }] };
    this.archiveOmitted = true; this.patches = []; this.created = 0; this.failPatch = 0;
  },
  get: async () => structuredClone(polar.product),
  patch: async (_id: string, body: Record<string, unknown>) => {
    polar.patches.push(body);
    if (polar.failPatch > 0) { polar.failPatch--; throw new Error("polar_502"); }
    const p = polar.product!;
    if (typeof body.name === "string") p.name = body.name;
    if (body.metadata) p.metadata = body.metadata as Record<string, unknown>;
    if (Array.isArray(body.prices)) {
      const keep = new Set((body.prices as Record<string, unknown>[]).filter((x) => "id" in x).map((x) => x.id as string));
      if (polar.archiveOmitted) for (const pr of p.prices) if (!keep.has(pr.id)) pr.is_archived = true;
      for (const c of (body.prices as Record<string, unknown>[]).filter((x) => !("id" in x))) {
        polar.created++;
        p.prices.push({ id: `price_new_${polar.created}`, amount_type: String(c.amount_type), price_currency: String(c.price_currency),
          price_amount: Number(c.price_amount), is_archived: false, tax_behavior: (c.tax_behavior as string) ?? null });
      }
    }
    polar.clock += 1000;
    p.modified_at = new Date(polar.clock).toISOString();
    return structuredClone(p);
  },
};

// ------------------------------------------------------------- real DB wiring ----
let failFinishOnce = false;
function deps(begin: () => Promise<string>, polarCfg: SyncDeps["polar"] = { environment: "sandbox", organizationId: ORG, productId: PRODUCT }): SyncDeps {
  return {
    polar: polarCfg, begin, fetchProduct: polar.get, patchProduct: polar.patch,
    async finish(jobId, s) {
      if (failFinishOnce) { failFinishOnce = false; throw new Error("supabase_unavailable"); }
      await as(db, svc, () => db.query("select public.admin_finish_plan_sync($1,$2,$3)", [admin, jobId, JSON.stringify(s)]));
    },
    async fail(jobId, stage, error, s) {
      await as(db, svc, () => db.query("select public.admin_fail_plan_sync($1,$2,$3,$4,$5)", [admin, jobId, stage, error, s ? JSON.stringify(s) : null]));
    },
  };
}
const beginFor = (req: { name: string; maxPlayers: number; phpMinor: number; usdMinor: number }, env: string | null = "sandbox") => async () =>
  (await as(db, svc, () => db.query<{ id: string }>("select public.admin_begin_plan_sync($1,$2,$3,$4,$5) id",
    [admin, starterId, env, env ? PRODUCT : null, JSON.stringify({ name: req.name, max_players: req.maxPlayers, php_minor: req.phpMinor, usd_minor: req.usdMinor })]))).rows[0].id;
const edit = (req: { name: string; maxPlayers: number; phpMinor: number; usdMinor: number }) => syncPlan(deps(beginFor(req)), "starter", req);
const local = async () => {
  const plan = (await db.query<{ name: string; max_players_per_game: number }>("select name, max_players_per_game from public.subscription_plans where id=$1", [starterId])).rows[0];
  const prices = (await db.query<{ currency: string; amount_minor: number }>("select currency, amount_minor from public.plan_prices where plan_id=$1 and is_active order by currency", [starterId])).rows;
  return { ...plan, prices: Object.fromEntries(prices.map((p) => [p.currency, p.amount_minor])) };
};
const state = async () => (await db.query<Record<string, unknown>>("select * from public.plan_polar_state where plan_id=$1 and environment='sandbox'", [starterId])).rows[0] ?? null;
const job = async (id: string) => (await db.query<Record<string, unknown>>("select status, stage, last_error, attempts from public.plan_sync_jobs where id=$1", [id])).rows[0];
const activePolar = () => polar.product!.prices.filter((p) => !p.is_archived).map((p) => `${p.price_currency}:${p.price_amount}:${p.id}`).sort();
const BASE = { name: "Starter", maxPlayers: 10, phpMinor: 9900, usdMinor: 199 };

before(async () => {
  db = await createDb();
  admin = await createUser(db, "sync-admin@example.com");
  await db.query("update public.profiles set role='super_admin' where id=$1", [admin]);
  starterId = (await db.query<{ id: string }>("select id from public.subscription_plans where code='starter'")).rows[0].id;
});
beforeEach(async () => {
  polar.reset();
  failFinishOnce = false;
  // back to the baseline locally (and finish any open job) without Polar
  await db.query("update public.plan_sync_jobs set status='superseded' where status in ('pending','polar_applied','failed')");
  const r = await syncPlan(deps(beginFor(BASE, null), null), "starter", BASE);
  assert.equal(r.status, "local_only");
});

describe("admin edit -> Polar -> verified -> local", () => {
  it("1. renaming Starter updates Polar's product name, then BringMe!", async () => {
    const r = await edit({ ...BASE, name: "Starter Night" });
    assert.equal(r.status, "synced");
    assert.equal(polar.product!.name, "Starter Night");
    assert.equal((await local()).name, "Starter Night");
    assert.equal((await state())!.status, "in_sync");
    assert.equal(polar.patches.at(-1)!.prices, undefined, "a name change doesn't touch prices");
  });

  it("2–4,7. USD 1.99 -> 20.00: new USD price in Polar, PHP price kept, old USD archived, mapping stored", async () => {
    const r = await edit({ ...BASE, usdMinor: 2000 });
    assert.equal(r.status, "synced");
    const body = polar.patches.at(-1)!;
    assert.deepEqual(body.prices, [{ id: "price_php_9900" }, { amount_type: "fixed", price_currency: "usd", price_amount: 2000, tax_behavior: "inclusive" }]);
    assert.deepEqual(activePolar(), ["php:9900:price_php_9900", "usd:2000:price_new_1"]);
    assert.deepEqual((await local()).prices, { PHP: 9900, USD: 2000 });
    const s = (await state())!;
    assert.deepEqual([s.usd_price_id, s.usd_minor, s.php_price_id, s.php_minor, s.status], ["price_new_1", 2000, "price_php_9900", 9900, "in_sync"]);
    assert.ok(s.last_synced_at);
    const hist = (await db.query<{ amount_minor: number; is_active: boolean }>("select amount_minor, is_active from public.plan_prices where plan_id=$1 and currency='USD' order by created_at", [starterId])).rows;
    assert.deepEqual(hist.slice(-2).map((h) => [h.amount_minor, h.is_active]), [[199, false], [2000, true]], "local price history kept");
  });

  it("5. after the sync the price-sync guard allows checkout at 20.00, and only at 20.00", async () => {
    await edit({ ...BASE, usdMinor: 2000 });
    assert.deepEqual(priceSyncFromProduct(polar.product, { USD: 2000, PHP: 9900 }), { USD: "ok", PHP: "ok" });
    const u = await createUser(db, "sync-buyer@example.com");
    const o = (await as(db, svc, () => db.query<{ order_id: string; amount_minor: number }>("select * from public.start_checkout_order($1,'starter','USD','sandbox',$2)", [u, PRODUCT]))).rows[0];
    assert.equal(o.amount_minor, 2000);
    const resp = (amount: number) => readCheckoutResponse({ id: "co_s", url: "https://sandbox.polar.sh/c", status: "open", product_id: PRODUCT, currency: "usd", amount, total_amount: amount, tax_amount: null, tax_behavior: "inclusive" });
    assert.deepEqual(verifyCheckout({ productId: PRODUCT, currency: "USD", amountMinor: o.amount_minor }, resp(2000)), { ok: true });
    assert.deepEqual(verifyCheckout({ productId: PRODUCT, currency: "USD", amountMinor: o.amount_minor }, resp(199)), { ok: false, reason: "amount_mismatch" });
  });

  it("6. PHP changed independently: the USD price id is untouched", async () => {
    const r = await edit({ ...BASE, phpMinor: 12900 });
    assert.equal(r.status, "synced");
    assert.deepEqual(polar.patches.at(-1)!.prices, [{ id: "price_usd_199" }, { amount_type: "fixed", price_currency: "php", price_amount: 12900, tax_behavior: "inclusive" }]);
    assert.deepEqual(activePolar(), ["php:12900:price_new_1", "usd:199:price_usd_199"]);
    assert.deepEqual((await local()).prices, { PHP: 12900, USD: 199 });
  });

  it("player limit is a BringMe! field: saved with the verified sync, nothing sent to Polar for it", async () => {
    const r = await edit({ ...BASE, maxPlayers: 12 });
    assert.equal(r.status, "synced");
    assert.equal((await local()).max_players_per_game, 12);
    assert.equal(polar.patches.at(-1)?.prices, undefined);
  });
});

describe("failures never report success and never leave BringMe! ahead of Polar", () => {
  it("8. Polar API failure: job failed, BringMe! unchanged, plan marked sync_failed", async () => {
    polar.failPatch = 1;
    const r = await edit({ ...BASE, usdMinor: 2000 });
    assert.deepEqual([r.status, "stage" in r ? r.stage : null], ["failed", "polar_update"]);
    assert.deepEqual((await local()).prices, { PHP: 9900, USD: 199 }, "local price NOT changed");
    assert.equal((await job(r.jobId)).status, "failed");
    assert.equal((await state())!.status, "sync_failed");
  });

  it("Polar keeping the old USD price active is detected at verification (not success)", async () => {
    polar.archiveOmitted = false;
    const r = await edit({ ...BASE, usdMinor: 2000 });
    assert.deepEqual([r.status, "error" in r ? r.error : null], ["failed", "usd_active_prices_2"]);
    assert.deepEqual((await local()).prices, { PHP: 9900, USD: 199 });
  });

  it("9–11. Supabase save fails after Polar succeeded -> 'polar_ahead'; Retry Sync completes with NO second Polar price", async () => {
    failFinishOnce = true;
    const r = await edit({ ...BASE, usdMinor: 2000 });
    assert.equal(r.status, "polar_ahead");
    assert.equal((await job(r.jobId)).status, "polar_applied");
    assert.equal((await state())!.status, "polar_ahead");
    assert.deepEqual((await local()).prices, { PHP: 9900, USD: 199 }, "BringMe! still sells nothing at the new price");
    assert.equal(polar.created, 1);
    // checkout is protected meanwhile: local 199 vs Polar 2000 -> not in sync
    assert.equal(priceSyncFromProduct(polar.product, { USD: 199 }).USD, "mismatch");

    const retry = (await as(db, svc, () => db.query<{ r: { requested: { name: string; max_players: number; php_minor: number; usd_minor: number } } }>("select public.admin_retry_plan_sync($1,$2) r", [admin, r.jobId]))).rows[0].r;
    const req = { name: retry.requested.name, maxPlayers: retry.requested.max_players, phpMinor: retry.requested.php_minor, usdMinor: retry.requested.usd_minor };
    const again = await syncPlan(deps(async () => r.jobId), "starter", req);
    assert.deepEqual([again.status, "patched" in again ? again.patched : null], ["synced", false], "Polar already matched: no PATCH");
    assert.equal(polar.created, 1, "no duplicate price");
    assert.deepEqual((await local()).prices, { PHP: 9900, USD: 2000 });
    assert.equal((await job(r.jobId)).attempts, 2);
  });

  it("the database refuses to finish a sync whose Polar result doesn't match the request (defense in depth)", async () => {
    const j = await beginFor({ ...BASE, usdMinor: 2000 })();
    const wrong = { product_id: PRODUCT, name: "Starter", modified_at: null, prices: { PHP: { id: "price_php_9900", amount: 9900 }, USD: { id: "price_usd_199", amount: 199 } } };
    assert.match((await errorOf(as(db, svc, () => db.query("select public.admin_finish_plan_sync($1,$2,$3)", [admin, j, JSON.stringify(wrong)])))) ?? "", /polar_result_does_not_match_request/);
    assert.match((await errorOf(as(db, svc, () => db.query("select public.admin_finish_plan_sync($1,$2,null)", [admin, j])))) ?? "", /polar_result_required/);
    assert.deepEqual((await local()).prices, { PHP: 9900, USD: 199 });
    await as(db, svc, () => db.query("select public.admin_fail_plan_sync($1,$2,'verify','test',null)", [admin, j]));
  });

  it("a second concurrent edit is refused while one is running", async () => {
    const first = await beginFor({ ...BASE, usdMinor: 300 })();
    assert.match((await errorOf(beginFor({ ...BASE, usdMinor: 400 })())) ?? "", /sync_in_progress/);
    await as(db, svc, () => db.query("select public.admin_fail_plan_sync($1,$2,'fetch','test',null)", [admin, first]));
  });

  it("15. one-time stays one-time: never sends recurring/archive fields; refuses a recurring product", async () => {
    await edit({ ...BASE, usdMinor: 2000, name: "Starter X" });
    for (const b of polar.patches) for (const k of ["recurring_interval", "recurring_interval_count", "is_archived", "visibility"]) assert.ok(!(k in b), k);
    polar.product!.is_recurring = true; polar.product!.recurring_interval = "week";
    const r = await edit({ ...BASE, usdMinor: 2100 });
    assert.deepEqual([r.status, "error" in r ? r.error : null], ["failed", "product_is_recurring"]);
  });

  it("wrong organization: refused before any write", async () => {
    polar.product!.organization_id = "55555555-5555-4555-8555-555555555555";
    const r = await edit({ ...BASE, usdMinor: 2000 });
    assert.deepEqual([r.status, "error" in r ? r.error : null], ["failed", "organization_mismatch"]);
    assert.equal(polar.patches.length, 0);
  });
});

describe("history, authorization, Polar-side changes", () => {
  it("12. old purchases keep their price; an open checkout made before the change is honoured at its own price", async () => {
    const u = await createUser(db, "sync-old@example.com");
    const o = (await as(db, svc, () => db.query<{ order_id: string }>("select * from public.start_checkout_order($1,'starter','USD','sandbox',$2)", [u, PRODUCT]))).rows[0].order_id;
    await as(db, svc, () => db.query("select public.attach_verified_checkout($1,'co_old',$2,'usd',199,null,'https://x.polar.sh/old',now() + interval '1 hour')", [o, PRODUCT]));
    await edit({ ...BASE, usdMinor: 2000 });
    const row = (await db.query<{ amount_minor: number; plan_price_amount: number }>(
      "select o.amount_minor, pp.amount_minor plan_price_amount from public.pass_orders o join public.plan_prices pp on pp.id = o.plan_price_id where o.id=$1", [o])).rows[0];
    assert.deepEqual([row.amount_minor, row.plan_price_amount], [199, 199], "order + its price row untouched");
    const out = (await as(db, svc, () => db.query<{ r: string }>("select public.apply_payment_event('polar','evt_old','order.paid','{}',$1) r", [JSON.stringify({
      kind: "order_paid", order_id: o, polar_order_id: "po_old", polar_checkout_id: "co_old", polar_product_id: PRODUCT, external_customer_id: u, currency: "USD", amount_minor: 199, environment: "sandbox" })]))).rows[0].r;
    assert.equal(out, "applied", "documented policy: the buyer pays the price they were shown");
  });

  it("13. only super admins (via the server) can start, finish or retry a sync", async () => {
    const host = await createUser(db, "sync-host@example.com");
    assert.match((await errorOf(as(db, svc, () => db.query("select public.admin_begin_plan_sync($1,$2,'sandbox',$3,'{}')", [host, starterId, PRODUCT])))) ?? "", /forbidden/);
    for (const sql of ["select public.admin_begin_plan_sync($1,$2,'sandbox','p','{}')", "select public.record_polar_product_state('sandbox','starter','{}')"]) {
      assert.match((await errorOf(as(db, { role: "authenticated", sub: admin }, () => db.query(sql, sql.includes("$1") ? [admin, starterId] : [])))) ?? "", /permission denied/);
    }
    assert.equal((await as(db, { role: "authenticated", sub: host }, () => db.query("select * from public.plan_sync_jobs"))).rows.length, 0, "jobs are admin-readable only");
  });

  it("14. a product.updated from Polar never overwrites BringMe!; stale or in-progress reads are ignored", async () => {
    await edit({ ...BASE, usdMinor: 2000 });
    const syncedAt = (await state())!.polar_modified_at;
    const config = parseWebhookEnv({ NODE_ENV: "development", POLAR_SERVER: "sandbox", POLAR_ACCESS_TOKEN: "t", POLAR_WEBHOOK_SECRET: "whsec_eA==", POLAR_ORGANIZATION_ID: ORG });
    let served: Record<string, unknown> | null = null;
    const wdeps = {
      config, fetchOrder: async () => null, fetchCheckout: async () => null, productPlans: { [PRODUCT]: "starter" },
      fetchProduct: async () => served,
      recordProduct: async (plan: string, p: Record<string, unknown>) =>
        (await as(db, svc, () => db.query<{ r: string }>("select public.record_polar_product_state('sandbox',$1,$2) r", [plan, JSON.stringify(p)]))).rows[0].r,
      apply: async (id: string, type: string, summary: Record<string, unknown>, effect: Record<string, unknown>) =>
        (await as(db, svc, () => db.query<{ r: string }>("select public.apply_payment_event('polar',$1,$2,$3,$4) r", [id, type, JSON.stringify(summary), JSON.stringify(effect)]))).rows[0].r,
    };
    // (a) stale: an OLDER Polar state (before our sync) arrives late
    served = { ...structuredClone(polar.product!), modified_at: "2026-11-11T14:00:00Z", prices: [
      { id: "price_usd_199", amount_type: "fixed", price_currency: "usd", price_amount: 199, is_archived: false, tax_behavior: "inclusive" },
      { id: "price_php_9900", amount_type: "fixed", price_currency: "php", price_amount: 9900, is_archived: false, tax_behavior: "inclusive" }] };
    assert.deepEqual((await processEvent(wdeps, "msg_stale", "product.updated", { id: PRODUCT })).body.outcomes, ["ignored", "stale"]);
    assert.deepEqual((await local()).prices, { PHP: 9900, USD: 2000 });
    assert.equal((await state())!.polar_modified_at instanceof Date ? ((await state())!.polar_modified_at as Date).toISOString() : (await state())!.polar_modified_at,
      syncedAt instanceof Date ? syncedAt.toISOString() : syncedAt);
    // (b) someone edits the price directly in Polar later: flagged, local NOT overwritten
    served = { ...structuredClone(polar.product!), modified_at: "2026-11-11T18:00:00Z" };
    (served.prices as FakePrice[]).find((p) => p.price_currency === "usd" && !p.is_archived)!.price_amount = 1500;
    assert.deepEqual((await processEvent(wdeps, "msg_drift", "product.updated", { id: PRODUCT })).body.outcomes, ["ignored", "out_of_sync"]);
    assert.deepEqual((await local()).prices, { PHP: 9900, USD: 2000 }, "admin's intended price kept");
    const s = (await state())!;
    assert.deepEqual([s.status, (s.details as { usd_minor: number }).usd_minor], ["out_of_sync", 1500]);
    assert.equal(priceSyncFromProduct(served, { USD: 2000 }).USD, "mismatch", "so checkout is blocked until resolved");
    // (c) duplicate delivery of the same event: no second record
    assert.deepEqual((await processEvent(wdeps, "msg_drift", "product.updated", { id: PRODUCT })).body.outcomes, ["duplicate"]);
    // (d) unrelated product id: recorded, no plan touched
    assert.deepEqual((await processEvent(wdeps, "msg_other", "product.updated", { id: "99999999-9999-4999-8999-999999999999" })).body.outcomes, ["ignored"]);
  });

  it("summaries contain ids and amounts only", () => {
    const p = readPolarProduct({ id: PRODUCT, name: "Starter", is_recurring: false, is_archived: false, organization_id: ORG, modified_at: null, metadata: {},
      prices: [{ id: "a", amount_type: "fixed", price_currency: "usd", price_amount: 199, is_archived: false }] })!;
    assert.deepEqual(summarize(p), { product_id: PRODUCT, name: "Starter", modified_at: null, prices: { PHP: null, USD: { id: "a", amount: 199 } } });
  });
});
