# BringMe! — Polar Product Setup (7-Day Game Pass)

_2026-11-11 · For whoever configures Polar and deploys BringMe! Nothing in this repo creates, edits or deletes Polar products: you set them up by hand, and the app only reads them._

## 0. Status, and what was verified

| Item | Status |
|---|---|
| Existing Polar integration in the repo | **None before this phase.** No SDK, routes, product ids or env vars (GAME_PASS_AUDIT.md §5). |
| Polar organization / existing products | **Not audited.** No Polar credentials are available here. Run `npm run billing:audit` (§5) once the ids are set. |
| SDK | **Not added.** The app needs one call (create checkout) plus a read-only audit, done with `fetch` against the documented REST API. This avoids a new dependency during the SDK's 2026-04 → 2026-10 API churn. Revisit when the webhook phase adds signature verification. |
| Polar behaviour this design relies on | From the official docs (links in §8). Facts we could not verify are marked **[unverified]**. |

What the official docs say, and why the app is built the way it is:

1. **A product can hold fixed prices in several currencies**, side by side. Each price has its own `price_currency` and `price_amount` in minor units. The amounts are set by you, so PHP 99.00 is entered as `9900` and is **not converted** from USD.
2. **"A price in the default currency is required. If you leave it empty, the product is treated as free."** So a Game Pass product must carry a price in your organization's default currency (normally USD) and add PHP beside it. A PHP-only product is not an option unless your organization's default is PHP.
3. **Polar picks the checkout currency itself:** "based on the customer's geolocation at checkout. If their currency isn't enabled on the product, it falls back to your organization's default." The create-checkout request has a `currency` field, but its effect is **not documented [unverified]**. **That is why the server checks the checkout response before redirecting** (§4).
4. **One-time vs recurring is fixed at creation:** a one-time product has `recurring_interval: null`. "The billing cycle and recurring interval are locked in at creation. If you need to change them later, create a new product instead."
5. **The price structure must match across currencies:** both the PHP and USD prices must be *fixed* prices.
6. **Separate environments:** sandbox API `https://sandbox-api.polar.sh` and production API `https://api.polar.sh`. Products, ids and tokens are created separately in each. Whether a sandbox token can ever touch production is not stated **[unverified]**, so we treat them as fully separate.

## 1. Approved catalogue

The amounts live in the database (`public.plan_prices`, migration `20261112000002`). They are the source of truth, and Polar must match them exactly.

| Plan code | Polar product name (suggested) | Players | Access | PHP price (`price_amount`) | USD price (`price_amount`) | Type |
|---|---|---|---|---|---|---|
| `trial` | **no product, no checkout** | 3 | 7 days | — | — | free, automatic |
| `starter` | BringMe! Starter — 7-Day Game Pass | 10 | 7 days | **₱99.00 (`9900`)** | **$1.99 (`199`)** | one-time |
| `party` | BringMe! Party — 7-Day Game Pass | 50 | 7 days | **₱199.00 (`19900`)** | **$3.49 (`349`)** | one-time |
| `pro` | BringMe! Pro — 7-Day Game Pass | 100 | 7 days | **₱299.00 (`29900`)** | **$4.99 (`499`)** | one-time |

Access length and player caps are enforced by BringMe!'s database, not by Polar. A Polar product does not need any "benefit" for the pass to work.

## 2. Sandbox setup (do this first)

