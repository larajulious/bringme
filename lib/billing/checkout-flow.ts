/**
 * The Game Pass checkout flow, independent of Next.js and Supabase so every branch can be
 * tested with fakes (tests/checkout-flow.test.ts). The route wires the real dependencies.
 *
 * Trust model: the browser chooses ONLY a plan code and a currency. Everything that decides
 * the charge or the recipient comes from the server: the buyer (session), the amount
 * (plan_prices via the DB), the Polar product (this deployment's env), the environment, and
 * the correlation (our order id in metadata + external_customer_id = buyer). No step here
 * can grant access: a pass is only created by the verified payment webhook.
 */
import { PAID_PLAN_CODES, type BillingConfig, type PaidPlanCode } from "./config.ts";
import { parseCurrency, type CheckoutCurrency } from "./currency.ts";
import { readCheckoutResponse, verifyCheckout } from "./verify.ts";

export type StartedOrder = {
  order_id: string;
  amount_minor: number;
  currency: string;
  reused: boolean;
  in_flight: boolean;
  checkout_url: string | null;
};

export type CheckoutDeps = {
  config: BillingConfig;
  buyer: { userId: string; email: string | null; ip: string | null };
  siteUrl: string;
  /** start_checkout_order (DB, service role). Throws Error(message) with the DB error code. */
  startOrder(a: { planCode: PaidPlanCode; currency: CheckoutCurrency; environment: string; productId: string }): Promise<StartedOrder>;
  /** Re-reads the order's verified checkout URL (another request may be attaching it). */
  readOrderUrl(orderId: string): Promise<string | null>;
  createCheckout(a: {
    productId: string; currency: CheckoutCurrency; orderId: string; planCode: string; userId: string;
    customerIp: string | null; customerEmail: string | null; successUrl: string; returnUrl: string;
  }): Promise<unknown>;
  attach(a: { orderId: string; checkoutId: string; productId: string; currency: string; amountMinor: number; totalMinor: number | null; url: string; expiresAt: string | null }): Promise<string>;
  cancel(orderId: string, reason: string): Promise<void>;
  /** Phase 8: is Polar configured to charge exactly the local price for this plan/currency? */
  priceSynced?(planCode: PaidPlanCode, currency: CheckoutCurrency, amountMinor: number): Promise<boolean>;
  sleep?(ms: number): Promise<void>;
};

export type CheckoutResult =
  | { ok: true; status: 200 | 201; url: string; reused: boolean; environment: string }
  | { ok: false; status: number; code: string; log?: Record<string, unknown> };

const ORDER_ERRORS: [string, number][] = [
  ["too_many_pending_orders", 429], ["plan_not_purchasable", 409], ["unknown_plan", 400], ["invalid_currency", 400],
  ["account_suspended", 403], ["account_deactivated", 403], ["user_not_found", 403],
];

