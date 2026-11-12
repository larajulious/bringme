/**
 * Polar webhook → Game Pass fulfilment (pure flow with injected dependencies; tested in
 * tests/webhook-flow.test.ts). Used by app/api/webhooks/polar and the admin reconcile route.
 *
 * Principles
 *  - The signature proves Polar sent *something*. We then FETCH the order/checkout from
 *    Polar's API with our own token and decide only from that authoritative, current state
 *    (Polar's webhook payload schema is not documented field-by-field; the Order schema is).
 *    This also makes out-of-order and duplicate events converge to the same result.
 *  - Only a Polar order with paid=true and status paid/refunded/partially_refunded,
 *    billing_reason "purchase", of OUR organization, can grant — and the database still checks
 *    environment, product, buyer (customer.external_id), checkout, currency and exact amount
 *    against the order snapshot, atomically with the grant (apply_payment_event).
 *  - Every effect has a stable event id, so retries and concurrent deliveries apply once.
 */
import type { WebhookConfig } from "./config.ts";
import { productProblem, readPolarProduct, summarize } from "./product-sync.ts";
import { verifyWebhookSignature } from "./webhook-signature.ts";

export type PolarOrderFacts = {
  id: string;
  status: string;
  paid: boolean;
  currency: string;
  netMinor: number | null;
  discountMinor: number;
  taxMinor: number | null;
  totalMinor: number | null;
  refundedMinor: number;
  billingReason: string | null;
  productId: string | null;
  checkoutId: string | null;
  customerId: string | null;
  customerExternalId: string | null;
  organizationId: string | null;
  metadataOrderId: string | null;
};

