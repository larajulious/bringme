/**
 * Phase 9 QA / security audit checks (GAME_PASS_QA_REPORT.md). Real SQL on PGlite, all migrations.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";

import { parseWebhookEnv } from "../../lib/billing/config.ts";
import { processEvent } from "../../lib/billing/webhook.ts";
import { as, createDb, createUser, errorOf } from "./harness.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const svc = { role: "service_role" } as const;
const PROD = "11111111-1111-4111-8111-111111111111";
const ORG = "44444444-4444-4444-8444-444444444444";
let db: PGlite;

// Exactly what client roles may EXECUTE (non-trigger functions). Anything new must be reviewed here.
const ANON_EXEC = ["can_listen_game_topic"];
const AUTH_EXEC = [
  "admin_list_subscribers", "admin_overview", "admin_pass_counts", "admin_pass_timeline", "admin_purchase_history", "admin_revenue",
  "admin_subscriber_state",
  // BingoSnap (migrations 18-20): owner-checked inside; guests use the service-role functions only
  "bingo_host_state", "bingo_review_submission", "bingo_save_board", "bingo_start", "bingo_transition", "bingo_update_settings",
  "can_listen_game_topic", "create_bingosnap_game", "create_game_with_rounds", "default_max_players", "ensure_my_trial", "game_results",
  "game_transition", "generate_join_code", "host_game_state", "is_super_admin", "my_access_status", "my_checkout_status", "my_entitlement",
  "my_game_pass_summary", "my_pass_timeline", "my_purchase_history", "my_trial_eligibility", "owns_game", "owns_game_path",
  "review_submission", "round_ranking", "start_trial",
];
const execFor = async (role: string) => (await db.query<{ proname: string }>(
  `select p.proname from pg_proc p where p.pronamespace='public'::regnamespace and p.prorettype <> 'trigger'::regtype
     and has_function_privilege('${role}', p.oid, 'EXECUTE') order by 1`)).rows.map((r) => r.proname);

before(async () => { db = await createDb(); });

describe("privilege inventory (no billing / entitlement function reachable by clients except self-scoped or admin-checked ones)", () => {
  it("anon (incl. guest players' Realtime token, role anon) can execute only the channel check", async () => {
    assert.deepEqual(await execFor("anon"), ANON_EXEC);
  });
  it("authenticated can execute exactly the reviewed allowlist", async () => {
    assert.deepEqual(await execFor("authenticated"), AUTH_EXEC);
  });
  it("trigger functions cannot be invoked as RPCs", async () => {
    const u = await createUser(db, "qa-trig@example.com");
    assert.match((await errorOf(as(db, { role: "authenticated", sub: u }, () => db.query("select public.enforce_player_insert()")))) ?? "", /trigger functions can only be called as triggers/);
  });
  it("no table is writable by anon/authenticated except the audited column grants; RLS is on everywhere", async () => {
    const cols = (await db.query<{ t: string }>(
      `select distinct table_name || '.' || column_name || ':' || privilege_type t from information_schema.column_privileges
        where grantee in ('anon','authenticated') and table_schema='public' and privilege_type in ('INSERT','UPDATE') order by 1`)).rows.map((r) => r.t);
    assert.deepEqual(cols, [
      "game_rounds.game_id:INSERT", "game_rounds.points:INSERT", "game_rounds.points:UPDATE", "game_rounds.prompt:INSERT", "game_rounds.prompt:UPDATE",
      "game_rounds.round_no:INSERT", "game_rounds.round_no:UPDATE", "game_rounds.time_limit_seconds:INSERT", "game_rounds.time_limit_seconds:UPDATE",
      "games.max_players:INSERT", "games.max_players:UPDATE", "games.owner_id:INSERT", "games.title:INSERT", "games.title:UPDATE",
      "players.kicked_at:UPDATE", "profiles.display_name:UPDATE",
    ]);
    const tableWrites = (await db.query<{ n: string }>(
      `select count(*)::text n from information_schema.table_privileges where grantee in ('anon','authenticated') and table_schema='public' and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')`)).rows[0].n;
    assert.equal(tableWrites, "0");
    const rlsOff = (await db.query("select relname from pg_class where relnamespace='public'::regnamespace and relkind='r' and not relrowsecurity")).rows;
    assert.deepEqual(rlsOff, []);
  });
  it("role escalation is impossible for clients (role column not granted; trigger blocks even service writes from non-trusted roles)", async () => {
    const u = await createUser(db, "qa-esc@example.com");
    assert.match((await errorOf(as(db, { role: "authenticated", sub: u }, () => db.query("update public.profiles set role='super_admin' where id=$1", [u])))) ?? "", /permission denied/);
  });
});

describe("TypeScript types match the migrated schema", () => {
  it("every function in database.types.ts exists with the same argument names", async () => {
    const src = readFileSync(join(ROOT, "lib", "supabase", "database.types.ts"), "utf8");
    const block = src.slice(src.indexOf("Functions: {"), src.indexOf("Enums: {"));
    const fnRe = /^ {6}([a-z_]+): \{\s*Args: (Record<string, never>|\{([^}]*)\})/gm;
    const missing: string[] = [];
    let m: RegExpExecArray | null;
    let count = 0;
    while ((m = fnRe.exec(block))) {
      count++;
      const name = m[1];
      const args = m[3] ? [...m[3].matchAll(/(p_[a-z_]+)\??:/g)].map((x) => x[1]).sort() : [];
      const rows = (await db.query<{ a: string[] | null }>("select proargnames a from pg_proc where pronamespace='public'::regnamespace and proname=$1", [name])).rows;
      const ok = rows.some((r) => {
        const inArgs = (r.a ?? []).filter((x) => x.startsWith("p_")).sort();
        return args.every((x) => inArgs.includes(x));
      });
      if (!ok) missing.push(`${name}(${args.join(",")})`);
    }
    assert.equal(count, 67, `parsed ${count} functions (update when the types gain or lose functions)`);
    assert.deepEqual(missing, []);
  });
});

describe("constraints, timestamps and the SQL verification script", () => {
  let user: string;
  let order: string;
  before(async () => {
    user = await createUser(db, "qa-flow@example.com");
    const o = (await as(db, svc, () => db.query<{ order_id: string }>("select * from public.start_checkout_order($1,'starter','PHP','sandbox',$2)", [user, PROD]))).rows[0];
    order = o.order_id;
    await as(db, svc, () => db.query("select public.attach_verified_checkout($1,'co_qa',$2,'php',9900,null,'https://x.polar.sh/co_qa',now() + interval '1 hour')", [order, PROD]));
    await as(db, svc, () => db.query("select public.apply_payment_event('polar','evt_qa','order.paid','{}',$1)", [JSON.stringify({
      kind: "order_paid", order_id: order, polar_order_id: "po_qa", polar_checkout_id: "co_qa", polar_product_id: PROD,
      external_customer_id: user, currency: "PHP", amount_minor: 9900, environment: "sandbox" })]));
  });

  it("unique constraints reject duplicates even for trusted roles", async () => {
    const other = await createUser(db, "qa-other@example.com");
    const o2 = (await as(db, svc, () => db.query<{ order_id: string }>("select * from public.start_checkout_order($1,'party','PHP','sandbox',$2)", [other, "22222222-2222-4222-8222-222222222222"]))).rows[0].order_id;
    assert.match((await errorOf(db.query("update public.pass_orders set polar_checkout_id='co_qa' where id=$1", [o2]))) ?? "", /duplicate key|pass_orders_polar_checkout_key/);
    assert.match((await errorOf(db.query("insert into public.payment_events (provider, event_id, event_type, payload) values ('polar','evt_qa','x','{}')"))) ?? "", /duplicate key/);
    const plan = (await db.query<{ id: string }>("select plan_id id from public.pass_orders where id=$1", [order])).rows[0].id;
    assert.match((await errorOf(db.query("insert into public.game_passes (user_id, plan_id, source, order_id, max_players, duration_seconds) values ($1,$2,'purchase',$3,10,1)", [user, plan, order]))) ?? "", /duplicate key|game_passes_order_key/);
  });

  it("required timestamps are populated after a full purchase", async () => {
    const o = (await db.query<Record<string, unknown>>("select created_at, updated_at, paid_at, checkout_verified_at, checkout_expires_at from public.pass_orders where id=$1", [order])).rows[0];
    assert.ok(Object.values(o).every((v) => v !== null), JSON.stringify(o));
    const e = (await db.query<{ received_at: Date; processed_at: Date | null }>("select received_at, processed_at from public.payment_events where event_id='evt_qa'")).rows[0];
    assert.ok(e.received_at && e.processed_at);
    const nulls = (await db.query<{ n: string }>(`select (
        (select count(*) from public.pass_segments where starts_at is null or ends_at is null) +
        (select count(*) from public.game_passes where created_at is null) +
        (select count(*) from public.entitlement_events where at is null))::text n`)).rows[0].n;
    assert.equal(nulls, "0");
  });

  it("the post-migration verification script (supabase/inspect/game_pass_postflight.sql) passes its own expectations", async () => {
    const sql = readFileSync(join(ROOT, "supabase", "inspect", "game_pass_postflight.sql"), "utf8");
    const stmts = sql.split(/;\s*\n/).map((s) => s.replace(/^\s*(--[^\n]*\n\s*)*/g, "").trim()).filter(Boolean);
    const results = [] as Record<string, unknown>[][];
    for (const s of stmts) results.push((await db.query<Record<string, unknown>>(s)).rows);
    const find = (pred: (rows: Record<string, unknown>[]) => boolean) => results.find(pred);
    const plans = find((r) => r[0] && "is_trial" in r[0] && "tier" in r[0])!;
    assert.deepEqual(plans.map((r) => [r.code, r.max_players_per_game, r.duration_seconds]), [["trial", 3, 604800], ["starter", 10, 604800], ["party", 50, 604800], ["pro", 100, 604800]]);
    const overlaps = find((r) => r[0] && "overlaps" in r[0])!;
    assert.equal(Number(overlaps[0].overlaps), 0);
    const writes = find((r) => r[0] && "client_can_write" in r[0])!;
    assert.ok(writes.every((r) => r.client_can_write === false), JSON.stringify(writes));
    const exec = find((r) => r[0] && "auth_exec" in r[0])!;
    assert.ok(exec.length >= 10 && exec.every((r) => r.auth_exec === false && r.anon_exec === false), JSON.stringify(exec.filter((r) => r.auth_exec || r.anon_exec)));
  });
});

