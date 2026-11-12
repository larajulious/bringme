# BringMe! — Game Pass Migration Verification (Phase 2)

_2026-11-11_

> **These migrations have NOT been executed on the hosted Supabase project.** No database
> connection string or Supabase CLI link is available in this environment (audit §0). The only
> live access is the server key over PostgREST, which can't run DDL. Everything under
> "Executed" ran against **local** PostgreSQL: PGlite (PG 17, in-memory) and embedded
> PostgreSQL 18 (real concurrent connections). §3 is the runbook for applying the files to the
> hosted project.

## 1. What was delivered

| File | Purpose | Behaviour change |
|---|---|---|
| `supabase/migrations/20261112000001_game_pass_types.sql` | enums `pass_source`, `pass_disposition`, `order_status` | none |
| `…0002_plan_catalogue.sql` | `subscription_plans` + `tier`, `duration_seconds`, `is_trial`, `sort_order`; **Free Trial** plan; `plan_prices` (PHP + USD, integer minor units) | none |
| `…0003_pass_ledger.sql` | `btree_gist`; `game_passes`, `pass_segments` (**no-overlap exclusion**), `entitlement_events` (append-only); `profiles.hosting_suspended_at`; guards; RLS | none (empty tables) |
| `…0004_orders_webhooks.sql` | `pass_orders` (monotonic payment states, unique Polar ids), `payment_events` (unique `(provider, event_id)`) | none |
| `…0005_pass_functions.sql` | replan, grant/revoke, trial, timeline, admin tools, orders, `apply_payment_event`, `admin_review_order` | none (no callers yet) |
| `…0006_legacy_backfill.sql` | every `subscriptions` row → `legacy_subscription` pass with the **identical** interval; then Pro 200 → 100 | none |
| `…0007_entitlement_cutover.sql` | entitlement/access state from the ledger; capacity = pass cap; D-9/D-10; admin shim; `subscriptions` frozen | **yes** |
| `…0008_auto_trial.sql` (Phase 3) | automatic trial: `ensure_trial_for` / `ensure_my_trial` (idempotent), `on_auth_user_trial` trigger, tightened `trial_eligibility`, `my_game_pass_summary` | yes: new confirmed hosts get the trial |
| `supabase/rollback/20261112000007_entitlement_cutover_revert.sql` | compensating revert (not a migration) | reverts 7 |
| `supabase/inspect/game_pass_preflight.sql`, `game_pass_postflight.sql` | read-only checks before/after | — |
| `lib/supabase/database.types.ts` | ledger tables, enums, functions; `subscriptions` typed as frozen | — |
| `app/api/admin/users/[id]/subscription/route.ts` | calls `admin_grant_pass` / `admin_set_pass_plan` / `admin_set_pass_expiry` / `admin_set_suspended` **with the admin's id** (audited) | — |
| `lib/admin/queries.ts`, `app/admin/(console)/subscribers/[id]/page.tsx` | subscriber history from `admin_pass_timeline` | — |
| `components/admin/subscriber-actions.tsx`, `lib/admin/client.ts`, `lib/host/errors.ts`, `components/game/lobby-view.tsx` | 7-day default, Game Pass wording, new error codes (`player_limit_exceeded`, `paid_pass_immutable`, `reason_required`) | — |
| `tests/db/game-pass.test.ts` (45 tests), `tests/concurrency/engine-concurrency.mjs` (+4 races), harness/shim helpers | — | — |

Polar checkout, webhook route and pricing UI are **not** implemented (Phase 3).

`cutover` and `revert` are generated from the existing migrations by a scratch script, so `game_transition` and every restored function body are **verbatim copies**. The two `game_transition` edits are asserted to match exactly once.

## 2. Executed results (local)

| Check | Command / environment | Result |
|---|---|---|
| Typecheck | `npx tsc --noEmit` | ✅ pass |
| Lint | `npm run lint` | ✅ clean |
| Build | `npm run build` | ✅ pass |
| Unit + SQL suite | `npm test` (PGlite, shim + all 20 migrations) | ✅ **255/255** (210 existing + 45 new) |
| Real-Postgres races | `npm run test:concurrency` (embedded PG 18, `--no-save` deps; lockfile unchanged), run 3× | ✅ **20/20** each run (16 existing + 4 new); both commit orders observed |
| Inspection scripts | preflight on pre-Game-Pass DB, postflight on migrated DB (PGlite) | ✅ all statements run; only `supabase_migrations` is absent locally (expected) |
| Live read-only probe | PostgREST OpenAPI + `HEAD` counts + 1 `GET` (server key, no writes) | ✅ Game Pass objects **absent**; counts unchanged since the audit |

### 2.1 Required validations → evidence

