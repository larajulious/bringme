# BringMe! Production Migration Reconciliation

_2026-11-13. Project `rjjnwyxbiyccrilkaglx` (production, Postgres 17.11, ap-south-1)._

**This investigation was read-only.** Every query against production ran through `npx supabase db query --remote --read-only`: a read-only transaction (`transaction_read_only = on`) as the CLI's `supabase_read_only_user` role. Nothing was written, repaired, pushed, reset or deployed. I made no Git commits.

---

## A. Executive Summary

**Why the CLI says 44 pending.** Production has no `supabase_migrations.schema_migrations` table, so the CLI has no record of anything. The migrations were evidently run by hand (SQL Editor), which records nothing. `supabase migration list --remote` therefore shows 44 local versions and 0 remote ones.

**What production actually contains.** I compared production with the schema the repository's migrations build. The comparison used a catalog fingerprint that covers:

- every function's exact body hash, signature, security mode, `search_path` and grants;
- columns, constraints, indexes, RLS policies (including `storage.objects` and `realtime.messages`), triggers (including `auth.users`), enums, table grants and column grants;
- seed and config facts.

Findings:

- **42 of 44 migrations are in production.** 139 of 140 public functions are **byte-identical** to the repository's latest definitions. All 25 tables, 39 policies, 40 triggers, 13 enums, table grants and 57 column grants match exactly, and the seeds match.
- **Two migrations are not applied:**
  - `20261112000012_capacity_enforcement`: production still runs the original `enforce_player_update()` from `20261111000002` (identical body hash). The capacity check for restoring a removed player is therefore missing.
  - `20261113000002_realtime_audience` (Phase 2): none of its objects exist.
- **Phase 1 (`20261113000001`) is fully installed.** Both functions are byte-identical, with identical attributes and grants.
- **Production was upgraded from an older, pre-repository schema** through `20261110000000_legacy_schema_compat`. That leaves expected legacy drift: extra legacy columns, and about 20 CHECK/FK details that the repository's `CREATE TABLE IF NOT EXISTS` never applied to the existing tables. Uniqueness is still enforced (all keys exist as unique indexes), and **no existing row violates any missing rule**. Re-running migrations cannot fix this drift; only a new forward migration can.

**What's safe.** Recording 42 versions as applied is safe; re-running all 44 is not. Applying the two missing migrations was rehearsed locally on a database mirroring production's function state, and both apply cleanly. Hosted changes still need your approval, and two blockers remain (section H): **no restorable backup exists**, and **the deployed app version is unknown**.

---

## B. Migration Inventory

