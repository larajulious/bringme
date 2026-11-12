# BringMe! — Game Pass QA & Security Report (Phase 9)

_2026-11-11 · Only executed checks are reported as passed. "Not executed" means not run, not passed._

**Environments used:**
- PGlite (PostgreSQL 17, all migrations applied).
- Embedded PostgreSQL 18, for real concurrency.
- Production builds served with `next start`.
- Chromium (Playwright) at 390/1280 px.
- Read-only REST checks of the hosted Supabase project.

**No Polar credentials are available** (`.env.local` has no `POLAR_ACCESS_TOKEN` / `POLAR_SERVER`), so nothing ran against a real Polar account. Polar is faked in tests.

## 1. Suites executed (final run)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | ✅ pass |
| `npm run lint` | ✅ clean |
| `npm run build` | ✅ pass |
| `npm test` (24 files: unit + PGlite integration) | ✅ **400/400**: +10 QA-audit DB tests, +2 throttle tests this phase |
| `npm run test:concurrency` (real PostgreSQL 18, simultaneous connections) | ✅ **25/25** |
| HTTP probes, production build | ✅ see §3 |
| Client bundle secret scan (actual `.env.local` secret values + names + Polar hosts) | ✅ 0 hits in 50 client files |
| Chromium: DST display, expired session, offline, out-of-sync | ✅ see §3 |

## 2. Checklist → evidence

✅ = executed and passed · ❌ = executed and failed · ⏸ = not executed (reason given).

### Free trial
| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Eligible registration gets one 7-day trial | ✅ | `auto-trial.test.ts` "confirming the email grants ONE trial (3 players, exactly 7 days)" + auto-confirm insert |
| 2–3 | Limited to 3 players; 4th rejected | ✅ | `entitlements.test.ts` "trial: exactly 3 players, the next one gets game_full"; real-PG race: 10 joins for the last slot → exactly 1 |
| 4 | Can't be claimed again | ✅ | `auto-trial.test.ts` repeated `ensure_my_trial`, `start_trial`, re-confirmation; unique index |
| 5–6 | Logout / multiple sessions don't reset | ✅ | same test (sign-in path called 3×, new-browser equivalent) + real-PG "confirmation racing 10 activation requests → ONE trial" |
| 7 | Expires exactly at the end timestamp | ✅ | `auto-trial.test.ts` active at 7 d − 60 s, expired at 7 d, pass row untouched |
| 8 | Existing legitimate access preserved | ✅ | `auto-trial.test.ts` (manual/legacy → no trial, state unchanged); `game-pass.test.ts` M-1 (live-shaped backfill, identical interval). **Live:** the hosted Starter subscription has exactly one legacy pass with the identical interval (§5) |

### Checkout
| # | Item | Status | Evidence |
|---|---|---|---|
| 1–3 | Starter / Party / Pro charge the configured PHP or USD price | ✅ (logic) · ⏸ (real Polar) | `polar-mapping.test.ts` (amounts from `plan_prices`), `checkout-flow.test.ts` (verified response), `billing.test.ts`. **Real sandbox charge not executed** (no credentials) |
| 4 | Browser can't change the amount | ✅ | `checkout-flow.test.ts` "manipulated body … ignored" |
| 5 | Browser can't swap product ids | ✅ | same test (`productId`, `polar_product_id` ignored); a wrong product returned by Polar → refused |
| 6 | Unsupported currencies rejected | ✅ | `checkout-flow.test.ts`, `billing.test.ts`, `polar-mapping.test.ts` (EUR etc.) |
| 7 | Abandoned checkout → no pass | ✅ | `checkout-flow.test.ts` (DB, 24 h), `webhook.test.ts` `checkout.expired` |
| 8 | Failed payment → no pass | ✅ | `webhook.test.ts` (checkout failed), DB "failed checkout" |
| 9 | Success redirect alone → no pass | ✅ | `checkout-flow.test.ts` (DB "success redirect WITHOUT a paid webhook") + `returnState` unit tests |

### Webhooks
| # | Item | Status | Evidence |
|---|---|---|---|
| 1–2 | Valid accepted / invalid rejected | ✅ | Standard Webhooks spec vector; `webhook.test.ts`; HTTP probes: unsigned/forged/stale → 403 |
| 3 | Paid order activates | ✅ | `webhook.test.ts` "valid paid order" |
| 4–5 | Duplicate / concurrent duplicate | ✅ | PGlite + real-PG races (same delivery 10×; 10 different deliveries) → one 7-day pass |
| 6 | Out-of-order | ✅ | `webhook.test.ts` refund-before-paid, late paid, late expiry |
| 7 | Unknown customer can't claim | ✅ | `customer_mismatch` + "missing customer correlation" |
| 8 | Wrong organization rejected | ✅ | `organization_mismatch` |
| 9 | Wrong environment rejected | ✅ | `environment_mismatch`; unknown order in this environment → ignored; config refuses sandbox in production and vice versa |
| 10 | DB failure doesn't partially fulfil | ✅ | trigger forcing an error mid-transaction → no event row, order pending, no pass |
| 11 | Retry recovers | ✅ | retry of the same delivery → applied once (DB failure and Polar outage) |
| 12 | Refund policy | ✅ | full refund revokes only that order's pass; partial keeps it; repeated refund no-op; over-refund → review |

