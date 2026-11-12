# BringMe! — Payment Verification & Game Pass Activation (Phase 6)

_2026-11-11 · Recorded outcomes of executed tests. Anything not executed is listed as such in §4._

> **Not yet exercised against a real Polar account.** This environment has no Polar credentials. Every result below comes from:
> - local tests: PGlite with migrations 1–11, plus embedded PostgreSQL 18 for concurrency;
> - the official Standard Webhooks test vector;
> - HTTP probes of a production build, one of which reached the **real** `sandbox-api.polar.sh` with a dummy token (refused as expected).
>
> The live sandbox run is POLAR_PRODUCT_SETUP.md §9–§10.

## 1. What was built

| Piece | File |
|---|---|
| Webhook route (no session; exact-path allow-list in the proxy) | `app/api/webhooks/polar/route.ts`, `lib/supabase/proxy.ts` |
| Signature verification: Standard Webhooks + Polar's legacy HMAC key; constant-time compare; ±5 min replay window | `lib/billing/webhook-signature.ts` |
| Flow: verify → **fetch the order or checkout from Polar's API** → derive effects → apply | `lib/billing/webhook.ts` |
| Atomic fulfilment: event dedupe + order transition + pass grant/revoke + audit in **one transaction** | `apply_payment_event` (migration `20261112000011`) |
| Webhook config, independent of the checkout switch; organization id required; production needs `BILLING_PRODUCTION_APPROVED` | `lib/billing/config.ts` |
| Admin reconciliation (same verified, idempotent path) | `app/api/admin/billing/reconcile/route.ts` |

