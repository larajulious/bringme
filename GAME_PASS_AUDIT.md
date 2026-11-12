# BringMe! — 7-Day Game Pass Audit (Phase 0)

_Audit date: 2026-11-11 · Read-only: no application code, migrations, rows or Polar products were changed._

**Evidence labels used throughout**

| Label | Meaning |
|---|---|
| **[V-code]** | Verified by reading the repository |
| **[V-live]** | Verified against the hosted Supabase project (read-only PostgREST: OpenAPI document, `HEAD` row counts, `GET` of non-personal columns) |
| **[V-test]** | Verified by running a local command (tsc / lint / PGlite test suite) |
| **[Inferred]** | Strongly implied by evidence, not directly observed |
| **[Unverified]** | Could not be checked with the available access; needs a catalog query (see §10) |

**Access limits.** No Supabase CLI, `psql`, or DB connection string is available, so the audit could **not** read `pg_policies`, `pg_trigger`, `pg_index`, function bodies, or `supabase_migrations.schema_migrations`. Everything in the live DB that PostgREST doesn't expose is marked [Unverified].

---

## 1. Existing architecture

| Item | Value | Source |
|---|---|---|
| Next.js | **16.4.6** (`"latest"` in package.json, unpinned) | [V-code] node_modules |
| React / React DOM | **19.3.1** | [V-code] |
| @supabase/supabase-js | **2.119.0** (`"latest"`) | [V-code] |
| @supabase/ssr | **0.12.7** (`"latest"`) | [V-code] |
| TypeScript | 5.9.3 | [V-code] |
| Polar SDK (`@polar-sh/sdk`, `@polar-sh/nextjs`) | **not installed** | [V-code] |
| Webhook verifier (`standardwebhooks`) | **not installed** | [V-code] |

- **Auth.** `proxy.ts` → `lib/supabase/proxy.ts` refreshes the session (coarse redirects only). Server checks live in [lib/auth/session.ts](lib/auth/session.ts) (pages) and [lib/auth/guards.ts](lib/auth/guards.ts) (API: `requireUser`, `requireRole`, `requireSuperAdmin`, `requireActiveSubscription`). The role is always read from `profiles.role`, never from JWT metadata. [V-code]
- **Entitlement.** A single SQL source, `entitlement_for(user)`, is used by `my_entitlement()`, `access_state_for()`, every game/round trigger and `game_transition`. It is time-based (`status in (trialing, active)` **and** `now()` inside `current_period_start..end`). [V-code]
- **Supabase clients.** [lib/supabase/server.ts](lib/supabase/server.ts) creates one client per request. [lib/supabase/admin.ts](lib/supabase/admin.ts) is the service-role client: it is `server-only`, created per call, and its key comes from `SUPABASE_SECRET_KEY`, never `NEXT_PUBLIC_*`. [V-code]
- **Payments.** None. A search for `polar|checkout|webhook|stripe` in `app/ lib/ components/ tests/` finds nothing. [docs/SECURITY.md](docs/SECURITY.md) says "Billing integration is out of scope". [V-code]

### Subscription touch-points (all files)

| Area | Files |
|---|---|
| Guards / session | `lib/auth/guards.ts` (`requireActiveSubscription` → 402), `lib/auth/session.ts` (`getMyAccessStatus`, `getMyEntitlement`) |
| Game Master UI | `app/dashboard/layout.tsx`, `app/dashboard/page.tsx`, `app/dashboard/subscription/page.tsx`, `app/dashboard/games/new/page.tsx`, `app/dashboard/games/[id]/page.tsx`, `components/subscription/{access-badge,restricted}.tsx`, `components/game/{game-builder,game-list,host-console,lobby-view}.tsx` |
| Admin UI | `app/admin/(console)/{layout,plans/page,subscribers/page,subscribers/[id]/page}.tsx`, `components/admin/{plan-editor,subscriber-actions,settings-form}.tsx`, `lib/admin/{client,queries,validation}.ts` |
| API | `app/api/admin/plans/route.ts`, `app/api/admin/plans/[id]/route.ts`, `app/api/admin/users/[id]/subscription/route.ts`, `app/api/admin/users/[id]/account/route.ts`, `app/api/host/games/route.ts`, `app/api/host/games/[id]/transition/route.ts` |
| Errors / types | `lib/host/errors.ts` (`subscription_required`, limits), `lib/supabase/database.types.ts` (hand-written) |