### Entitlements
| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Paid pass exactly 7 days | ✅ | 604 800 s in several tests, also under `America/New_York` session TZ |
| 2 | Expired pass blocks new hosting | ✅ | `entitlements.test.ts` "expired paid pass" |
| 3 | Same-tier repurchase extends | ✅ | P-2, `entitlements.test.ts` |
| 4 | Upgrade preserves paid value | ✅ | P-3 (paused remainder, total exactly 7 days); real-PG simultaneous purchases |
| 5 | Downgrade per policy | ✅ | "queued downgrade" |
| 6 | Queued passes don't grant conflicting capacity | ✅ | single active segment (exclusion constraint); capacity from the active pass only |
| 7 | Revocation | ✅ | R-6, admin revoke audited |
| 8 | Manual grants | ✅ | R-4, `admin-game-pass.test.ts` |
| 9 | No overlapping active entitlements | ✅ | GiST exclusion constraint; overlap query = 0 in suites and races; postflight Q6 |

### Game integration
| # | Item | Status | Evidence |
|---|---|---|---|
| 1–4 | 3 / 10 / 50 / 100 players | ✅ | `entitlements.test.ts` capacity matrix (fills to the exact limit, next → `game_full`) |
| 5 | Concurrent joins can't bypass | ✅ | real-PG final-slot race; un-remove racing a join |
| 6 | Existing games at expiry | ✅ | "running game at expiry": finishes rounds; no joins, rounds or new games |
| 7 | Historical results available | ✅ | same test (`game_results` after expiry) |
| 8 | Camera, QR, live gameplay unaffected | ✅ (automated) · ⏸ (devices) | existing engine/submissions/review/camera-timing/game-sync suites all pass; **real phones and cameras not tested** |

### Database
| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Migrations match schema | ✅ (local) · ⚠ (live, partial) | `qa-audit.test.ts`: all 50 typed functions exist with matching args. **Live:** objects of migrations 1–10 and 13 are present (REST); 11 and 12 change function bodies only, so they are **unverified** over REST (run `supabase/inspect/game_pass_postflight.sql` in the SQL Editor) |
| 2 | Prior nickname / code / max_active_games failures resolved | ✅ | `legacy-compat.test.ts`; live: all four columns present |
| 3 | Existing records preserved | ✅ | M-1 counts; **live**: 2 profiles, 1 subscription, 2 games, 10 rounds kept; players 1→3 and plans 3→4 (new trial plan) are expected |
| 4 | Unique constraints effective | ✅ | `qa-audit.test.ts` (checkout id, event id, order→pass), trial unique index tests |
| 5 | Required timestamps populated | ✅ | `qa-audit.test.ts` after a full purchase |
| 6 | SQL verification queries pass | ✅ (local) · ⏸ (live) | postflight script executed in a test with expectations asserted; not run on the hosted DB (needs the SQL Editor) |
| 7 | Rollback documented | ✅ | MIGRATION_VERIFICATION.md §5 + tested revert (M-5) |
| 8 | No unexpected removal | ✅ | migrations contain no `DROP TABLE`/row deletes; live counts above |

### Security
| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | No service secret in bundles | ✅ | value scan of `.next/static` (0 hits) |
| 2 | No unauthorized subscription mutation | ✅ | subscriptions frozen; client write inventory = audited column grants only |
| 3 | No role escalation | ✅ | `qa-audit.test.ts`, `authorization.test.ts` |
| 4 | No cross-subscriber purchase access | ✅ | S-2, `admin-game-pass.test.ts`, `my_checkout_status` cross-account → not found |
| 5 | No purchase forgery | ✅ | payment only via signed webhook + Polar API fetch + snapshot checks; client can't call `apply_payment_event` |
| 6 | Guests can't manipulate billing | ✅ | HTTP: guest `bm_player` cookie → 401 on checkout/status/trial/admin; anon EXECUTE allowlist = `can_listen_game_topic` only |
| 7 | RLS as designed | ✅ | RLS on every table; privilege allowlist test |
| 8 | **Rate limiting on abuse-prone endpoints** | ❌ | **Not implemented.** 60 rapid requests each to `/api/play/join` and `/api/webhooks/polar` → no 429. Bounded in part by design: ≤3 pending orders per host, checkout reuse, signature gate, body limits, and the new status-poll throttle. **Production blocker** |

