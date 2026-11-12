import "server-only";

import { parseBillingEnv, type BillingConfig } from "@/lib/billing/config";
import type { CheckoutCurrency } from "@/lib/billing/currency";

/** Billing config for THIS deployment (env only; never from the request). */
export const getBillingConfig = (): BillingConfig => parseBillingEnv(process.env);

export class PolarError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

/**
 * Creates a Polar checkout session (REST, no SDK: one call, see POLAR_PRODUCT_SETUP.md).
 * The product id comes from the server's env config, the currency from the host's validated
 * choice, metadata links the session to our order. Discount codes are disabled so the charge
 * equals the advertised price. The response is verified by lib/billing/verify.ts.
 */
export async function createPolarCheckout(
  config: Extract<BillingConfig, { enabled: true }>,
  input: {
    productId: string;
    currency: CheckoutCurrency;
    orderId: string;
    planCode: string;
    userId: string;
    customerIp: string | null;
    /** From the trusted profile (prefill only; the customer is bound by external_customer_id). */
    customerEmail: string | null;
    successUrl: string;
    returnUrl: string;
  },
): Promise<unknown> {
  const body = {
    products: [input.productId],
    currency: input.currency.toLowerCase(),
    ...(input.customerIp ? { customer_ip_address: input.customerIp } : {}),
    // Creates or reuses the Polar customer for this BringMe! account.
    external_customer_id: input.userId,
    ...(input.customerEmail ? { customer_email: input.customerEmail } : {}),
    allow_discount_codes: false,
    metadata: { bringme_order_id: input.orderId, bringme_plan: input.planCode, bringme_environment: config.environment },
    success_url: input.successUrl,
    return_url: input.returnUrl,
  };
  let res: Response;
  try {
    res = await fetch(`${config.apiBase}/v1/checkouts/`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.accessToken}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new PolarError(502, "polar_unreachable");
  }
  if (!res.ok) {
    // Never log the token or the response body (may contain customer data); status is enough.
    console.warn("[billing:polar]", JSON.stringify({ status: res.status, environment: config.environment }));
    throw new PolarError(502, res.status === 401 || res.status === 403 ? "polar_auth_failed" : "polar_rejected");
  }
  return res.json().catch(() => null);
}

/**
 * Reads a checkout session's status from Polar (server-to-server, our token). Used only to
 * show "payment unsuccessful" / "expired" on the return page and to CLOSE such orders;
 * a paid order is only ever recognised from the verified webhook.
 */
export async function getPolarCheckoutStatus(
  config: Extract<BillingConfig, { enabled: true }>,
  checkoutId: string,
): Promise<{ status: string; productId: string | null } | null> {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(checkoutId)) return null;
  try {
    const res = await fetch(`${config.apiBase}/v1/checkouts/${encodeURIComponent(checkoutId)}`, {
      headers: { authorization: `Bearer ${config.accessToken}`, accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const j = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return j && typeof j.status === "string" ? { status: j.status, productId: typeof j.product_id === "string" ? j.product_id : null } : null;
  } catch {
    return null;
  }
}

/** First public client IP from the proxy headers (helps Polar with tax/country); null if none. */
export function clientIp(headers: Headers): string | null {
  const raw = headers.get("x-forwarded-for")?.split(",")[0]?.trim() || headers.get("x-real-ip")?.trim() || "";
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(raw)) {
    const [a, b] = raw.split(".").map(Number);
    const isPrivate = a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
    return isPrivate ? null : raw;
  }
  if (/^[0-9a-f:]+$/i.test(raw) && raw.includes(":") && raw !== "::1" && !/^f[cd]/i.test(raw) && !/^fe80/i.test(raw)) return raw;
  return null;
}

type PolarApi = { apiBase: string; accessToken: string };

/** GET a Polar resource with our token. 404 -> null (not ours / not in this environment);
 *  other failures throw PolarError so the webhook answers 5xx and Polar retries. */
export async function polarGet(api: PolarApi, path: string): Promise<unknown | null> {
  let res: Response;
  try {
    res = await fetch(`${api.apiBase}${path}`, {
      headers: { authorization: `Bearer ${api.accessToken}`, accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(6_000),
    });
  } catch {
    throw new PolarError(502, "polar_unreachable");
  }
  if (res.status === 404 || res.status === 422) return null;
  if (!res.ok) throw new PolarError(502, res.status === 401 || res.status === 403 ? "polar_auth_failed" : "polar_error");
  return res.json().catch(() => { throw new PolarError(502, "polar_bad_json"); });
}

const ID = /^[A-Za-z0-9_-]{1,200}$/;
export const getPolarOrder = (api: PolarApi, id: string) => (ID.test(id) ? polarGet(api, `/v1/orders/${encodeURIComponent(id)}`) : Promise.resolve(null));
export const getPolarCheckout = (api: PolarApi, id: string) => (ID.test(id) ? polarGet(api, `/v1/checkouts/${encodeURIComponent(id)}`) : Promise.resolve(null));

/** PATCH a Polar resource (admin product sync). Throws PolarError with Polar's status; never logs the body. */
export async function polarPatch(api: PolarApi, path: string, body: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${api.apiBase}${path}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${api.accessToken}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new PolarError(502, "polar_unreachable");
  }
  if (!res.ok) {
    let detail = "";
    try { const j = (await res.json()) as { detail?: unknown }; detail = typeof j.detail === "string" ? j.detail.slice(0, 160) : ""; } catch { /* ignore */ }
    throw new PolarError(res.status, `polar_${res.status}${detail ? `: ${detail}` : ""}`);
  }
  return res.json();
}
export const getPolarProduct = (api: PolarApi, id: string) => polarGet(api, `/v1/products/${encodeURIComponent(id)}`);
export const patchPolarProduct = (api: PolarApi, id: string, body: unknown) => polarPatch(api, `/v1/products/${encodeURIComponent(id)}`, body);