**Method.** Production's fingerprint (`supabase/inspect/production_fingerprint.sql`) was compared with a local build of the repository's migrations (embedded Postgres, the repo's Supabase shim).

For functions, each definition in each migration was hashed and checked against production:

- **live:** production runs exactly this body;
- **superseded:** a later migration redefines or drops it.

A migration is **verified** when every function it defines is live or legitimately superseded, its tables, policies, triggers, indexes and grants are present as the final intended state requires (no missing ones in production), and its data effects are confirmed where it has any.

**Status values used:** **V** = verified applied and equivalent; **D** = applied, but drifted (legacy upgrade path; re-running it would change nothing); **N** = not applied.

| # | Migration | Status | Evidence |
|---|---|---|---|
| 1 | `20261110000000_legacy_schema_compat` | **V** | Legacy columns kept; its named `NOT VALID` constraints exist (`submissions_round_game_fkey`, `submissions_player_game_fkey`, `submissions_storage_path_check`); its unique indexes exist; enum conversions done; legacy policies gone (policy set equals intended) |
| 2 | `20261111000001_core_schema` | **D** | 3/3 functions live; enums, indexes, `set_updated_at`/`on_auth_user_created` triggers and plan seed present. Tables pre-existed, so the inline CHECK, cascade and default definitions are missing (section C). Re-running is a no-op |
| 3 | `20261111000002_security_rls` | **V** | 15 functions (7 live, 8 superseded); its original `enforce_player_update` is the live one (see #25); 23 policies, grants and 9 triggers match |
| 4 | `20261111000003_storage` | **V** | Bucket `submissions` private, JPEG/PNG/WebP; read policy identical; size limit 2 MB = `platform_settings.max_photo_size_mb = 2` (an admin setting, kept in sync by #7's trigger) |
| 5 | `20261111000004_subscription_suspended_enum` | **V** | Enum labels identical |
| 6 | `20261111000005_access_status` | **V** | 4 functions (1 live, 3 superseded) |
| 7 | `20261111000006_admin_dashboard` | **V** | 10 functions (6 live, 4 superseded); `platform_settings` (1 row), sync trigger, policy |
| 8 | `20261111000007_game_creation` | **V** | 1 function (superseded by #10) |
| 9 | `20261111000008_guest_join` | **V** | 3 functions (superseded) |
| 10 | `20261111000009_game_engine` | **V** | 13 functions (7 live, 6 superseded); Realtime policy identical; phase backfill effective (0 finished/cancelled games with another phase) |
| 11 | `20261111000010_submissions_timing` | **V** | 7 functions (2 live, 5 superseded); `submission_intents` present |
| 12 | `20261111000011_review_winners` | **D** (minor) | 11 functions (7 live, 4 superseded). `game_rounds.winner_submission_id` pre-existed with a legacy FK (`round_winner_submission_fk`, stricter, deferrable), so this file's `ADD COLUMN IF NOT EXISTS … REFERENCES` added nothing. No orphan rows |
| 13 | `20261111000012_production_hardening` | **V** | Policy and grant set equals intended (no host DELETE) |
| 14 | `20261112000001_game_pass_types` | **V** | Enums identical |
| 15 | `20261112000002_plan_catalogue` | **V** | Plans and prices present. Values differ from the seed because of **later admin edits** (audit log: 17 `plan_updated`, 6 `plan_price_changed`), not missing migration effects |
| 16 | `20261112000003_pass_ledger` | **V** | 4/4 functions live; tables, constraints, `btree_gist` present |
| 17 | `20261112000004_orders_webhooks` | **V** | 1/1 live; tables and policies present |
| 18 | `20261112000005_pass_functions` | **V** | 25 functions (22 live, 3 superseded) |
| 19 | `20261112000006_legacy_backfill` | **V** | 1 legacy subscription, 1 `legacy_subscription` pass, 0 subscriptions without a pass |
| 20 | `20261112000007_entitlement_cutover` | **V** | 10 functions (9 live, 1 superseded); `guard_legacy_subscriptions` trigger |
| 21 | `20261112000008_auto_trial` | **V** | 6/6 live; `on_auth_user_trial` trigger on `auth.users` present |
| 22 | `20261112000009_polar_price_mapping` | **V** | 5 functions (3 live, 2 superseded) |
| 23 | `20261112000010_checkout_flow` | **V** | 4 functions (3 live, 1 superseded) |
| 24 | `20261112000011_webhook_fulfilment` | **V** | 1/1 live |
| 25 | `20261112000012_capacity_enforcement` | **N** | Live `enforce_player_update()` body hash `8467d3bf…` = the **#3 version**. The #25 version (`1a964621…`, `SECURITY DEFINER`, execute revoked from PUBLIC/anon/authenticated) is absent |
| 26 | `20261112000013_game_pass_admin` | **V** | 8/8 live; audit table in use |
| 27 | `20261112000014_plan_polar_sync` | **V** | 5/5 live; tables present (sync history in the audit log) |
| 28 | `20261112000015_snappy_taps` | **V** (superseded) | Its tables and functions were intentionally dropped by #29; final state equals intended |
| 29 | `20261112000016_snappy_counter_simplify` | **V** | 2/2 live; `snappy_counter` has 1 row; legacy shard and limit tables absent |
| 30–34 | `20261112000017` … `021` (BingoSnap) | **V** | 4/4, 14 (11 live, 3 superseded), 4/4, 3/3, 2/2; tables, policies, triggers, indexes present; games of type `bingosnap` exist |
| 35 | `20261112000022_restart_countdown` | **V** | 1 function (superseded by #38) |
| 36 | `20261112000023_add_round_live` | **V** | 2 functions (1 live, 1 superseded) |
| 37 | `20261112000025_expire_stale_pending_orders` | **V** | 1 function (superseded by #39) |
| 38 | `20261112000026_replay_round` | **V** | 5 functions (4 live, 1 superseded) |
| 39 | `20261112000027_countdown_5s` | **V** | 2/2 live |
| 40 | `20261112000028_reuse_live_checkouts` | **V** | 1/1 live |
| 41 | `20261112000029_disposable_email_guard` | **V** | 7/7 live; 3 tables |
| 42 | `20261112000030_disposable_email_seed` | **V** | 10,181 domains, version source `ba992a0b…` active, 37 allowlist rows, identical to a fresh build |
| 43 | `20261113000001_submission_lock_order` (Phase 1) | **V** | Both functions byte-identical; `SECURITY DEFINER`, `search_path`, volatility and grants (`service_role` only) identical |
| 44 | `20261113000002_realtime_audience` (Phase 2) | **N** | `broadcast_game(…, text)`, `bump_game_version(uuid, text)` and `host_sync_keys` absent; the 9 functions it replaces still have their pre-Phase-2 bodies |

No migration is *partially* applied: in each one, every object is either present with the intended definition, or the whole migration is absent (#25, #44). The two **D** entries are complete as far as re-running them could ever take them.

---

## C. Schema Drift

The differences between production and a fresh build, through Phase 1:

| Area | Production vs. fresh build | Cause | Impact |
|---|---|---|---|
| Functions | `enforce_player_update()` is the old version | #25 not applied | **Capacity bypass**: restoring a removed player (`kicked_at → null`, host's own game, via REST) skips the room-capacity check. Low exposure, since the UI has no restore action |
| Functions | Extra `rls_auto_enable()` (event-trigger function, `search_path=pg_catalog`) | Created by Supabase (automatic RLS on new tables), not by this repo | None. It only acts on `CREATE TABLE`; Phase 2 creates no tables |
| Extensions | Extra `pgcrypto`, `pg_stat_statements` | Supabase defaults | None |
| Columns | 17 extra legacy columns (`games.room_code`, `current_round`, `ended_at`; `game_rounds.round_number`, `item_name`, `started_at`; `players.display_name`, `session_token_hash`; `submissions.photo_path`, `capture_elapsed_ms`, `server_received_at`, `created_at`; `subscription_plans.price`, `max_players`, `max_games`; `subscriptions.starts_at`, `expires_at`) | Pre-repo schema; #1 never drops columns | None for the app (made nullable by #1) |
| Columns | `games.title` default `'Bring Me Game'`; `submissions.storage_path` nullable | Legacy definitions kept | None today (0 null paths) |
| Constraints | **Missing:** CHECKs on `games` (join-code format, max players 2–500, title length), `game_rounds` (round_no ≥ 1, points, prompt length, time limit 10–600), `players` (nickname 1–24 trimmed, token-hash format), `profiles.display_name`, `submissions` (path format, points ≥ 0), `subscription_plans` (code, currency, limits, name, price); FK `game_rounds.winner_submission_id → submissions ON DELETE SET NULL` | Migration 1's inline definitions skipped on pre-existing tables | Defense-in-depth only: every write path validates in SQL functions. **0 rows violate any of them** (`production_drift_checks.sql`) |
| Constraints | Unique keys `games_join_code_key`, `players_token_hash_key`, `game_rounds_game_id_round_no_key`, `subscription_plans_code_key`, `subscriptions_external_ref_key` exist as **unique indexes**, not constraint objects | Created by #1's `uniq()` helper | None: uniqueness is enforced, and `ON CONFLICT (col)` works |
| Constraints | `games.owner_id` FK and `submissions (round_id, game_id)` / `(player_id, game_id)` FKs **without** `ON DELETE CASCADE`; the cascading twins exist as `NOT VALID` constraints; `subscriptions_check` is the legacy rule (`expires_at > starts_at`) | Legacy FKs kept under the same names; #1 adds `NOT VALID` cascading twins | Deleting a profile that owns games is blocked (no app path deletes profiles). Submission cascades work through the twins |
| Constraints / indexes | Extra legacy: `round_winner_submission_fk` (deferrable), `games_room_code_key`, legacy CHECKs on legacy columns, `submissions_game_id_fkey`, `submissions_id_round_id_key`; 6 extra legacy indexes | Pre-repo schema | Minor write overhead; none functionally |
| Data | Plan limits, active flags and prices differ from the seed; photo limit 2 MB | Admin edits (audited) | Intended |

**Everything else is identical**: tables, RLS enabled/forced flags, table grants, column grants, all 39 policies (including Storage and Realtime), all 40 triggers (including `auth.users`), all enums and the `btree_gist` extension.

**Fixing the drift** needs a **new, separate forward migration**: add the missing CHECKs, `VALIDATE` the three `NOT VALID` constraints, align the FK cascades, and optionally drop the legacy columns after a code audit. It is not part of this reconciliation. The data already satisfies every rule, so it should apply cleanly, but it needs its own review.

---

## D. Phase 1 Verification

**Fully installed.**

- `begin_submission` and `complete_submission` bodies are **byte-identical** to `20261113000001` (exact `prosrc` MD5).
- `SECURITY DEFINER`, `search_path = ''`, volatility and return type are identical.
- Execute privileges are `service_role` only, identical.
- Phase 1 contains nothing else (only these two functions and their grants), so the migration's entire effect is present.
- The Phase 2 precondition (`pg_get_functiondef(complete_submission) like '%p.game_id for no key update%'`) holds in production.

---

## E. Phase 2 Readiness

**The database is ready. The deployment needs two decisions** (backup, app order; section H).

- **Prerequisites present:** Phase 1 (above); `bingo_submit_claim(text, uuid[], uuid)` exists. Phase 2 does **not** depend on #25.
- **Exact starting point:** Phase 2's function bodies were generated from the latest repository definitions of `broadcast_game`, `bump_game_version`, `players_bump_version`, `can_listen_game_topic`, `game_state_json`, `complete_submission`, `review_submission`, `bingo_submit_claim` and `bingo_review_submission`. **All nine are byte-identical in production**, so what Phase 2 changes in production is exactly what was reviewed and tested.
- **Schema compatibility:** Phase 2 changes no tables or data. Its only SQL-language function bodies validated at creation (`host_sync_keys`, the delegating overloads) reference columns that exist in production with identical types.
- **Rehearsal** (local database whose function set equals production's exactly, then each migration in its own transaction, as `db push` would):

  | Sequence | Result |
  |---|---|
  | `20261112000012`, then `20261113000002` | Both OK (milliseconds). Functions, policies, triggers, table grants and column grants equal the full intended schema |
  | `20261113000002` alone | OK; the only remaining difference is `enforce_player_update` (#25) |

- **Realtime:** `can_listen_game_topic` keeps the guest branch for `game:<id>` unchanged and adds the owner-only `game:<id>:host`. Guest tokens (HS256, `kind=guest`, `game_id`) are unaffected. Existing channel subscriptions keep their authorization; new joins use the new function.
- **Existing game data:** untouched. Versions and snapshots are unchanged.
- **Deployed app:** **unknown** (no Vercel access). Phase 2 was designed for the app to go first: the Phase 2 client works on a pre-Phase-2 database, but host tabs from an older app miss host-only hints after the migration until reloaded (30 s safety re-read). See `BRINGME_PHASE2_REALTIME_OPTIMIZATION.md` J.
- **Phase 3:** app-only, no database dependency beyond objects verified present (`games.current_round_id`/`phase`, `round_ranking`, `game_rounds` winner columns, `player_winner_photo`, `platform_settings`). It works with or without Phase 2, but is intended to follow it. **It is still uncommitted in the working tree.**

---

## F. Migration-History Repair Plan

The goal is to make the CLI's history match reality, using only the supported `supabase migration repair`, which creates `supabase_migrations.schema_migrations` if needed and records versions. It changes no application objects.

**Record as applied (42 versions):** everything except `20261112000012` (not applied) and `20261113000002` (Phase 2, not applied).

The two **D** migrations (`20261111000001`, `20261111000011`) are included: their effects are present to the extent the files can ever produce, and re-running them would change nothing. **Recording them is a decision for you to make knowingly**, because the remaining drift (section C) must then be fixed by a new forward migration, not by these files.

> ⚠️ All of the following write to the hosted project. **Not executed; each needs your explicit approval.**

```bash
# 0. Backup first (read-only on production; files contain personal data: keep them OUTSIDE the repo)
mkdir -p ~/bringme-backups
npx supabase db dump --remote -f ~/bringme-backups/2026-11-13-schema.sql
npx supabase db dump --remote --data-only --use-copy -f ~/bringme-backups/2026-11-13-data.sql
npx supabase db dump --remote --role-only -f ~/bringme-backups/2026-11-13-roles.sql

# 1. Repair: record the 42 verified versions (writes only the migration-history table)
npx supabase migration repair --status applied --remote \
  20261110000000 20261111000001 20261111000002 20261111000003 20261111000004 20261111000005 20261111000006 \
  20261111000007 20261111000008 20261111000009 20261111000010 20261111000011 20261111000012 20261112000001 \
  20261112000002 20261112000003 20261112000004 20261112000005 20261112000006 20261112000007 20261112000008 \
  20261112000009 20261112000010 20261112000011 20261112000013 20261112000014 20261112000015 20261112000016 \
  20261112000017 20261112000018 20261112000019 20261112000020 20261112000021 20261112000022 20261112000023 \
  20261112000025 20261112000026 20261112000027 20261112000028 20261112000029 20261112000030 20261113000001

# 2. Verify (read-only): exactly two pending, in this order
npx supabase migration list --remote                       # 42 with a remote version; 20261112000012 and 20261113000002 without
npx supabase db push --remote --dry-run --include-all      # must list ONLY 20261112000012 and 20261113000002
```

- **Why `--include-all`:** `20261112000012` is older than the newest recorded version (`20261113000001`). Without the flag the CLI refuses to insert an older migration.
- **Never run plain `supabase db push`** before the repair. It would re-run all 44 files in order. That would temporarily re-install 50 superseded function bodies, recreate the dropped snappy tables (#28), re-run guarded data steps (#1, #10, #19), and could stop halfway on a precondition, leaving a mixed state.
- **If you choose not to apply #25 yet:** `db push` can't skip it. Either apply #25 too (recommended, section G), or apply Phase 2 alone by running its file with `npx supabase db query --remote -f supabase/migrations/20261113000002_realtime_audience.sql` (a write; it runs as one statement batch) and then `npx supabase migration repair --status applied 20261113000002 --remote`.

---

## G. Production Deployment Plan

**Order:**

1. **Backups** (F step 0). Production lists **no physical backups and PITR is off** (`supabase backups list`), so the dumps are the only recovery point. Also check Dashboard → Database → Backups for your plan's coverage.
2. **History repair** (F steps 1–2), after approval.
3. **App first.** Confirm in Vercel which commit production serves.
   - If it predates `2b085e1`: deploy `2b085e1` (Phase 2 client; correct on the unmigrated database, with hosts polling every 4 s), or Phase 3 once it's reviewed and committed.
   - Smoke-test one short game.
4. **Quiet window.** Confirm no game is live (read-only):
   ```bash
   npx supabase db query --remote --read-only "select status, phase, count(*), max(updated_at) from public.games where status in ('lobby','live') group by 1,2"
   ```
   Today there is **1 lobby game, last touched 2026-11-12 10:59 UTC** (looks abandoned).
5. **Apply both pending migrations** (approval required):
   ```bash
   npx supabase db push --remote --include-all     # applies 20261112000012, then 20261113000002, and records both
   ```
   Both only replace functions (no table locks, no data changes) and finish in milliseconds. Running game calls simply use the new definitions on their next call.
6. **Verify** (read-only):
   ```bash
   npx supabase migration list --remote                                    # 44 recorded
   npx supabase db query --remote --read-only "select
     to_regprocedure('public.broadcast_game(uuid,bigint,public.game_phase,text)') is not null as phase2_broadcast,
     to_regprocedure('public.host_sync_keys(uuid,text)') is not null as phase2_keys,
     (select prosecdef from pg_proc where oid = 'public.enforce_player_update()'::regprocedure) as m12_secdef,
     pg_get_functiondef('public.complete_submission(text,uuid,uuid,jsonb)'::regprocedure) like '%p.game_id for no key update%' as phase1_locks,
     pg_get_functiondef('public.complete_submission(text,uuid,uuid,jsonb)'::regprocedure) like '%bump_game_version(p.game_id, ''host'')%' as phase2_photo_scope"
   npx supabase db query --remote --read-only -f supabase/inspect/production_fingerprint.sql   # re-fingerprint; compare as in section B
   ```
   Every value should be `true`.
7. **Smoke tests:** `BRINGME_PHASE2_REALTIME_OPTIMIZATION.md` J (host chip "Live"; phones get no messages during photo bursts; joins, kicks and announcements reach everyone; a guest can't join `game:<id>:host`).
8. **Ask hosts to reload** open console and presenter tabs.

**Rollback and recovery:**

- **Phase 2:** `supabase/rollback/20261113000002_realtime_audience_revert.sql` (keeps the Phase 1 locks), then `npx supabase migration repair --status reverted 20261113000002 --remote`.
- **#25:** `supabase/rollback/20261112000012_capacity_enforcement_revert.sql` (added by this investigation; restores the exact body production runs today), then `npx supabase migration repair --status reverted 20261112000012 --remote`.
- **History repair:** `npx supabase migration repair --status reverted <versions…> --remote` removes recorded rows without touching objects.
- **Last resort:** restore the step-1 dumps into a new project (they are logical dumps; there is no PITR).

---

## H. Risks and Blockers

| # | Item | Severity | Action |
|---|---|---|---|
| B1 | **No restorable backup** (PITR off, no physical backups listed) | **Blocker for any write** | Take the F step 0 dumps and store them securely |
| B2 | **Deployed app version unknown** | **Blocker for Phase 2** (deploy order) | Check Vercel; deploy the Phase 2 client first |
| B3 | Legacy drift in #2 / #12 (section C) | Decision | Approve recording them as applied; plan a separate alignment migration (0 violating rows today) |
| B4 | #25 not applied | Decision | Recommended: apply it with Phase 2 (`--include-all`); rollback file provided |
| R1 | 1 open lobby game (stale since 12 Nov) | Low | Verify nothing is live right before pushing |
| R2 | Phase 3 uncommitted; Phase 2 app committed but deployment unverified | Process | Review and commit before deploying apps |
| R3 | `supabase/.temp/` is untracked but not git-ignored (project ref, pooler host; no password found in it) | Low | Add `supabase/.temp/` to `.gitignore` |
| R4 | No `supabase/config.toml` | Low | The CLI works with the linked project; `supabase init` would add one if needed later |
| R5 | Not verifiable by SQL | Manual | Auth hook `hook_before_user_created` enabled (Dashboard → Auth → Hooks); Realtime private-channel setting; JWT signing mode (guest tokens) |
| R6 | Method limits | Info | The intended schema was built on the repo's Supabase shim with Postgres 18 locally (production is 17). Only `public` objects plus Storage/Realtime policies and `auth.users` triggers were compared. Postgres 18's NOT NULL constraint rows (177) were excluded as a representation difference; column nullability was compared directly |

---

## I. Final Verdict

1. **Why does Supabase CLI consider all 44 migrations pending?** The history table `supabase_migrations.schema_migrations` does not exist in production. The migrations were run manually (SQL Editor), which records nothing, so the CLI has no record of any of them.
2. **Which migrations are definitely already applied?** 42: everything from `20261110000000` through `20261113000001` except `20261112000012`. 40 are verified equivalent, and 2 (`20261111000001`, `20261111000011`) are applied with legacy drift that re-running cannot change. This includes **Phase 1**.
3. **Which migrations are missing?** `20261112000012_capacity_enforcement` and `20261113000002_realtime_audience` (Phase 2).
4. **Is there schema drift?** Yes, from the legacy upgrade path: extra legacy columns, constraints and indexes, about 20 missing CHECK/FK rules, and some FKs without cascade. All functions, policies, triggers, grants and seeds match except the missing `000012` function. No data violates any missing rule. Fixing it needs a new forward migration.
5. **Can migration history be safely repaired?** Yes, for the 42 versions in F, after a backup and your explicit approval, and with the two drifted migrations accepted knowingly. Never mark `20261112000012` or `20261113000002` as applied.
6. **Is Phase 1 fully installed?** Yes: byte-identical function bodies, attributes and grants.
7. **Is Phase 2 ready for production?** The database side is: its prerequisites hold, every function it replaces matches what it was built from, and the rehearsal applied it cleanly. It should be deployed only **after** B1 (backup) and B2 (app first), in a quiet window, together with `20261112000012`.
8. **What exact commands should I run next?**
   - **Read-only, now:** the three `db dump` commands (F step 0); then check the deployed app commit in Vercel and the Auth hook and Realtime settings in the Dashboard.
   - **After your approval:** `migration repair --status applied --remote <42 versions>` (F step 1), then the F step 2 checks.
   - **In a quiet window, after the app is on Phase 2:** `npx supabase db push --remote --include-all`, then the G step 6 verification and smoke tests.

---

### Files added by this investigation (repository only, nothing applied)

- `supabase/inspect/production_fingerprint.sql`: read-only catalog fingerprint, used for both sides of the comparison.
- `supabase/inspect/production_drift_checks.sql`: read-only drift, validation and violation counts.
- `supabase/rollback/20261112000012_capacity_enforcement_revert.sql`: rollback for #25 (not a migration).