### Reliability
| Item | Status | Evidence |
|---|---|---|
| Network failures | ✅ | Polar unreachable (checkout + webhook), DB failure, client offline message (browser) |
| Expired sessions | ✅ | API 401 / page redirect with `reason=expired`; picker shows "Please sign in again" |
| Repeated webhook delivery | ✅ | see Webhooks |
| Concurrent purchases | ✅ | real-PG simultaneous purchases, 10× buy clicks → 1 order |
| UTC / local boundaries | ✅ | half-open intervals, 7 d − 60 s / 7 d tests; display in viewer TZ |
| DST display | ✅ | Chromium: New York 1 Nov 2026 "1:30 AM EDT" vs "1:30 AM EST"; London GMT+1 → GMT+0 on 25 Oct |
| Event logging & reconciliation | ✅ | audit rows per action; reconcile path idempotent with the webhook (`qa-audit.test.ts`) |

## 3. HTTP and browser probes (executed)

| Probe | Result |
|---|---|
| Guest cookie → checkout / status / trial / admin reconcile | 401 / 401 / 401 / 401 |
| Forged Supabase cookie → checkout | 401 |
| Webhook: GET / 300 KB body / unsigned / forged | 405 / 413 / 403 / 403 |
| Expired session → `/dashboard/subscription` | 307 → `/auth/login?reason=expired` |
| Secrets in server log | 0 |
| Picker: 401 / offline / out-of-sync | "Please sign in again…" / "offline… not charged" / "being updated… not charged" |

## 4. Issues found and fixed this phase
1. **Unbounded Polar calls from the checkout status endpoint.** Any signed-in host polling it in a loop made our server call Polar with the organization token on every request, which could exhaust Polar rate limits and block checkout for everyone. **Fix:** Polar's answer is reused per checkout for 10 s (`lib/billing/poll-throttle.ts`, used by `app/api/billing/checkout/status/route.ts`). Tested: 100 polls → 1 Polar call.
2. Previously fixed defects that this phase re-verified: the un-remove capacity bypass (migration 12), repeated refunds (migration 11, edit 6), the narrow-container layouts.

## 5. Live database (hosted project, read-only checks)
- Game Pass migrations **through 13 are applied**. This happened between Phase 6 and this audit. 11 and 12 are unverified over REST.
- Backfill correct: one `legacy_subscription` pass, `[2026-11-11 08:26:51.006679, 2026-12-11 08:26:51.006679)`, identical to the subscription; cap 10; audit `legacy_backfill`.
- Plans correct: trial 3 / starter 10 / party 50 / pro 100, all 604 800 s.
- **Starter USD is 2000 ($20.00)**, changed by an admin at 14:31:52 UTC (audited; the old 199 row kept). The user confirmed this was a deliberate test of admin→Polar sync. The price-sync guard blocks it from checkout until Polar matches.
- No `polar_product_id` is set on any live price, and no orders or payment events exist.
- Minor: a no-op plan edit is still logged as `plan_updated` (noise only).

## 6. Remaining risks
- **Not validated against real Polar:** payload shapes beyond the documented Order/Checkout schemas (`refund.*` `data.order_id`), and whether Polar honours the requested `currency`.
- Rate limiting is absent (blocker).
- Missed-payment recovery is manual (admin reconcile with the Polar order id).
- Real devices: camera, Realtime and timing are unverified on phones (pre-existing).
- No Polar product exists yet, so checkout is off.

## 7. Production blockers
1. **Rate limiting** at the edge/WAF for `/api/play/*`, `/api/billing/*`, `/api/webhooks/polar`, auth routes.
2. **Live Polar sandbox run:** POLAR_PRODUCT_SETUP.md §9–§11. Needs `POLAR_SERVER` and `POLAR_ACCESS_TOKEN`.
3. **Run `supabase/inspect/game_pass_postflight.sql` on the hosted DB** to confirm migrations 11–12 and grants.
4. **Resolve the Starter USD price** (now $20.00 on purpose) before enabling checkout. Admin→Polar sync is being implemented next.
5. Earlier blockers from PRODUCTION_READINESS.md: real-device pass, no full CSP.

## 8. Recovery instructions
- **Bad deploy of the cutover:** run `supabase/rollback/20261112000007_entitlement_cutover_revert.sql` in one transaction (MIGRATION_VERIFICATION.md §5). The ledger is kept.
- **Missed or failed webhook:** fix the cause; Polar retries up to 10 times. Otherwise `POST /api/admin/billing/reconcile {orderId, polarOrderId}` as super admin. It's idempotent.
- **Wrong price:** Admin → Plans → Prices (history kept). Checkout stays blocked until Polar matches.
- **Wrongly granted or revoked access:** Admin → Subscriber → Grant / Extend / Revoke (audited).
- **Disputed payment:** handled automatically (pass revoked); review `pass_orders.review_reason`.