const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
const str = (v: unknown) => (typeof v === "string" && v.length > 0 && v.length <= 200 ? v : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reads the documented Order fields (GET /v1/orders/{id}). */
export function readPolarOrder(json: unknown): PolarOrderFacts | null {
  if (!json || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  const id = str(o.id);
  if (!id || typeof o.status !== "string" || typeof o.currency !== "string") return null;
  const customer = (o.customer && typeof o.customer === "object" ? o.customer : {}) as Record<string, unknown>;
  const product = (o.product && typeof o.product === "object" ? o.product : {}) as Record<string, unknown>;
  const meta = (o.metadata && typeof o.metadata === "object" ? o.metadata : {}) as Record<string, unknown>;
  const metaOrder = str(meta.bringme_order_id);
  return {
    id,
    status: o.status,
    paid: o.paid === true,
    currency: o.currency.toUpperCase(),
    netMinor: int(o.net_amount),
    discountMinor: int(o.discount_amount) ?? 0,
    taxMinor: int(o.tax_amount),
    totalMinor: int(o.total_amount),
    refundedMinor: int(o.refunded_amount) ?? 0,
    billingReason: str(o.billing_reason),
    productId: str(o.product_id)?.toLowerCase() ?? null,
    checkoutId: str(o.checkout_id),
    customerId: str(o.customer_id),
    customerExternalId: str(customer.external_id),
    organizationId: (str(product.organization_id) ?? str(customer.organization_id))?.toLowerCase() ?? null,
    metadataOrderId: metaOrder && UUID.test(metaOrder) ? metaOrder.toLowerCase() : null,
  };
}

export type Effect = Record<string, unknown> & { kind: string };

/** Effects for the CURRENT state of a Polar order: payment (if paid), then refund (if any). */
export function orderEffects(o: PolarOrderFacts, ctx: { environment: string; organizationId: string }): { suffix: string; effect: Effect }[] {
  const out: { suffix: string; effect: Effect }[] = [];
  const ids = {
    ...(o.metadataOrderId ? { order_id: o.metadataOrderId } : {}),
    polar_order_id: o.id,
    polar_checkout_id: o.checkoutId,
  };
  const settled = o.paid && ["paid", "refunded", "partially_refunded"].includes(o.status);
  if (settled) {
    const reject =
      o.organizationId !== ctx.organizationId ? "organization_mismatch"
      : o.billingReason !== "purchase" ? "not_a_one_time_purchase"
      : o.discountMinor > 0 ? "discount_applied"
      : null;
    out.push({
      suffix: "paid",
      effect: {
        kind: "order_paid", ...ids,
        polar_product_id: o.productId, polar_customer_id: o.customerId,
        external_customer_id: o.customerExternalId,          // key always present: missing = mismatch
        currency: o.currency, amount_minor: o.totalMinor, net_amount_minor: o.netMinor,
        environment: ctx.environment,
        ...(reject ? { reject_reason: reject } : {}),
      },
    });
  }
  if (settled && (o.refundedMinor > 0 || o.status === "refunded")) {
    out.push({
      suffix: `refund:${o.status}:${o.refundedMinor}`,
      effect: { kind: "order_refunded", ...ids, refunded_amount_minor: o.refundedMinor, full: o.status === "refunded" },
    });
  }
  if (o.status === "void" && !o.paid) out.push({ suffix: "void", effect: { kind: "order_canceled", ...ids } });
  return out;
}

export type WebhookDeps = {
  config: WebhookConfig;
  nowSeconds?: number;
  fetchOrder(id: string): Promise<unknown | null>;      // throws on transient failure
  fetchCheckout(id: string): Promise<unknown | null>;   // throws on transient failure
  /** apply_payment_event; throws on database failure (=> 5xx => Polar retries). */
  apply(eventId: string, type: string, summary: Record<string, unknown>, effect: Effect): Promise<string>;
  /** product.* events (admin sync): product id -> plan code for THIS deployment, the read, and the record. */
  productPlans?: Record<string, string>;
  fetchProduct?(id: string): Promise<unknown | null>;
  recordProduct?(planCode: string, product: Record<string, unknown>): Promise<string>;
};

export type WebhookResult = { status: number; body: Record<string, unknown>; log?: Record<string, unknown> };

const MAX_BODY = 256 * 1024;

export async function handlePolarWebhook(
  deps: WebhookDeps,
  req: { headers: { get(name: string): string | null }; body: string },
): Promise<WebhookResult> {
  if (!deps.config.enabled) return { status: 503, body: { error: "webhook_not_configured" }, log: { reasons: deps.config.reasons } };
  if (req.body.length > MAX_BODY) return { status: 413, body: { error: "body_too_large" } };

  const id = req.headers.get("webhook-id");
  const sig = verifyWebhookSignature({
    secret: deps.config.webhookSecret, id, timestamp: req.headers.get("webhook-timestamp"),
    signature: req.headers.get("webhook-signature"), body: req.body, nowSeconds: deps.nowSeconds,
  });
  // Never trust unverified JSON: nothing below runs without a valid signature.
  if (!sig.ok) return { status: 403, body: { error: "invalid_signature" }, log: { reason: sig.reason } };

  let event: { type?: unknown; data?: unknown };
  try { event = JSON.parse(req.body); } catch { return { status: 400, body: { error: "invalid_json" } }; }
  const type = typeof event.type === "string" ? event.type : "unknown";
  const data = (event.data && typeof event.data === "object" ? event.data : {}) as Record<string, unknown>;
  const eventId = id!.slice(0, 150);
  const outcomes: string[] = [];

  return processEvent(deps, eventId, type, data, outcomes);
}

/** Shared by the webhook and admin reconciliation. */
export async function processEvent(
  deps: Omit<WebhookDeps, "config"> & { config: WebhookConfig },
  eventId: string, type: string, data: Record<string, unknown>, outcomes: string[] = [],
): Promise<WebhookResult> {
  if (!deps.config.enabled) return { status: 503, body: { error: "webhook_not_configured" } };
  const ctx = { environment: deps.config.environment, organizationId: deps.config.organizationId };
  const record = async (effect: Effect, summary: Record<string, unknown>, suffix = "") =>
    outcomes.push(await deps.apply(suffix ? `${eventId}:${suffix}` : eventId, type, summary, effect));

  const orderId = type.startsWith("order.") ? str(data.id) : type.startsWith("refund.") ? str(data.order_id) : null;
  if (orderId) {
    const raw = await deps.fetchOrder(orderId);            // authoritative current state
    const facts = raw ? readPolarOrder(raw) : null;
    if (!facts) {
      await record({ kind: "ignore" }, { type, ref: orderId, note: "order_not_found_in_this_environment" });
      return { status: 202, body: { outcomes } };
    }
    const summary = { type, polar_order_id: facts.id, status: facts.status, paid: facts.paid, currency: facts.currency, total: facts.totalMinor, refunded: facts.refundedMinor };
    const effects = orderEffects(facts, ctx);
    if (effects.length === 0) await record({ kind: "ignore" }, { ...summary, note: "not_settled" });   // e.g. order.created / pending
    for (const e of effects) await record(e.effect, summary, e.suffix);
    return { status: 202, body: { outcomes } };
  }

  if (type.startsWith("product.")) {
    // Changes made directly in Polar: compare and mark in/out of sync. NEVER overwrite local plans.
    const productId = str(data.id)?.toLowerCase() ?? null;
    const planCode = productId ? deps.productPlans?.[productId] : undefined;
    const first = await deps.apply(eventId, type, { type, product_id: productId, plan: planCode ?? null }, { kind: "ignore" });
    outcomes.push(first);
    if (first === "duplicate" || !planCode || !deps.fetchProduct || !deps.recordProduct) return { status: 202, body: { outcomes } };
    const p = readPolarProduct(await deps.fetchProduct(productId!));
    if (!p) { outcomes.push("product_not_found"); return { status: 202, body: { outcomes } }; }
    const problem = productProblem(p, deps.config.organizationId);
    outcomes.push(await deps.recordProduct(planCode, { ...summarize(p), ...(problem ? { problem } : {}) }));
    return { status: 202, body: { outcomes } };
  }

  if (type.startsWith("checkout.")) {
    const checkoutId = str(data.id);
    const raw = checkoutId ? await deps.fetchCheckout(checkoutId) : null;
    const status = raw && typeof (raw as Record<string, unknown>).status === "string" ? (raw as Record<string, string>).status : null;
    const summary = { type, polar_checkout_id: checkoutId, status };
    // A checkout NEVER grants (payment is confirmed by order.paid); it can only close an unpaid order.
    if (status === "expired" || status === "failed") {
      await record({ kind: status === "failed" ? "order_failed" : "order_expired", polar_checkout_id: checkoutId }, summary);
    } else {
      await record({ kind: "ignore" }, summary);
    }
    return { status: 202, body: { outcomes } };
  }

  await record({ kind: "ignore" }, { type });
  return { status: 202, body: { outcomes } };
}