1. Sign in to the **Polar sandbox** dashboard (Polar's docs describe a separate sandbox environment; use it, not production). Create or choose the organization.
2. **Default currency:** note the organization's default payment currency (expected: USD).
3. **Create three products**, one per paid plan, for each:
   - Name and description as in §1. Pricing: **One-time purchase** (no billing interval).
   - Price type **Fixed**. Add the **USD** price (default currency) with the exact amount from §1.
   - Add a **PHP** price with the exact PHP amount from §1. Do not let Polar derive it from USD.
   - If the dashboard offers a tax behaviour, choose **inclusive**. The advertised price must be the total charged, and the server refuses checkouts that would add tax on top.
   - Do not attach discounts. The app also disables discount codes on its checkouts.
4. Copy each **product id** (a UUID) into the sandbox deployment's env (§3).
5. **Access token:** Settings → Developers → create an organization access token for the sandbox org, with scopes for checkouts (write) and products (read). Put it in `POLAR_ACCESS_TOKEN` of the sandbox/local deployment only.
6. **Webhook secret:** create the webhook endpoint when the webhook phase ships. For now set `POLAR_WEBHOOK_SECRET` to the secret Polar shows, because checkout refuses to start without it.
7. Run the audit (§5). It must report ✓ for every plan.
8. With `BILLING_CHECKOUT_ENABLED=true`, open **Dashboard → Game Pass**, pick **PHP**, and click **Pay ₱99.00 PHP** on Starter:
   - **Pass:** you land on a Polar sandbox checkout showing ₱99.00. The page shows the "Test mode" badge.
   - **Refused instead:** you see "We couldn't confirm that exact price…", and the order in `pass_orders` is `canceled` with `review_reason = checkout_currency_mismatch` (or another `checkout_*` reason). In that case Polar is ignoring the requested currency; see §4.
   - Repeat with **USD** and with a VPN or another country, and record the results in §7.

> Until the webhook phase ships, a completed **sandbox** payment is recorded by Polar but does **not** grant a BringMe! pass. Production checkout is blocked in code (`WEBHOOK_HANDLER_READY = false` in `lib/billing/config.ts`) so real money can't be taken without granting a pass.

## 3. Environment variables (server-only, per deployment)

| Variable | Sandbox / local / preview | Production deployment |
|---|---|---|
| `BILLING_CHECKOUT_ENABLED` | `true` when testing | `true` only after the go-live checklist (§6) |
| `POLAR_SERVER` | `sandbox` | `production` |
| `POLAR_ACCESS_TOKEN` | sandbox org token | production org token |
| `POLAR_WEBHOOK_SECRET` | sandbox webhook secret | production webhook secret |
| `POLAR_PRODUCT_ID_STARTER` / `_PARTY` / `_PRO` | sandbox product ids | production product ids |

Rules enforced by `parseBillingEnv` (tested in `tests/billing.test.ts`):
- **Off by default.** Any missing or invalid value disables checkout, and the UI then shows disabled buttons and "Online checkout opens soon". Nothing half-works.
- **No crossing environments:**
  - `POLAR_SERVER=production` is refused outside a production runtime (`VERCEL_ENV=production`, or a non-Vercel `NODE_ENV=production`; set `BILLING_RUNTIME=staging` to mark a non-Vercel staging box).
  - `POLAR_SERVER=sandbox` is refused inside a production runtime, so real customers never get a test checkout.
- **No ambiguity:**
  - Product ids must be UUIDs.
  - The same id may not map two plans.
  - A plan without an id is not offered.
  - The trial never has one.
- **Never `NEXT_PUBLIC_`.** Nothing Polar-related reaches the browser except the checkout URL Polar returns.

The database may be shared by sandbox and production deployments, so each order records `polar_environment` and `polar_product_id` (migration `20261112000009`). A payment event from the other environment, or for a different product, is held as `needs_review` and never grants a pass.

## 4. Currency selection rules (what the host sees vs. what is charged)

1. **Display.** The Game Pass page always shows both regional prices: the selected currency large, the other as "or …". The terms line reads **"One-time payment. Seven days of access. No automatic renewal."**
2. **Default choice.** PHP if the edge country header is `PH` or the browser language is a Philippine locale (`*-PH`, `fil`, `tl`); otherwise USD. The host can switch with the **Pay in ₱ PHP / $ USD** toggle, and the button states the exact charge, e.g. **"Pay ₱99.00 PHP"**.
3. **What the server sends.** Only `{ planCode, currency }` comes from the browser. Both are validated against fixed lists, so no price or product id is ever accepted from the client. The server then sets:
   - the amount from `plan_prices`;
   - the product id from this deployment's env;
   - `currency`, the customer's public IP (`customer_ip_address`, as Polar's docs advise for server-created sessions), `external_customer_id`, `allow_discount_codes: false`, and `metadata.bringme_order_id`.