describe("reconciliation path (same verified, idempotent pipeline as the webhook)", () => {
  it("reconciling an already-fulfilled order is a no-op; reconciling a missed payment fulfils it once", async () => {
    const config = parseWebhookEnv({ NODE_ENV: "development", POLAR_SERVER: "sandbox", POLAR_ACCESS_TOKEN: "t", POLAR_WEBHOOK_SECRET: "whsec_eA==", POLAR_ORGANIZATION_ID: ORG });
    const u = await createUser(db, "qa-reconcile@example.com");
    const o = (await as(db, svc, () => db.query<{ order_id: string }>("select * from public.start_checkout_order($1,'starter','PHP','sandbox',$2)", [u, PROD]))).rows[0].order_id;
    await as(db, svc, () => db.query("select public.attach_verified_checkout($1,'co_rec',$2,'php',9900,null,'https://x.polar.sh/co_rec',now() + interval '1 hour')", [o, PROD]));
    const polar = { id: "po_rec", status: "paid", paid: true, currency: "php", discount_amount: 0, net_amount: 9900, tax_amount: 0, total_amount: 9900, refunded_amount: 0,
      billing_reason: "purchase", product_id: PROD, checkout_id: "co_rec", customer_id: "c", customer: { external_id: u, organization_id: ORG }, product: { organization_id: ORG }, metadata: {} };
    const deps = {
      config, fetchOrder: async () => polar, fetchCheckout: async () => null,
      apply: async (id: string, type: string, summary: Record<string, unknown>, effect: Record<string, unknown>) =>
        (await as(db, svc, () => db.query<{ r: string }>("select public.apply_payment_event('polar',$1,$2,$3,$4) r", [id, type, JSON.stringify(summary), JSON.stringify(effect)]))).rows[0].r,
    };
    // the webhook never arrived: admin reconcile fulfils it (matched by checkout id; no metadata needed)
    assert.deepEqual((await processEvent(deps, "reconcile:po_rec", "order.reconcile", { id: "po_rec" })).body.outcomes, ["applied"]);
    assert.deepEqual((await processEvent(deps, "reconcile:po_rec", "order.reconcile", { id: "po_rec" })).body.outcomes, ["duplicate"]);
    assert.deepEqual((await processEvent(deps, "msg_late_webhook", "order.paid", { id: "po_rec" })).body.outcomes, ["duplicate_effect"], "the late real webhook adds nothing");
    assert.equal((await db.query("select 1 from public.game_passes where order_id=$1", [o])).rows.length, 1);
  });
});