export async function startCheckout(deps: CheckoutDeps, body: Record<string, unknown>): Promise<CheckoutResult> {
  const { config } = deps;
  if (!config.enabled) return { ok: false, status: 503, code: "checkout_unavailable" };

  // Only these two fields are read; anything else (amount, price, productId, userId…) is ignored.
  const planCode = typeof body.planCode === "string" && (PAID_PLAN_CODES as readonly string[]).includes(body.planCode)
    ? (body.planCode as PaidPlanCode) : null;
  if (!planCode) return { ok: false, status: 400, code: "unknown_plan" };
  const currency = parseCurrency(body.currency);
  if (!currency) return { ok: false, status: 400, code: "invalid_currency" };
  const productId = config.products[planCode];
  if (!productId) return { ok: false, status: 409, code: "plan_not_purchasable" };

  let order: StartedOrder;
  try {
    order = await deps.startOrder({ planCode, currency, environment: config.environment, productId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    const hit = ORDER_ERRORS.find(([c]) => msg.includes(c));
    return hit ? { ok: false, status: hit[1], code: hit[0] } : { ok: false, status: 500, code: "order_failed" };
  }

  // Pricing safety: never open a checkout for a price Polar doesn't charge exactly (e.g. after a
  // local price edit that wasn't mirrored in Polar). The order is closed, nothing is charged.
  if (!order.reused && !order.in_flight && deps.priceSynced && !(await deps.priceSynced(planCode, currency, order.amount_minor))) {
    await deps.cancel(order.order_id, "pricing_out_of_sync");
    return { ok: false, status: 409, code: "pricing_out_of_sync" };
  }

  // Double click / retry: hand back the SAME verified checkout.
  if (order.reused && order.checkout_url) {
    return { ok: true, status: 200, url: order.checkout_url, reused: true, environment: config.environment };
  }
  if (order.in_flight) {
    const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (let i = 0; i < 12; i++) {
      await sleep(500);
      const url = await deps.readOrderUrl(order.order_id);
      if (url) return { ok: true, status: 200, url, reused: true, environment: config.environment };
    }
    return { ok: false, status: 409, code: "checkout_in_progress" };
  }

  let raw: unknown;
  try {
    raw = await deps.createCheckout({
      productId, currency, orderId: order.order_id, planCode, userId: deps.buyer.userId,
      customerIp: deps.buyer.ip, customerEmail: deps.buyer.email,
      successUrl: `${deps.siteUrl}/dashboard/subscription/checkout?checkout_id={CHECKOUT_ID}`,
      returnUrl: `${deps.siteUrl}/dashboard/subscription?checkout=canceled#plans`,
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : "polar_error";
    await deps.cancel(order.order_id, reason);
    return { ok: false, status: 502, code: "checkout_unavailable", log: { order: order.order_id, reason } };
  }

  const facts = readCheckoutResponse(raw);
  if (!facts) {
    await deps.cancel(order.order_id, "invalid_response");
    return { ok: false, status: 502, code: "checkout_unavailable", log: { order: order.order_id, reason: "invalid_response" } };
  }
  const local = verifyCheckout({ productId, currency, amountMinor: order.amount_minor }, facts);
  const dbResult = await deps.attach({
    orderId: order.order_id, checkoutId: facts.id, productId: facts.productId ?? "", currency: facts.currency,
    amountMinor: facts.amountMinor, totalMinor: facts.taxMinor !== null ? facts.totalMinor : null,
    url: facts.url, expiresAt: facts.expiresAt,
  });
  if (!local.ok || dbResult !== "ok") {
    if (!local.ok) await deps.cancel(order.order_id, local.reason);
    // Never redirect to a checkout that would charge something other than what we showed.
    return { ok: false, status: 409, code: "pricing_unavailable", log: { order: order.order_id, reason: local.ok ? dbResult : local.reason } };
  }
  return { ok: true, status: 201, url: facts.url, reused: false, environment: config.environment };
}

/** What the return page shows. Derived from OUR order, optionally refined by Polar's checkout status. */
export type ReturnState = "confirmed" | "pending_verification" | "not_completed" | "unsuccessful" | "expired" | "canceled" | "review" | "not_found";

export function returnState(order: { found: boolean; status?: string; passGranted?: boolean }, providerStatus: string | null): ReturnState {
  if (!order.found) return "not_found";
  switch (order.status) {
    case "paid": return order.passGranted ? "confirmed" : "pending_verification";
    case "failed": return "unsuccessful";
    case "expired": return "expired";
    case "canceled": return "canceled";
    case "needs_review": return "review";
    case "refunded": case "partially_refunded": return "canceled";
  }
  // pending: Polar's own view decides what we SAY; it never grants anything.
  if (providerStatus === "failed") return "unsuccessful";
  if (providerStatus === "expired") return "expired";
  if (providerStatus === "open") return "not_completed";
  return "pending_verification";   // confirmed / succeeded / unknown: wait for the verified webhook
}