4. **What must come back.** Before the host is redirected, Polar's checkout response must show:
   - `status` = `open`;
   - `product_id` = the configured product;
   - `currency` = the chosen currency;
   - `amount` = the exact price;
   - `discount_amount` = 0;
   - no tax added on top (`tax_behavior` not `exclusive`, and `total_amount` = price once tax is known).

   The database repeats the core check and records Polar's figures on the order (`checkout_amount_minor`, `checkout_currency`, audited as `checkout_verified` or `checkout_rejected`).
5. **On any mismatch:** the order is canceled, the host is **not** redirected, and they see "We couldn't confirm that exact price… you were not sent to pay". **A USD charge is never silently substituted for a PHP price, or the other way round.**
6. **If Polar ignores `currency`** (it may follow geolocation only), the host's choice only works when it matches their location. For example, a host in the Philippines choosing USD would be refused safely. If sandbox testing (§2.8) shows this, decide between:
   - (a) showing only the currency Polar will pick for the host's location;
   - (b) asking Polar support how to force a presentment currency.

   Record the decision in §7. Until then, the safe refusal stands.

## 5. Read-only audit

```bash
npm run billing:audit      # = node --env-file=.env.local scripts/polar-audit.ts
```

For each `POLAR_PRODUCT_ID_*` it runs `GET /v1/products/{id}` on the configured environment and checks:
- the product exists and is not archived;
- it is **one-time** (`is_recurring` false, `recurring_interval` null);
- it has exactly one active **fixed** PHP price and one USD price with **the amounts in `plan_prices`**;
- neither price adds tax on top.

It only reads. Fix problems in the Polar dashboard. Exit code 0 means every mapping matches.

## 6. Production configuration procedure

Do this only after the sandbox passes and the webhook phase has shipped (`WEBHOOK_HANDLER_READY = true`).

1. In the **production** organization, create the three products exactly as in §2.3. **Never edit or delete existing production products**: create new ones and leave old ones in place (archive them in Polar only after no order references them). Polar ids differ from sandbox ids; never copy sandbox ids into production.
2. Set the production deployment's env (§3) with the production token, webhook secret and product ids. Keep `BILLING_CHECKOUT_ENABLED=false` for now.
3. Run `npm run billing:audit` with the production env locally, or as a one-off job. All ✓.
4. Set `BILLING_CHECKOUT_ENABLED=true` and redeploy. Make one real purchase per currency with a team account, check the order in `pass_orders` (`paid`, `polar_environment = production`), then refund it from Polar.
5. **Changing a price later:**
   - In Polar, add the new fixed price on the same product, or create a new product.
   - In BringMe!, deactivate the old `plan_prices` row and insert the new one (a forward migration). Orders keep referencing the row they used.
   - Update the env id if the product changed, then re-run the audit.
   - **Historical references are preserved:** `pass_orders.polar_product_id` and `plan_price_id` are snapshots and are never rewritten.

## 7. Verification log (fill in)

| Date | Environment | Plan / currency | Host location | Result (redirected? amount shown?) | By |
|---|---|---|---|---|---|
| | sandbox | starter / PHP | PH | | |
| | sandbox | starter / USD | PH | | |
| | sandbox | starter / USD | US | | |
| | sandbox | starter / PHP | US | | |

## 8. Sources (official Polar docs, read 2026-11-11)
- Products (multiple currencies, default currency, one-time vs recurring): https://polar.sh/docs/features/products
- Checkout API (sessions, `customer_ip_address`, currency from IP): https://polar.sh/docs/features/checkout/session
- Create Checkout Session (request and response fields: `currency`, `amount`, `total_amount`, `tax_behavior`, `product_id`, `metadata`): https://polar.sh/docs/api-reference/checkouts/create-session
- Create Product (`recurring_interval: null` = one-time, `ProductPriceFixedCreate.price_currency`): https://polar.sh/docs/api-reference/2026-04/products/create-product

## 9. Sandbox checkout test (Phase 5): the acceptance check for "works in Polar sandbox"

**Not yet run.** This environment has no Polar credentials. Run it with the sandbox setup from §2, then record the results in §7.

Prerequisites:
- Migrations through `20261112000010` applied.
- Sandbox env set (§3) with `BILLING_CHECKOUT_ENABLED=true`.
- A **confirmed Game Master** account.
- Polar sandbox test card details from Polar's sandbox documentation.