### Trust and correctness rules
- **Unverified JSON is never processed.** Nothing runs before the signature checks out (403 otherwise).
- **The event body is only a trigger.** Polar's webhook payload schemas don't render in the docs; the Order schema does. So the handler fetches `GET /v1/orders/{id}` (or `/v1/checkouts/{id}`) with our token and decides from Polar's current state. This makes duplicate and out-of-order events converge.
- **Activation requires all of the following** (otherwise `needs_review`, no pass):
  - Polar's state: `paid = true`, status paid/refunded/partially_refunded, `billing_reason = purchase`, our organization (`product.organization_id`), no discount.
  - Checked by the database against the order snapshot: environment, product, buyer (`customer.external_id` = the order's Supabase user), checkout id, currency, and **exact** amount (`total` = price with tax included, or `net` = price with tax added on top).
- **Never activates** on `order.created`, a pending order, a checkout (`succeeded` included), a success redirect, or polling.
- **Idempotency:**
  - Each effect has a stable id (`<webhook-id>:paid`, `:refund:<status>:<amount>`, `reconcile:*`), deduplicated by the unique `payment_events (provider, event_id)`.
  - The same Polar order arriving through another event is `duplicate_effect`.
  - `game_passes.order_id` is unique: one pass per order, ever.
- **Retries:** transient failures (Polar API, database) return **503** → Polar retries (up to 10 times). Because the transaction rolled back, the retry is processed normally.
- **Refunds:**
  - Polar's `refunded` status counts as a **full refund** (Polar refunds the net amount) and revokes **only that order's pass**: unused time is removed, history and audit rows are kept.
  - A partial refund keeps the pass and flags the order.
  - A repeated refund is a no-op; a refund larger than what was paid goes to review.
  - Nothing is ever refunded by deleting rows (orders and passes can't be deleted).
- **Logging:** status, reason and outcome codes only. Never the secret, signature headers, token or payload. `payment_events.payload` stores a minimal summary (type, ids, status, amounts): no email, address or card data.

## 2. Recorded test outcomes (executed 2026-11-11)

### 2.1 Required matrix

Webhook cases are in `tests/db/webhook.test.ts`: a signed delivery → `handlePolarWebhook` → fake Polar API → **real** `apply_payment_event` on PGlite.

| Required case | Test | Outcome |
|---|---|---|
| Valid paid order | "valid paid order -> one 7-day pass…" | ✅ 202 `applied`; order `paid`, `polar_order_id` stored, `paid_amount_minor` 9900; one pass of exactly 604 800 s; audit `order_paid` + `pass_granted` |
| Invalid signature | "invalid signature, tampered body, wrong secret, stale timestamp…" + `tests/webhook-signature.test.ts` | ✅ 403 for tampered body, wrong secret, 1 h-old timestamp, missing headers; **0** rows written; order still `pending` |
| Duplicate `order.paid` | "duplicate order.paid…" | ✅ the same delivery again → `duplicate`; `order.updated` for the same order → `duplicate_effect`; still one pass, 604 800 s |
| Simultaneous duplicate deliveries | real PG: "webhook: the SAME delivery 10x concurrently" / "10 DIFFERENT deliveries…" (+ PGlite 5× serialised) | ✅ 1 `applied` + 9 `duplicate`; 1 `applied` + 9 `duplicate_effect`; **one** 7-day pass in both |
| Unknown product | "unknown product -> held for review" | ✅ `needs_review` / `product_mismatch`, no pass |
| Wrong customer | "wrong customer" + "missing customer correlation" | ✅ `customer_mismatch` (both), no pass |
| Wrong checkout | "wrong checkout" | ✅ `checkout_mismatch`, no pass |
| Wrong currency | "wrong currency" (USD 199 for a PHP order) | ✅ `currency_mismatch`, no pass |
| Wrong environment | "wrong environment…" | ✅ processed under the production config → `environment_mismatch`; an order not found in this environment → 202 `ignored`, no pass |
| Pending order | "order.created / pending order" | ✅ `ignored`; order `pending`, no pass; the later real `order.paid` → `applied` |
| Failed payment | "failed payment (checkout failed)…" | ✅ `checkout.updated` with failed → order `failed`, no pass |
| Abandoned checkout | same test (`checkout.expired`) + `tests/db/checkout-flow.test.ts` (24 h) | ✅ order `expired`, no pass; a `succeeded` checkout alone → `ignored` |
| Full refund | "full refund (Polar status 'refunded', tax-inclusive net amount)…" | ✅ order `refunded`, that pass `revoked`; **the host's other paid order untouched**; purchase history kept |
| Partial refund | "partial refund keeps the pass…" | ✅ `partially_refunded`, `refunded_amount_minor` 2000, `review_reason` partial_refund, pass still `granted` |
| Out-of-order webhook | "out-of-order: refund arrives before paid…" | ✅ refund-first → payment recorded then refunded (`applied, applied`), pass revoked; late `order.paid` → `duplicate_effect` ×2, still one pass; late `checkout.expired` → `ignored` |
| Database failure | "database failure -> error…" + "a failure INSIDE the fulfilment transaction…" | ✅ handler throws → route 503. With a trigger forcing an error mid-transaction: **no** `payment_events` row, order still `pending`, no pass |
| Retry after temporary failure | same two tests + "Polar API temporarily down" | ✅ the retry of the **same** delivery → `applied` once |
| Existing active pass | "existing ACTIVE pass: a cheaper purchase queues after it" | ✅ Pro active, paid Starter `queued`; Starter becomes active when Pro ends |
| Existing queued pass | "existing QUEUED pass: buying Pro starts now…" | ✅ Pro active immediately; segment order pro → party → starter (paused/queued time kept) |

### 2.2 Additional checks
| Check | Outcome |
|---|---|
| Other organization / subscription billing reason / discount applied | ✅ `organization_mismatch` / `not_a_one_time_purchase` / `discount_applied`, no pass |
| Wrong amount | ✅ `amount_mismatch`, no pass |
| Taxes: included (total 9900, net 8839) and added on top (net 9900, total 11 088) | ✅ both `applied`; the actual 11 088 paid is recorded; still exactly 7 days |
| Standard Webhooks published test vector | ✅ verifies |
| Legacy "Polar HMAC" secret, multiple signatures, `v2,` prefix, ±301 s, malformed timestamp | ✅ accepted / accepted / rejected / `stale_timestamp` / `bad_timestamp` |
| Webhook not configured | ✅ 503 (fail closed) |
| Refund repeated under a new event id | ✅ `duplicate_effect`. This was **a bug found by the out-of-order test**: before the fix the refund went to review. Fixed in migration 11 (edit 6) |
| Refund larger than what was paid | ✅ `needs_review` |

### 2.3 HTTP probes (production build, `next start`, port 3124)
| Request | Response | Log line |
|---|---|---|
| Any request while `POLAR_SERVER=sandbox` in a production runtime | 503 `webhook_not_configured` | `sandbox_polar_in_production` (environment guard) |
| Unsigned, with `BILLING_RUNTIME=staging` | 403 `invalid_signature` | `missing_headers` |
| Forged signature | 403 | `bad_signature` |
| Replay (timestamp −1 h) | 403 | `stale_timestamp` |
| **Correctly signed**, dummy token | 503 `temporary_failure` (Polar would retry) | `polar_auth_failed`: the request **reached `sandbox-api.polar.sh`**, which refused the dummy token |
| `POST /api/webhooks/other` without a session | 401 (only the exact webhook path is public) | — |
| Secret, signature or token in the server log | **0 occurrences** | — |

### 2.4 Suites
| Command | Result |
|---|---|
| `npx tsc --noEmit` | ✅ |
| `npm run lint` | ✅ |
| `npm run build` | ✅ |
| `npm test` | ✅ **351/351**: 31 new webhook/signature tests; R-1 updated for edit 6 |
| `npm run test:concurrency` (embedded PostgreSQL 18) | ✅ **23/23**: +2 full-webhook races |

## 3. Live sandbox log (to fill in: POLAR_PRODUCT_SETUP.md §9–§10)

| Date | Step | Result | Polar event ids | By |
|---|---|---|---|---|
| | Paid with test card → pass active (7 days) | | | |
| | Same event redelivered from the Polar dashboard → no extra days | | | |
| | Declined card → "Payment unsuccessful" | | | |
| | Full refund from Polar → pass revoked | | | |
| | Partial refund → pass kept, order flagged | | | |
| | `POST /api/admin/billing/reconcile` on a paid order → `duplicate_effect` | | | |

## 4. Not executed / known limits
- **No real Polar sandbox run** (no credentials). The real payloads haven't been observed. The design depends only on the documented **Order** and **Checkout** schemas (fetched from the API), the event `type`, and `data.id`. For `refund.*` it also uses `data.order_id`, which is **unverified** (refund schemas don't render); `order.refunded` covers refunds regardless.
- **Whether checkout metadata is copied to the order is not stated** in Polar's docs. Matching therefore also uses `checkout_id`, which is documented on Order and stored on our order at checkout, and `polar_order_id`.
- **Automatic reconciliation of "paid at Polar, event never arrived"** relies on Polar's 10 retries plus the admin reconcile route, which needs the Polar order id from the dashboard. A scheduled sweep isn't built, because listing orders by checkout isn't documented.
- **Migrations 1–11 are not applied to the hosted database.**
