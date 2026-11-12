/**
 * Phase 3 — automatic Free Trial (migration 20261112000008_auto_trial.sql).
 * The concurrent-activation case runs on real PostgreSQL in tests/concurrency.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";

import { as, confirmUser, createDb, createUser, errorOf, shiftLedger, subscribe } from "./harness.ts";

const WEEK = 604_800;
const svc = { role: "service_role" } as const;
const user = (sub: string) => ({ role: "authenticated", sub }) as const;

let db: PGlite;
let n = 0;
const newHost = () => createUser(db, `auto-${++n}@example.com`);
const trialRows = async (u: string) => (await db.query<{ id: string; starts_at: string; ends_at: string; secs: number; disposition: string }>(
  `select g.id, s.starts_at::text, s.ends_at::text, extract(epoch from (s.ends_at - s.starts_at))::float8 secs, g.disposition::text
     from public.game_passes g left join public.pass_segments s on s.pass_id = g.id
    where g.user_id = $1 and g.source = 'trial'`, [u])).rows;
const summary = async (u: string) =>
  (await as(db, user(u), () => db.query<{ s: Record<string, unknown> & { trial: Record<string, unknown> } }>("select public.my_game_pass_summary() s"))).rows[0].s;
const ensure = async (u: string) =>
  (await as(db, user(u), () => db.query<{ granted: boolean; reason: string | null }>("select * from public.ensure_my_trial()"))).rows[0];
const state = async (u: string) => (await db.query<{ state: string; plan_code: string | null }>("select * from public.access_state_for($1)", [u])).rows[0];

before(async () => { db = await createDb(); });

describe("automatic free trial", () => {
  it("an unconfirmed signup has no access; confirming the email grants ONE trial (3 players, exactly 7 days)", async () => {
    const u = await newHost();
    assert.equal((await trialRows(u)).length, 0, "nothing before the account is valid");
    assert.equal((await state(u)).state, "pending");
    await confirmUser(db, u);
    const t = await trialRows(u);
    assert.equal(t.length, 1);
    assert.equal(t[0].secs, WEEK);
    const s = await summary(u);
    assert.equal(s.state, "active");
    assert.equal(s.isTrial, true);
    assert.equal(s.maxPlayers, 3);
    assert.equal(s.planCode, "trial");
    assert.ok(Math.abs(Number(s.passRemainingSeconds) - WEEK) < 5);
    assert.equal(s.trial.status, "active");
    const ev = (await db.query<{ actor_kind: string }>("select actor_kind from public.entitlement_events where user_id=$1 and action='trial_started'", [u])).rows;
    assert.deepEqual(ev.map((e) => e.actor_kind), ["system"], "granted by the server, audited once");
  });

  it("projects with auto-confirm: a signup that is confirmed on insert gets the trial at once", async () => {
    const u = (await db.query<{ id: string }>("insert into auth.users (email, email_confirmed_at) values ('autoconfirm@example.com', now()) returning id")).rows[0].id;
    assert.equal((await trialRows(u)).length, 1);
    assert.equal((await state(u)).plan_code, "trial");
  });

  it("repeated initialization, sign-ins, re-confirmation, profile and password changes never reset or extend it", async () => {
    const u = await newHost();
    await confirmUser(db, u);
    const first = await trialRows(u);
    for (let i = 0; i < 3; i++) {
      const r = await ensure(u);                    // /auth/continue on every sign-in, other browsers, the dashboard button
      assert.deepEqual([r.granted, r.reason], [false, "trial_already_used"]);
    }
    await as(db, user(u), () => db.query("update public.profiles set display_name='Renamed host' where id=$1", [u]));   // profile update
    await db.query("update auth.users set raw_user_meta_data = '{\"pw\":\"changed\"}' where id=$1", [u]);              // password reset / metadata
    await db.query("update auth.users set email_confirmed_at = null where id=$1", [u]);                                  // email change flow
    await confirmUser(db, u);                                                                                            // ...re-confirmed
    assert.match((await errorOf(as(db, user(u), () => db.query("select public.start_trial()")))) ?? "", /trial_already_used/);
    assert.deepEqual(await trialRows(u), first, "same single trial, same start and end");
  });

  it("the client cannot choose dates or act for someone else", async () => {
    const u = await newHost();
    assert.match((await errorOf(as(db, user(u), () => db.query("select * from public.ensure_my_trial(now(), now() + interval '1 year')")))) ?? "", /does not exist/);
    assert.match((await errorOf(as(db, user(u), () => db.query("select * from public.ensure_trial_for($1)", [u])))) ?? "", /permission denied/);
    assert.match((await errorOf(as(db, { role: "anon" }, () => db.query("select * from public.ensure_my_trial()")))) ?? "", /permission denied/);
    assert.match((await errorOf(as(db, user(u), () => db.query(
      "insert into public.game_passes (user_id, plan_id, source, max_players, duration_seconds) select $1, id, 'trial', 3, 99999999 from public.subscription_plans where code='trial'", [u])))) ?? "", /permission denied/);
  });

  it("existing paid, manual and legacy access is preserved and never gets a trial", async () => {
    const paid = await newHost();
    await subscribe(db, paid, { plan: "party" });   // manual / legacy-style access (ledger fixture)
    const before = await state(paid);
    await confirmUser(db, paid);
    const r = await ensure(paid);
    assert.deepEqual([r.granted, r.reason], [false, "has_pass_history"]);
    assert.deepEqual(await state(paid), before);
    assert.equal((await trialRows(paid)).length, 0);

    const admin = await newHost();
    await as(db, svc, () => db.query("select public.admin_grant_pass(null,$1,'starter',7,'comp')", [admin]));
    await confirmUser(db, admin);
    assert.equal((await trialRows(admin)).length, 0, "a manual grant counts as a used account");
  });

  it("super admins, deactivated and suspended accounts never receive a trial", async () => {
    const boss = await newHost();
    await db.query("update public.profiles set role='super_admin' where id=$1", [boss]);
    await confirmUser(db, boss);
    const deact = await newHost();
    await as(db, svc, () => db.query("select public.admin_set_account_active($1,false)", [deact]));
    await confirmUser(db, deact);
    for (const u of [boss, deact]) assert.equal((await trialRows(u)).length, 0);
  });

  it("expires after exactly seven days by time alone (no job): one minute before it is active, at 7 days it is not", async () => {
    const u = await newHost();
    await confirmUser(db, u);
    await shiftLedger(db, u, WEEK - 60);
    assert.equal((await state(u)).state, "active");
    await shiftLedger(db, u, 60);
    const t = await trialRows(u);
    assert.equal(t[0].disposition, "granted", "nothing wrote to the pass: expiry is computed from the timestamps");
    assert.equal((await state(u)).state, "expired");
    assert.match((await errorOf(as(db, user(u), () => db.query("insert into public.games (owner_id, title) values ($1,'late')", [u])))) ?? "", /subscription_required/);
    const s = await summary(u);
    assert.equal(s.trialEndedNoPass, true, "dashboard shows 'Your free trial has ended'");
    assert.equal(s.trial.status, "ended");
    assert.deepEqual([(await ensure(u)).granted, (await ensure(u)).reason], [false, "trial_already_used"]);
  });

  it("a failed activation never blocks sign-up, and the next sign-in grants it", async () => {
    const u = await newHost();
    await db.query("update public.subscription_plans set is_active=false where code='trial'");
    try {
      assert.equal(await errorOf(confirmUser(db, u)), null, "confirmation still succeeds");
      assert.equal((await trialRows(u)).length, 0);
      assert.deepEqual([(await ensure(u)).granted, (await ensure(u)).reason], [false, "trial_unavailable"]);
    } finally {
      await db.query("update public.subscription_plans set is_active=true where code='trial'");
    }
    const r = await ensure(u);
    assert.deepEqual([r.granted, r.reason], [true, null]);
    assert.equal((await trialRows(u)).length, 1);
  });

  it("summary: a trial replaced by a purchase is not reported as 'trial ended'", async () => {
    const u = await newHost();
    await confirmUser(db, u);
    await as(db, svc, () => db.query("select public.admin_grant_pass(null,$1,'party',7,'won a raffle')", [u]));
    const s = await summary(u);
    assert.equal(s.planCode, "party");
    assert.equal(s.isTrial, false);
    assert.equal(s.trialEndedNoPass, false);
  });
});