| # | Step | Expected |
|---|---|---|
| 1 | Signed out: `curl -X POST /api/billing/checkout` | `401 {"error":"unauthenticated"}` |
| 2 | Signed in: **Game Pass → Pay in ₱ PHP → Buy Starter · ₱99.00 PHP** | Button shows "Opening secure checkout…" and the browser goes to `sandbox.polar.sh`, showing **₱99.00**. In `pass_orders`: one row, `status = pending`, `currency = PHP`, `amount_minor = 9900`, `polar_environment = sandbox`, `polar_product_id` = the Starter id, `checkout_amount_minor = 9900`, `checkout_currency = PHP`, `checkout_url` set |
| 3 | Go back and click Buy again (or double-click) | **Same** checkout URL; still one pending order |
| 4 | On Polar, click the back link | `/dashboard/subscription?checkout=canceled`: "Checkout canceled. You were not charged." |
| 5 | Pay with a **declining** test card | Polar shows the failure. On `/dashboard/subscription/checkout?checkout_id=…`: "Payment unsuccessful" once Polar reports `failed`, and the order becomes `failed` |
| 6 | Pay with a **successful** test card | Redirect to `/dashboard/subscription/checkout?checkout_id=…`: **"Payment received — confirming…"** keeps polling. **No pass is created** (`game_passes` has no `purchase` row) until the verified webhook ships (Phase 6). This is expected |
| 7 | Open the step-6 URL while signed in as **another** host | "We couldn't find this checkout" |
| 8 | Switch to **USD** and buy | Polar shows **$1.99**. If Polar shows a different currency or amount, the app refuses with "We couldn't confirm that exact price…" and the order is `canceled` with `review_reason = checkout_*_mismatch` |
| 9 | Abandon a checkout for 24 h (or set `created_at` back in sandbox) | The next Buy marks it `expired` and creates a new one |

Useful queries (sandbox DB):
```sql
select id, status, currency, amount_minor, polar_environment, polar_checkout_id, checkout_currency, checkout_amount_minor, review_reason, created_at
from public.pass_orders order by created_at desc limit 10;
select action, details, at from public.entitlement_events where order_id is not null order by at desc limit 20;
```

## 10. Webhook endpoint (Phase 6)

1. In each Polar environment (sandbox, then production): **Settings → Webhooks → Add endpoint**.
   - URL: `https://<that deployment's domain>/api/webhooks/polar`. Use the exact path; it is the only unauthenticated `/api/webhooks/*` route.
   - Format: the default (Standard Webhooks).
   - Events: `order.created`, `order.paid`, `order.updated`, `order.refunded`, `refund.created`, `refund.updated`, `checkout.updated`, `checkout.expired`.
2. Copy the endpoint's signing secret (`whsec_…`) into `POLAR_WEBHOOK_SECRET` of **that** deployment. Secrets created before 2026-09-08 ("Polar HMAC") also work; the verifier tries both schemes, as Polar's SDKs do.
3. Set `POLAR_ORGANIZATION_ID` (Settings → General → Organization ID).
4. The access token needs `orders:read`, `checkouts:read`/`checkouts:write`, `products:read`. The webhook **fetches the order from Polar's API** and decides from that, not from the event body.
5. **Re-run §9.** Step 6 must now end with "Your Game Pass is active!" (a 7-day pass appears), and a refund from the Polar dashboard must revoke it. Record the results in PAYMENT_VERIFICATION.md §3.
6. **Production:** after §9 passes in sandbox, set `BILLING_PRODUCTION_APPROVED=true` in the production deployment only. Without it, production checkout stays off.
7. **Reconciliation (missed or uncertain events):** as a signed-in super admin, `POST /api/admin/billing/reconcile` with `{"orderId":"<pass_orders.id>","polarOrderId":"<optional, from the Polar dashboard>"}`.
   - It re-checks our order against Polar's current state through the same verified, idempotent path.
   - A Polar order is only accepted if it belongs to that order's checkout.

## 11. Price changes and "Needs sync" (Phase 8)