### Game creation, hosting, joining, capacity

| Step | Enforcement | Source |
|---|---|---|
| Create | `POST /api/host/games` → `requireActiveSubscription` → `parseGameInput(maxRounds = plan)` → `create_game_with_rounds` (SECURITY DEFINER; owner = `auth.uid()`) → `enforce_game_insert` trigger (entitlement, `max_active_games`, `max_games_per_period`, `max_players := least(max_players, plan cap)`) | [V-code] |
| Open lobby / go live | `enforce_game_update` requires entitlement for `lobby`/`live` | [V-code] |
| **Each round** | `game_transition('start_countdown')` re-checks entitlement ([migration 11:380-386](supabase/migrations/20261111000011_review_winners.sql#L380-L386)) | [V-code] |
| Join | `POST /api/play/join` → service role `join_game` → `enforce_player_insert` (row lock, lobby only, `count < games.max_players`) | [V-code] |
| Capacity source | **`games.max_players`, fixed at creation**: default `default_max_players()` = platform setting (**20** live), then capped by the plan | [V-code] [V-live] |

---

## 2. Live schema inventory (hosted project `rjjnwy…`)

**Row counts** [V-live]: profiles 2 (1 super_admin, 1 subscriber) · subscription_plans 3 · subscriptions 1 · games 2 (1 finished, 1 lobby) · game_rounds 10 · players 1 · submissions 0 · submission_intents 0 · platform_settings 1.

**Tables and columns** [V-live]. Legacy columns are in *italics*; a trailing `!` means NOT NULL.

| Table | New-schema columns present | Legacy columns still present |
|---|---|---|
| profiles | id!, email, display_name, role (enum user_role)!, created_at!, updated_at!, deactivated_at | — |
| subscription_plans | id!, code!, name!, description, price_cents! (0), currency! ('usd'), max_active_games!, max_players_per_game!, max_rounds_per_game!, max_games_per_period, is_active!, created_at!, updated_at! | *price numeric! (default 0)*, *max_players int! (default 50)*, *max_games int! (default 10)* |
| subscriptions | id!, user_id!, plan_id!, status (enum)!, current_period_start!, current_period_end!, cancel_at_period_end!, external_ref, created_at!, updated_at! | *starts_at*, *expires_at* |
| games | id!, owner_id!, title!, join_code! (default `generate_join_code()`), status (enum)!, max_players!, started_at, finished_at, created_at!, updated_at!, phase!, state_version!, current_round_id, countdown_ends_at, phase_changed_at!, archived_at | *room_code*, *current_round int! (default 0)*, *ended_at* |
| game_rounds | id!, game_id!, round_no!, prompt!, time_limit_seconds!, points!, status (enum)!, opened_at, closed_at, created_at!, updated_at!, winner_player_id, winner_submission_id, winner_rank_ms, winner_confirmed_at | *round_number*, *item_name*, *started_at* |
| players | id!, game_id!, nickname!, token_hash!, joined_at!, last_seen_at!, kicked_at | *display_name*, *session_token_hash* |
| submissions | id!, game_id!, round_id!, player_id!, storage_path (nullable), status!, points_awarded!, submitted_at!, reviewed_at, attempt_id, intent_at, claimed/server/received_elapsed_ms, rank_ms, timing_status, timing_flags!, client_meta | *photo_path*, *capture_elapsed_ms*, *server_received_at! (default now())*, *created_at!* |
| platform_settings | id, default_max_players **20**, max_photo_size_mb **2**, photo_retention_days **7**, support_email | — |
| submission_intents | full migration-10 shape | — |

**RPCs exposed (34)** [V-live]: every function defined by the compat migration and migrations 1–11, including the markers `is_super_admin`, `my_access_status`, `admin_overview`, `create_game_with_rounds`, `join_game`, `game_transition`, `begin_submission`, `review_submission`, `game_results`, `player_winner_photo`. `player_lobby_state` is absent, as expected (migration 9 drops it). **Extra: `rls_auto_enable`** is not defined by any migration. It is probably Supabase's built-in "auto-enable RLS" event-trigger helper. [Inferred]

**Grants** [V-live]: the publishable (anon) key gets `42501 permission denied` on `games` and `subscriptions` and can read `subscription_plans`. That matches migration 2.

**Existing subscription / payment rows** [V-live]
- Plans: `starter` (10 players, 1 open game, 5 rounds), `party` (50 / 3 / 15), `pro` (**200** / 10 / 40). All have `price_cents = 0`, currency `usd`, no period cap, and are active. Created 2026-11-11 08:04 UTC by migration 1's seed. The legacy columns hold their defaults (price 0, max_players 50, max_games 10).
- Subscriptions: **1 row**, status `active`, plan `starter`, period 2026-11-11 08:26 → **2026-12-11** (30 days), `external_ref = null`. `starts_at`/`expires_at` equal the `current_period_*` values exactly. Since `admin_set_subscription` never writes those columns, the row was probably inserted manually or by legacy code. [Inferred]
- Payment / order rows: **none**. No orders, products, or webhook tables exist.

**[Unverified] on live:** primary/foreign keys, unique/partial indexes (notably `subscriptions_one_live_per_user`), triggers (incl. `on_auth_user_created` and any legacy triggers), RLS policies, function bodies, storage policy, `schema_migrations` contents.

---

## 3. Migration-by-migration findings

How the earlier failures happened [V-code + Inferred]: the hosted project already had an older BringMe! schema. Migration 1's `CREATE TABLE IF NOT EXISTS` kept those old tables, so every later reference to a new-only column raised 42703:

| Prior error | Raised by | Why | Live status |
|---|---|---|---|
| `players.nickname` | m1 `create unique index players_nickname_per_game … lower(nickname)` (and m6/m8 functions) | legacy `players` had `display_name` | **Resolved**: column present, NOT NULL [V-live] |
| `subscription_plans.code` | m1 seed `insert … on conflict (code)`; m2 `entitlement_for` (`p.code`) | legacy plans had no `code` | **Resolved** [V-live] |
| `subscription_plans.max_active_games` | m2 `entitlement_for` (SQL function bodies are checked when created) | legacy had `max_games` | **Resolved** [V-live] |
| `subscriptions.current_period_end` | m2 `entitlement_for`; README step 3 manual insert | legacy had `starts_at/expires_at` | **Resolved** [V-live] |

Each file was run as a separate SQL Editor execution, so a failing file rolled back on its own while earlier files stayed committed. Supabase sends a multi-statement script as one implicit transaction. [Inferred]

| Migration | What it does | Applied on live? | Notes / conflicts |
|---|---|---|---|
| `20261110000000_legacy_schema_compat` | Adds new columns, backfills them, converts enums, adds unique keys, relaxes legacy NOT NULLs, drops legacy policies | **Yes**: new columns, enums and backfills present [V-live] | Legacy columns kept by design. Live legacy columns **not modelled** in `tests/db/legacy-compat.test.ts`: `players.session_token_hash`, `submissions.photo_path/capture_elapsed_ms/server_received_at`, `games.current_round/ended_at`, `game_rounds.started_at`. They are harmless because they're nullable or have defaults |
| `…0001_core_schema` | Enums, tables, indexes, profile trigger, plan seed | **Yes**: seed rows dated 08:04 UTC [V-live] | Seed `pro` = 200 players (new model: 100). `currency` is a single column, so there's no PHP/USD pair |
| `…0002_security_rls` | Helpers, triggers, grants, RLS | **Yes**: anon denied, RPCs exist [V-live]; policies [Unverified] | Comment says "subscriptions writes: service role only (billing)", which fits webhooks |
| `…0003_storage` | Private bucket + read policy | [Unverified] (storage not exposed) | — |
| `…0004_suspended_enum` | `suspended` value | [Inferred yes] (m5/m6 functions exist and compile against it) | Must stay its own transaction |
| `…0005_access_status` | access states, first admin RPCs | **Yes** (`my_access_status`) [V-live] | Superseded by m6 |
| `…0006_admin_dashboard` | period cap, deactivation, platform_settings, admin RPCs, **`games.max_players` default = platform default** | **Yes** (`platform_settings`, `admin_set_subscription(p_expires)`) [V-live] | ⚠ OpenAPI reports **no default** on `games.max_players`, although line 47 sets one [Unverified: catalog check needed]. `admin_set_subscription` limits days to 1–366 and has no source/order link |
| `…0007_game_creation` | `create_game_with_rounds` (invoker) | Yes (replaced by m9) [V-live] | — |
| `…0008_guest_join` | `public_room_info`, `join_game`, `player_lobby_state` | Yes (m9 later drops `player_lobby_state`) [V-live] | — |
| `…0009_game_engine` | phase/version, `game_transition`, Realtime | **Yes** (`phase`, `state_version`, `game_transition`) [V-live] | Briefly disables `enforce_game_update` for its backfill (owner privilege required) |
| `…0010_submissions_timing` | intents, begin/complete, ranking | **Yes** (`submission_intents`, `begin_submission`) [V-live] | — |
| `…0011_review_winners` | review, winners, archive; **final `game_transition`** | **Yes** (`archived_at`, `review_submission`, `winner_confirmed_at`) [V-live] | Contains the **per-round entitlement check** that conflicts with fixed-length passes (§4) |
| `…0012_production_hardening` | drop host DELETE policies, revoke DELETE | **[Unverified]**: a policy drop can't be seen via PostgREST | Must be confirmed. If it's missing, hosts can delete games and reset the per-period cap |

**Migration history.** The README says the files were run in the **SQL Editor**, so `supabase_migrations.schema_migrations` is probably empty [Inferred; Unverified]. A future `supabase db push` would then try to replay **every** file. They are written to be re-runnable, but the history must be repaired (`supabase migration repair --status applied …`) before using the CLI.

**PROJECT_STATUS.md was stale.** It said "migrations NOT yet applied", but the live DB has compat + 1–11 applied and has been used for real test games (08:26–08:39 UTC today).

---

## 4. Code / schema mismatch matrix (current vs. 7-Day Game Pass model)

| # | Requirement | Current state | Gap | Evidence |
|---|---|---|---|---|
| M1 | Free Trial plan, 3 players, 0, 7 days | No trial plan; `trialing` enum value exists but is unused | New plan row + "once per account" rule | [V-live] |
| M2 | Starter 10 / Party 50 / **Pro 100** | starter 10, party 50, **pro 200** | Update the Pro cap (data change, not schema) | [V-live] |
| M3 | Separate **PHP and USD** prices | One `price_cents` + one `currency` ('usd'); admin UI says "Price (USD)" and shows `$` | New per-currency price storage | [V-code] [V-live] |
| M4 | Fixed **7-day** duration | Admin picks 1–366 days (UI default **30**); live sub is 30 days | Duration column on plan; checkout grants exactly 7 days | [V-code] `subscriber-actions.tsx:39` |
| M5 | **One-time** purchases | "Subscription" vocabulary everywhere; `cancel_at_period_end`, `past_due`, "Renews / ends" copy | Copy/semantics change; the table can be reused as the *pass* ledger | [V-code] |
| M6 | Player limit = the pass's limit | `games.max_players = least(platform default 20, plan cap)` → **Party/Pro hosts get 20** | Create games with the plan's cap (or a defined rule) | [V-code] m6:47, m6:150; [V-live] default 20 |
| M7 | A pass bought mid-week should not kill a running game | `start_countdown` re-checks entitlement **every round**, so a game in progress stops when the pass ends | Decide the policy: e.g. a game started while entitled may finish | [V-code] m11:380-386 |
| M8 | Buying again / upgrading | Unique partial index `subscriptions_one_live_per_user` (m1:94) allows only **one live row**; `admin_set_subscription('activate')` **overwrites** the live row (plan + period), losing history | Define stack / extend / upgrade rules; keep one row per purchase | [V-code]; live index [Unverified] |
| M9 | Per-pass limits besides players | Plans also carry `max_active_games`, `max_rounds_per_game`, `max_games_per_period` (not in the new spec) | Decide: keep as internal limits or retire | [V-code] |
| M10 | Payment-backed activation | `external_ref text unique` reserved, no order/webhook tables | Orders + webhook events + product mapping tables | [V-code] [V-live] |
| M11 | Plan code check | `code ~ '^[a-z0-9_-]{2,40}$'`: `free-trial`/`trial` are fine; `max_players_per_game between 2 and 500`: 3 is fine | none | [V-code] |
| M12 | Legacy plan columns | `price numeric!`, `max_players!`, `max_games!` have defaults, so inserts still succeed; values are misleading | Leave (non-destructive) or drop in a later cleanup phase | [V-live] |
| M13 | Typed DB | `database.types.ts` is hand-written and has no legacy columns (intended) | Extend by hand for new tables | [V-code] |

---

## 5. Existing payment integration status

| Capability | Status |
|---|---|
| Polar SDK / adapter | **Not installed** [V-code] |
| Checkout route / server action | **None** [V-code] |
| Product ↔ plan mapping | **None** (no table, env vars or constants) [V-code] [V-live] |
| Webhook route + signature verification | **None** [V-code] |
| Order / payment storage, idempotency | **None** [V-code] [V-live] |
| Activation on payment | **None**: activation is manual only, via `admin_set_subscription` [V-code] |
| Env vars for Polar | **None** in `.env.example` / `.env.local` (names checked, values not read) [V-code] |
| Polar dashboard products | **Not inspected** (no access; not changed) |
| PHP pricing in Polar | Polar's product docs list **PHP among supported currencies** [V-web]. Whether **one product can carry a fixed PHP price and a separate USD price**, or needs one product per currency, is **[Unverified]**. Polar's own design notes describe multi-currency as work in progress |

Conclusion: Polar is **not connected at all**. The work is greenfield, but it can reuse the service-role path and the time-based entitlement.

---

## 6. Security findings

| # | Severity | Finding | Evidence |
|---|---|---|---|
| S1 | ✅ | Service-role client is `server-only`, created per call, keyed from a non-public env var. Imported only from route handlers and `server-only` lib modules; no `"use client"` file imports it | [V-code] |
| S2 | ✅ | Roles come from `profiles.role`; a trigger blocks role changes except by trusted DB roles; signup never trusts metadata for the role | [V-code] |
| S3 | ✅ | Entitlement is enforced in the DB (triggers + `game_transition`), not only in the UI. Clients can't write `subscriptions` (no grants; test "clients cannot grant themselves a subscription") | [V-code] [V-test] |
| S4 | ✅ | Anon can't read games/subscriptions on live | [V-live] |
| S5 | ⚠ High (if missing) | Migration 12 (no host DELETE) not confirmed on live | [Unverified] |
| S6 | ⚠ Medium | `next`, `@supabase/*` pinned to `"latest"`. A payment SDK must be pinned exactly | [V-code] |
| S7 | ⚠ Medium | `lib/auth/profile.ts` still has **temporary** diagnostic logging (user id + error) | [V-code] |
| S8 | ⚠ Design | Future webhook handler must: verify the Standard-Webhooks signature on the **raw body**, be exempt from the proxy's auth redirect (`/api/*` currently returns 401 to unauthenticated callers), be idempotent on the Polar event/order id, and never trust client-supplied plan, price or currency | [V-code] `lib/supabase/proxy.ts` |
| S9 | ⚠ Design | `Permissions-Policy: payment=()` and `frame-ancestors 'none'` in [next.config.ts:15](next.config.ts#L15) block an **embedded** checkout. A redirect to Polar's hosted checkout is unaffected | [V-code] |
| S10 | ⚠ Abuse | A free trial with email signup can be farmed with multiple accounts. Only "one trial per account" is enforceable today | [Inferred] |
| S11 | ℹ | `.env.local` is untracked, and the repo sits inside a parent git repo with no commits. Make sure `.env*` stays ignored when the repo is split out | [V-code] |

---

## 7. Code safe to reuse

- `entitlement_for` / `my_entitlement` / `access_state_for`: time-based, single source of truth. Keep the signatures and change only the internals.
- Trigger enforcement in `enforce_game_insert` / `enforce_game_update` / `enforce_player_insert` (row-locked capacity check).
- `requireActiveSubscription`, `requireSuperAdmin`, `HttpError`/`handle`/`readJson` (`lib/api/http.ts`), `toHttpError`.
- `createAdminClient()` for webhook writes; `subscriptions` as the pass ledger (`external_ref` already unique).
- Admin console shell, `PlanEditor` form pattern, `SubscriberActions` (manual grant stays useful for support/comps), `AccessBadge`, `SubscriptionRestricted`.
- PGlite test harness (`tests/db/harness.ts`), which applies every migration in order. New migrations are covered automatically.

## 8. Code needing modification (later phases, not now)

| File / object | Change |
|---|---|
| New migration (plans) | Add `duration_days`, per-currency prices (e.g. `price_php_minor`, `price_usd_minor` or a `plan_prices` table), `is_trial`; upsert the 4 plans; Pro → 100 |
| New migration (passes) | Add `source` (`admin`/`polar`/`trial`), link to an order; replace "overwrite live row" with insert-per-purchase; revisit `subscriptions_one_live_per_user` |
| New migration (payments) | `payment_orders` (unique Polar order id, plan, currency, amount, status), `payment_webhook_events` (unique event id, for dedupe), `polar_products` (plan × currency → product id). RLS on, service-role only |
| `enforce_game_insert` / `default_max_players` | Game capacity = pass cap (fix M6) |
| `game_transition` (start_countdown) | Policy for passes that end mid-game (M7) |
| `admin_set_subscription` + `parseSubscriptionAction` + `SubscriberActions` | Default 7 days; grant creates a new pass row; keep admin comps |
| `app/admin/(console)/plans/page.tsx`, `components/admin/plan-editor.tsx`, `lib/admin/validation.ts` | PHP + USD fields, duration, trial flag; drop "no payments" copy |
| `app/dashboard/subscription/page.tsx`, `components/subscription/*`, dashboard copy | "Game Pass" wording, expiry countdown, buy/upgrade CTA |
| New: `app/api/billing/checkout/route.ts`, `app/api/webhooks/polar/route.ts`, `lib/billing/*` | Checkout + verified webhook; proxy allow-list for the webhook path |
| `lib/supabase/database.types.ts` | Hand-add new tables/columns |
| `supabase/README.md` | Step 3 example uses `party` + 30 days; update for passes |

---

## 9. Proposed non-destructive migration approach

1. **Verify first** (read-only, SQL Editor): run the queries in §10 and record the results. Confirm migration 12, the `games.max_players` default, indexes and triggers.
2. **Repair history** if `schema_migrations` is empty: `supabase migration repair --status applied 20261110000000 … 20261111000012`. Only do this **after** confirming each file's objects exist.
3. **Additive only**: new timestamped files (`20261112…`). Never edit applied files. `ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION` with unchanged signatures, upserts keyed on `code`.
4. **Plans as data**: upsert `free_trial`, `starter`, `party`, `pro` with the new limits and both prices. Don't delete old rows. Deactivate anything obsolete (`is_active = false`).
5. **Keep the live subscriber's row valid**: the existing 30-day `starter` row runs to 2026-12-11. Either honour it or have an admin shorten it, but don't rewrite it inside a migration.
6. **Legacy columns**: leave them. Optionally drop them in a separate, explicitly approved cleanup phase after a backup.
7. **One concern per file**, each wrapped in `begin; … commit;`. Any enum `ADD VALUE` gets its own file (same as migration 4).
8. **Test** with the PGlite suite plus a legacy-compat case that includes the extra live legacy columns from §3. Then dry-run, back up, and apply.

---

## 10. Risks, blockers and the verification queries

### Blockers
| # | Blocker |
|---|---|
| B1 | **Polar PHP + USD**: confirm in the Polar dashboard whether one product can hold a fixed PHP *and* USD price or whether we need 2 products per plan (8 total). Also confirm PHP payouts and payment methods for PH buyers |
| B2 | **Policy decisions** (questions below) affect the schema |
| B3 | **Catalog access**: a DB connection string (or running the queries below in the SQL Editor) is needed to close the [Unverified] items |

### Risks
- R1: `db push` with an empty history replays all files on a used database.
- R2: Party/Pro hosts silently capped at 20 players (M6), a likely support issue at launch.
- R3: A pass expiring mid-game blocks the next round (M7).
- R4: Overwriting the live row on re-purchase loses purchase history and complicates refunds (M8).
- R5: Webhook retries or replays could double-grant without event-id idempotency.
- R6: Unpinned `next`/`@supabase/*` could shift during payment work.

### Read-only queries to run (SQL Editor)
```sql
-- migration history
select version, name from supabase_migrations.schema_migrations order by 1;
-- m12 applied? (expect no games_delete_own / rounds_delete_own, and no DELETE grant)
select policyname from pg_policies where tablename in ('games','game_rounds') and cmd = 'DELETE';
select has_table_privilege('authenticated','public.games','DELETE');
-- games.max_players default (expect public.default_max_players())
select column_default from information_schema.columns where table_name='games' and column_name='max_players';
-- one-live-subscription index and triggers
select indexname, indexdef from pg_indexes where tablename='subscriptions';
select event_object_table, trigger_name from information_schema.triggers where event_object_schema in ('public','auth') order by 1,2;
-- unexpected function
select pg_get_functiondef('public.rls_auto_enable'::regproc);
```
The full read-only inspector is in [supabase/inspect/schema_inspection.sql](supabase/inspect/schema_inspection.sql).

---

## Validation run (2026-11-11)
| Command | Result |
|---|---|
| `npx tsc --noEmit` | ✅ pass |
| `npm run lint` | ✅ clean |
| `npm test` (PGlite, all migrations applied in memory) | ✅ 210/210 |
| `npm run build` | not run (it writes `.next/`; nothing in the code changed) |
| Live probes | 1 OpenAPI `GET`, 9 `HEAD` counts, 6 `GET`s of non-personal columns, 3 anon-permission `GET`s. No writes, no RPC calls |

## Unresolved questions
1. **Stacking:** if a host buys a pass while one is active, should it extend the end date, upgrade the cap immediately, or queue after expiry?
2. **Mid-game expiry:** may a game started while the pass was valid finish after it ends?
3. **Trial eligibility:** once per account? Should a trial be granted automatically at signup or claimed by the host?
4. **Other limits:** keep `max_active_games` / `max_rounds_per_game` / `max_games_per_period` per tier? What values?
5. **Currency selection:** by the buyer's choice, by country/IP, or by Polar's checkout?
6. **Existing 30-day Starter row:** honour it to 2026-12-11, or convert it?
7. **Admin comps:** keep manual grants (fixed at 7 days, or free-form)?
8. **Refunds:** should a Polar refund revoke the pass immediately?
