/**
 * Is Polar configured to charge EXACTLY the local price? (pure; unit-tested)
 * Local price edits never change Polar; until Polar matches, that plan/currency is shown as
 * "needs sync" to admins and is not offered for checkout.
 */
export type SyncState = "ok" | "mismatch" | "missing_in_polar" | "product_not_found" | "not_one_time" | "not_configured" | "unknown";
export type Cur = "PHP" | "USD";

export function priceSyncFromProduct(product: unknown, local: Partial<Record<Cur, number>>): Partial<Record<Cur, SyncState>> {
  const out: Partial<Record<Cur, SyncState>> = {};
  const curs = Object.keys(local) as Cur[];
  if (!product || typeof product !== "object") { for (const c of curs) out[c] = "product_not_found"; return out; }
  const p = product as Record<string, unknown>;
  const recurring = p.is_recurring === true || (p.recurring_interval !== null && p.recurring_interval !== undefined);
  const archived = p.is_archived === true;
  const prices = (Array.isArray(p.prices) ? p.prices : []) as Record<string, unknown>[];
  for (const c of curs) {
    if (recurring) { out[c] = "not_one_time"; continue; }
    if (archived) { out[c] = "product_not_found"; continue; }
    const live = prices.filter((x) => x.is_archived !== true && String(x.price_currency ?? "").toUpperCase() === c);
    if (live.length === 0) { out[c] = "missing_in_polar"; continue; }
    const ok = live.length === 1 && live[0].amount_type === "fixed" && live[0].price_amount === local[c] && live[0].tax_behavior !== "exclusive";
    out[c] = ok ? "ok" : "mismatch";
  }
  return out;
}

export const SYNC_LABEL: Record<SyncState, string> = {
  ok: "In sync with Polar",
  mismatch: "Needs sync: Polar charges a different amount",
  missing_in_polar: "Needs sync: no price in this currency on Polar",
  product_not_found: "Needs sync: Polar product not found",
  not_one_time: "Needs sync: Polar product is recurring",
  not_configured: "No Polar product configured",
  unknown: "Couldn't reach Polar to check",
};