- **Admin → Plans → Prices** changes BringMe!'s price only. It **never changes Polar**. The old price row is kept for history, and orders keep the price they were made at.
- Every paid price shows its Polar status: **Polar ✓**, **Needs sync** (amount, currency, recurring or archived differs), **No product** or **Unchecked** (Polar unreachable). It comes from a read-only product check, cached for 5 minutes and refreshed after each price edit.
- A price that isn't **Polar ✓** is **not offered for checkout**: the button is disabled with "Not available in PHP right now". The checkout route also refuses it (`pricing_out_of_sync`) before any Polar session exists.
- **To change a live price:** update the fixed price on the Polar product first (or add a new product and update its `POLAR_PRODUCT_ID_*`), then set the same amount in Admin → Plans → Prices. Check that the badge is Polar ✓.

## 12. Admin plan edits sync to Polar (replaces §11's manual step)

**Admin → Plans → Edit & sync** (paid plans) changes the name, PHP price, USD price and maximum players in one action. Duration is fixed at 7 days.

How it works:
1. A sync job records the previous and requested values. Only one job can be open per plan.
2. BringMe! reads the Polar product. It refuses a product of another organization, a recurring product or an archived one.
3. It sends the **minimal** `PATCH /v1/products/{id}`: the name if changed, and `prices` keeping the unchanged currency (and any other currencies) as `{id}` plus a **new** fixed price for each changed currency. It never sends `recurring_interval`, `is_archived` or `visibility`.
4. BringMe! **re-reads the product and verifies** exactly one active fixed price per currency at the requested amount, plus the name. Only then does it apply the new values locally, in one transaction, and record the new price ids (`plan_polar_state`).
5. The result is shown honestly:
   - **Synced:** both systems are confirmed.
   - **Saved in BringMe! only:** no product is mapped for this plan.
   - **Not saved, sync failed:** BringMe! keeps the old values.
   - **Polar updated, local save failed:** use **Retry Sync**. It re-verifies and, since Polar already matches, sends no new price.
6. While the two systems differ, the price-sync guard (§11) blocks checkout at the affected price.

Notes:
- **Token scopes:** the access token now also needs **`products:write`**.
- **Already-open checkouts after a price change:** they are **honoured**. A buyer who completes a checkout opened before the change pays the price that checkout showed, and their order snapshot matches it, so the pass is granted. New checkouts always use the new price, and an old open checkout is never re-offered.
- **Edits made directly in Polar:** the `product.updated` webhook (subscribe to `product.updated` in §10) and **Check Polar** compare Polar with BringMe! and mark the plan **Changed in Polar** (out of sync). They **never overwrite** BringMe!'s values. Reads older than the last recorded state, and reads taken while a sync job is open, are ignored. Resolve by editing the plan to the intended values with **Edit & sync**.
- Whether Polar archives omitted prices isn't documented. If the old price stays active, verification fails with `usd_active_prices_2` and nothing is saved locally. Archive the old price in the Polar dashboard, then use **Retry Sync**.

### Sandbox test (not yet run: `.env.local` has no `POLAR_SERVER` / `POLAR_ACCESS_TOKEN`)
1. Set `POLAR_SERVER=sandbox`, `POLAR_ACCESS_TOKEN` (scopes: `products:read`, `products:write`, `checkouts:*`, `orders:read`), `POLAR_ORGANIZATION_ID`, `POLAR_PRODUCT_ID_STARTER` (one-time product with USD 1.99 + PHP 99.00). Restart.
2. Admin → Plans → Starter → **Check Polar**: the badge should read "In sync" or "Changed in Polar". The hosted DB currently has Starter USD = 20.00 locally, so expect "Changed in Polar" until step 3.
3. **Edit & sync** → USD 20.00 (and optionally a new name) → expect "Saved and synchronized with Polar (sandbox)".
4. In the Polar sandbox dashboard, the Starter product shows USD 20.00 and PHP 99.00, and the old USD price is archived.
5. Run `npm run billing:audit` → ✓ Starter, USD 2000 / PHP 9900.
6. Change PHP only (e.g. 129.00). The USD price id is unchanged (`plan_polar_state.usd_price_id`).
7. Start a USD checkout: the Polar page shows $20.00. **Do not pay**, or use a sandbox test card only.
