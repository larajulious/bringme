import "server-only";

import type { BillingConfig, PaidPlanCode } from "@/lib/billing/config";
import { getBillingConfig, polarGet } from "@/lib/billing/polar";
import { priceSyncFromProduct, type Cur, type SyncState } from "@/lib/billing/price-sync";

// Small per-instance cache of Polar product reads (data only; never a client or secret).
const cache = new Map<string, { at: number; product: unknown | null }>();
const TTL_MS = 5 * 60_000;

async function product(config: Extract<BillingConfig, { enabled: true }>, id: string): Promise<unknown | null | "unknown"> {
  const key = `${config.environment}:${id}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.product;
  try {
    const p = await polarGet(config, `/v1/products/${encodeURIComponent(id)}`);
    cache.set(key, { at: Date.now(), product: p });
    return p;
  } catch {
    return "unknown";
  }
}

/** Per plan + currency: does Polar charge exactly the local price? Anything but "ok" blocks checkout. */
export async function getPriceSync(
  local: Partial<Record<PaidPlanCode, Partial<Record<Cur, number>>>>,
  config: BillingConfig = getBillingConfig(),
): Promise<Partial<Record<PaidPlanCode, Partial<Record<Cur, SyncState>>>>> {
  const out: Partial<Record<PaidPlanCode, Partial<Record<Cur, SyncState>>>> = {};
  for (const [code, prices] of Object.entries(local) as [PaidPlanCode, Partial<Record<Cur, number>>][]) {
    const curs = Object.keys(prices) as Cur[];
    const id = config.enabled ? config.products[code] : undefined;
    if (!config.enabled || !id) { out[code] = Object.fromEntries(curs.map((c) => [c, "not_configured"])); continue; }
    const p = await product(config, id);
    out[code] = p === "unknown" ? Object.fromEntries(curs.map((c) => [c, "unknown"])) : priceSyncFromProduct(p, prices);
  }
  return out;
}

/** Drop cached product reads (after an admin edits a price, so the page re-checks). */
export function invalidatePriceSync() { cache.clear(); }