| Requirement | Evidence (test name / file) | Result |
|---|---|---|
| All four plan configurations | "has the four final plans…" — trial 3 / starter 10 / party 50 / pro 100, tiers 0–3, 604 800 s | ✅ |
| Existing limits preserved | "keeps the audited non-player limits" — open games 1/1/3/10, rounds 5/5/15/40, period cap null | ✅ |
| Separate PHP and USD prices, currency precision | "stores PHP and USD separately…" — 9900/199, 19900/349, 29900/499, trial 0/0; `integer` column; rendered `99.00`, `1.99` … | ✅ |
| Price constraints | zero only for trial; trial only zero; `EUR` refused; one active price per plan × currency | ✅ |
| Profile / game / round / player / submission counts unchanged | M-1 on a live-shaped DB: counts identical before vs. after (plans +1 = trial), and again after a full re-run | ✅ |
| Existing games unchanged and still work | M-1: the pre-existing lobby accepts a player and **starts**; whole existing suite green | ✅ |
| Paid/manual access preserved | M-1: live-shaped 30-day Starter row → one pass, **same `[start, end)` to the microsecond**, cap 10, source `legacy_subscription` | ✅ |
| Old vs new resolution | M-4: state + plan identical for active / expired / canceled / suspended / never-subscribed hosts; exact end for running access | ✅ (see 4.4) |
| No overlapping active entitlements | exclusion constraint (service-role insert refused); overlap query = 0 after every test and race | ✅ |
| Correct 7-day timestamps | segment length exactly 604 800 s, also with session `timezone = America/New_York`; queued pass starts exactly at previous `ends_at` (half-open: `[s,e) @> e` is false) | ✅ |
| Duplicate free-trial prevention | T-2 (repeat, after expiry, direct insert hits the unique index); race: 10 simultaneous `start_trial` → exactly 1 | ✅ |
| Unique external ids / event dedupe | same `event_id` 10× concurrently → 1 `applied`, 9 `duplicate`, 1 pass; same Polar order via a new event → `duplicate_effect`; unique `polar_order_id`, `polar_checkout_id` | ✅ |
| RLS / privileges | S-1 (anon + authenticated can't insert/delete any of 6 new tables), S-2 (own rows only; no `grant_reason`, Polar ids or `payment_events`; audit log admin-only), S-6 (server functions not executable by clients); anon reads prices but not Polar ids | ✅ |
| Immutability | audit log update/delete refused; past segments, pass/order deletes refused, even as `postgres`; order status can't move backwards | ✅ |
| Re-runnability | M-2: all 7 files applied twice → no new passes/events, same counts and states; legacy-compat suite applies compat + all 20 files twice | ✅ |
| Explicit precondition guards | future-start legacy row → backfill stops, nothing written; cutover refuses while running subscriptions lack a pass; file 2 refuses without `code`/`max_active_games` (the audit's 42703 family) | ✅ |
| Rollback | M-5: cutover → new Pro purchase → **revert** → identical access under the legacy functions (buyer: pro, 100 players) → re-apply all 7 → identical, no duplicate passes | ✅ |

## 3. Runbook for the hosted project (not executed)

1. **Backups.** Confirm in Dashboard → Database → Backups that a recent backup exists (daily backups / PITR depend on the plan; **not verified**). With a connection string: `pg_dump --schema=public --schema=auth -Fc > pre_game_pass.dump`.
2. **Preflight.** Run `supabase/inspect/game_pass_preflight.sql` in the SQL Editor and save the output. **Go criteria:** every P3 row `ok = true` (including *m12 applied* and *btree_gist available*); P5b and P5c return no rows; P7 shows no long transactions.
3. **Migration history.** If P2 is empty, record the already-applied files once, before any CLI push: `supabase migration repair --status applied 20261110000000 20261111000001 … 20261111000012`.
4. **Apply 1–6** (no behaviour change), each as its own run wrapped in `begin; … commit;`. Check postflight Q2–Q4 and Q7–Q8 between 6 and 7.
5. **Apply 7 and 8** together with the app deploy that contains the Phase 2 + 3 code changes. File 8 grants nothing at migration time: existing hosts with any pass history stay ineligible, and never-used accounts get the trial at their next sign-in.
6. **Postflight.** Run `game_pass_postflight.sql`. Expected: Q1 counts = P1 (+1 plan), Q4 no rows, Q5 subscriber `active / starter / 2026-12-11 08:26:51+00`, Q6 = 0, Q7/Q8 all false.
7. **Manual check:** the subscriber signs in → dashboard "Active", creates a game (lobby shows `/10`); admin → subscriber page shows "Game Pass history: Starter · Legacy subscription · active".

### Locking / blocking operations

| Operation | Lock | Expected impact on this project's sizes (≤ 10 rows/table) |
|---|---|---|
| `ALTER TABLE subscription_plans/profiles ADD COLUMN … DEFAULT const` | ACCESS EXCLUSIVE, metadata-only (no rewrite, PG ≥ 11) | milliseconds |
| `ADD CONSTRAINT … CHECK` on `subscription_plans` | ACCESS EXCLUSIVE, validates 3–4 rows | milliseconds |
| `CREATE EXTENSION btree_gist` | catalog | needs `postgres` role (SQL Editor default) |
| `CREATE TRIGGER` on `subscriptions` | SHARE ROW EXCLUSIVE | milliseconds |
| `CREATE OR REPLACE FUNCTION` (cutover) | none for readers; in-flight calls finish on the old body | — |

## 4. Behaviour changes and deviations from the design (all tested)

1. **Trial price rows.** The final plan list gives the trial PHP 0 / USD 0, so `plan_prices` stores them (`amount_minor ≥ 0`). A trigger allows 0 **only** for the trial plan, and `create_pass_order` refuses the trial (`plan_not_purchasable`). The design had "no price row".
2. **Queue ordering key** = the pass's `max_players` snapshot (desc), then grant order. This is equivalent to tier for the four catalogue plans, and it also orders admin-created custom plans, which have no tier.
3. **Room capacity** = `least(games.max_players, current pass cap)` (refines D-8):
   - New rooms get the pass cap (Party 50, not the platform default 20).
   - Upgrades raise open lobbies.
   - A limit a host set below the old cap is kept.
   - An expiry-driven downgrade shrinks the room, and `start_game` then fails with `player_limit_exceeded` (D-9).
   - The **platform "default max players" now applies only to super admins' games**. The settings label should say so (Phase 3 UI).
4. **Cancelled legacy rows** show when access really stopped instead of the period's nominal end. This is the only M-4 difference: state and plan are unchanged, and no live row is affected (the live row is `active`).
5. **Admin "Activate" while a pass is running now queues** a second pass instead of restarting the period. It still lifts a suspension. The per-period game cap resets when the next pass becomes active (test updated).
6. **`set_plan` / `set_expiry` are kept** for manual and legacy passes. Paid passes are refused (`paid_pass_immutable`): "what was sold stays as sold".
7. **Live games survive expiry** (D-10). The per-round entitlement check was removed (test updated).
8. **Hard-deleting a host** (`delete from auth.users`) is refused while the ledger has their passes (FK `restrict`). Use deactivation.
9. **Lock-wait nuance.** Replans use the transaction start time. If two grants for one host overlap in time, the later one may re-lay the few milliseconds since the earlier commit. No paid time is lost and there is never an overlap (verified by the races).
10. **Not audited:** a queued or paused pass becoming active, because this happens by time alone. Pre-emption is audited (`pass_preempted`).
11. **Plans UI** still shows the deprecated `price_cents` ("Price (USD)"). PHP/USD price editing is Phase 3.

## 5. Compensating rollback

| Situation | Action | Data |
|---|---|---|
| Problem found after files 1–6, before 7 | **Nothing to undo functionally**: the app still reads `subscriptions`. Leave the objects in place and fix forward with a new migration | kept |
| Problem after the cutover (7) | In the SQL Editor, in one transaction: `begin;` + contents of `supabase/rollback/20261112000007_entitlement_cutover_revert.sql` + `commit;`, then redeploy the previous app build | ledger kept; current access projected into `subscriptions` |
| Re-cutover later | Re-run files 1–7 in order. Projected rows (`external_ref = 'ledger_projection:<pass>'`) are not converted again | — |
| Bad plan / price data | Forward-fix migration (`update … where code = …`, or deactivate the price row and insert a new one) | never delete referenced rows |
| Full teardown of the Game Pass objects | **Not provided as a script.** It drops tables holding audit and payment evidence, so it needs a separate review once checkout exists. Before the cutover with no orders, the objects are inert and can stay | — |

What the revert does, in order:
1. Drops the freeze trigger.
2. Projects every host with a running pass into one live `subscriptions` row covering `[now, end of contiguous access)`, keeping the suspension.
3. Cancels legacy rows that no longer correspond to access.
4. Restores `entitlement_for`, `access_state_for`, `enforce_game_insert`, `enforce_player_insert`, `public_room_info`, `game_transition` and `admin_set_subscription` verbatim from migrations 6/8/9/11.
5. Makes `sync_lobby_capacity` a no-op.

While reverted, queue order collapses to "access until X on the current plan"; the ledger keeps the full history. Changes admins make to projected rows during that window are not carried back on re-cutover.

## 6. Open items before applying to the hosted project
- Run the preflight. This closes the audit's unverified items: migration 12, `btree_gist`, indexes/triggers, migration history.
- Confirm the backup / PITR options for the project's plan.
- `npm run db:types` can't run here (no CLI link). `database.types.ts` is hand-maintained; regenerate after applying and diff.

## 7. Phase 3 addendum: automatic free trial (2026-11-11)

Executed locally:
- `npm test` **266/266**: +9 auto-trial SQL tests and +2 formatter unit tests.
- `test:concurrency` **20/20 ×2**: the confirmation racing 10 activation requests leaves exactly one trial and one segment; auto-trial racing a purchase leaves the paid pass active and the trial absent or forfeited.
- tsc, lint and build pass.
- Dashboard card states checked in Chromium at 390 px and 1280 px with mock data: no overflow, no console errors.

**Not executed on the hosted project.**

| Requirement | Evidence |
|---|---|
| New eligible host receives one trial | unconfirmed signup has nothing; confirming grants 1 trial: 3 players, exactly 604 800 s, audited `trial_started` by `system`. An auto-confirmed insert also grants it |
| Repeated initialization / logout-login / refresh / password reset / browser change / profile update | `ensure_my_trial` ×3, a profile update, an `auth.users` metadata update, and un-confirm + re-confirm all leave the same single trial with the same start and end |
| Concurrent activation | real PG: confirmation + 10 simultaneous `ensure_my_trial` → 1 trial, 0 errors |
| Existing paid / manual users retain access, no trial | `has_pass_history` / `has_paid_history`; access state unchanged before vs. after |
| Existing trial users never get another | `trial_already_used` after use and after expiry (unique index as last guard) |
| Exactly seven days; no job needed | active at 7 d − 60 s and expired at 7 d, with the pass row untouched (expiry is computed from timestamps). Game creation is refused afterwards and the summary flags `trialEndedNoPass` |
| Client cannot set dates | `ensure_my_trial` takes no arguments; `ensure_trial_for` is service-role only; no client write grants on the ledger |
| Activation can't break sign-up | with the trial plan disabled, confirmation still succeeds; the next `ensure_my_trial` grants the trial |

Deviations: D-3 (explicit claim) and the admin-grant exception in D-4 are superseded (see GAME_PASS_DESIGN.md §12). The "Buy" buttons on the Game Pass page are disabled until checkout exists.

## 8. Phase 4 addendum: migration 20261112000009 (Polar price mapping)

Additive and re-runnable; no existing rows are affected (there are no orders yet). Executed locally only: `tests/db/polar-mapping.test.ts` **14/14** (snapshot, verified checkout, mismatches cancel, checkout reuse, immutable snapshot, server-only, webhook environment/product/currency/amount checks). Full suite **295/295**. Apply it after file 8, using the same runbook (§3). **Not executed on the hosted project.**

## 9. Phase 5 addendum: migration 20261112000010 (checkout flow)

Additive and re-runnable. Executed locally only:
- `tests/db/checkout-flow.test.ts` **10/10**: in-flight and verified reuse, expiring links not reused, suspended accounts, bad URL, server-only, abandoned, failed, return without webhook, cross-account, and paid-only grant.
- Real-PG race: 10 simultaneous starts give **1 order**.
- Full suite **319/319**, concurrency **21/21**.

**Not executed on the hosted project.**

## 10. Phase 6 addendum: migration 20261112000011 (webhook fulfilment)

Re-runnable. It replaces `apply_payment_event` with six marked edits. Executed locally only (`PAYMENT_VERIFICATION.md`): full suite **351/351**, concurrency **23/23**. **Not executed on the hosted project.**

## 11. Phase 7 addendum: migration 20261112000012 (capacity enforcement)

Re-runnable; it replaces `enforce_player_update` (adds the un-remove capacity check). Executed locally only:
- `tests/db/entitlements.test.ts` **15/15**.
- **Mutation check:** without migration 12 the un-remove test fails (a 4th player is admitted to a 3-player room).
- Real-PG races **25/25**.
- Full suite **366/366**.

**Not executed on the hosted project.**

## 12. Phase 8 addendum: migration 20261112000013 (admin, history, revenue)

Additive and re-runnable; no entitlement or payment behaviour changes. Executed locally only: `tests/db/admin-game-pass.test.ts` **10/10**, full suite **388/388**. **Not executed on the hosted project.**

## 13. Migration 20261112000014 (admin plan → Polar sync)

Additive and re-runnable; new tables and functions only. Executed locally only: `tests/db/plan-sync.test.ts` **16/16** (+ two mutation checks killed), full suite **424/424**. **Not applied to the hosted project** (it has migrations through 13).
