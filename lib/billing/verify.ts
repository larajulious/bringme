/**
 * Verifies what Polar's checkout response says it will charge (pure; unit-tested).
 * Polar picks the checkout currency itself (geolocation, falling back to the organization's
 * default), so the response is the only evidence of the real charge. Anything other than the
 * exact price, currency and product the host was shown is refused BEFORE redirecting.
 */
import type { CheckoutCurrency } from "./currency";

export type ExpectedCharge = { productId: string; currency: CheckoutCurrency; amountMinor: number };

export type CheckoutFacts = {
  id: string;
  url: string;
  status: string;
  productId: string | null;
  currency: string;            // upper-cased
  amountMinor: number;         // before discounts and taxes
  discountMinor: number;
  totalMinor: number | null;   // after discounts and taxes
  taxMinor: number | null;     // null = not known yet
  taxBehavior: "inclusive" | "exclusive" | null;
  expiresAt: string | null;
};

const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

/** Reads the fields we rely on from a Polar `Checkout` JSON object; null if it isn't one. */
export function readCheckoutResponse(json: unknown): CheckoutFacts | null {
  if (!json || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  const amount = int(o.amount);
  if (typeof o.id !== "string" || typeof o.url !== "string" || typeof o.currency !== "string" || amount === null) return null;
  let url: URL;
  try { url = new URL(o.url); } catch { return null; }
  if (url.protocol !== "https:") return null;
  const tb = o.tax_behavior;
  return {
    id: o.id,
    url: url.toString(),
    status: typeof o.status === "string" ? o.status : "",
    productId: typeof o.product_id === "string" ? o.product_id.toLowerCase() : null,
    currency: o.currency.toUpperCase(),
    amountMinor: amount,
    discountMinor: int(o.discount_amount) ?? 0,
    totalMinor: int(o.total_amount),
    taxMinor: o.tax_amount === null || o.tax_amount === undefined ? null : int(o.tax_amount),
    taxBehavior: tb === "inclusive" || tb === "exclusive" ? tb : null,
    expiresAt: typeof o.expires_at === "string" && !Number.isNaN(Date.parse(o.expires_at)) ? new Date(o.expires_at).toISOString() : null,
  };
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export function verifyCheckout(expected: ExpectedCharge, facts: CheckoutFacts | null): VerifyResult {
  if (!facts) return { ok: false, reason: "invalid_response" };
  if (facts.status !== "open") return { ok: false, reason: "checkout_not_open" };
  if (facts.productId !== expected.productId.toLowerCase()) return { ok: false, reason: "product_mismatch" };
  if (facts.currency !== expected.currency) return { ok: false, reason: "currency_mismatch" };
  if (facts.amountMinor !== expected.amountMinor) return { ok: false, reason: "amount_mismatch" };
  if (facts.discountMinor !== 0) return { ok: false, reason: "discount_applied" };
  // Tax added on top would make the charge differ from the advertised price.
  if (facts.taxBehavior === "exclusive" && facts.taxMinor !== 0) return { ok: false, reason: "tax_not_inclusive" };
  if (facts.totalMinor !== null && facts.taxMinor !== null && facts.totalMinor !== expected.amountMinor) {
    return { ok: false, reason: "total_mismatch" };
  }
  return { ok: true };
}
