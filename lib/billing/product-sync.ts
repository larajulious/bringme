/**
 * Admin plan edit -> Polar product synchronisation (pure flow; tested with a fake Polar in
 * tests/product-sync.test.ts and real SQL in tests/db/plan-sync.test.ts).
 *
 * Polar semantics used (official Update Product docs): PATCH /v1/products/{id} with `name` and
 * `prices`; "If you want to keep existing prices, include them in the list as an
 * ExistingProductPrice object" ({id}); new prices are create objects. Changing an amount = keep
 * the other currency by id + add a NEW fixed price for the changed currency. What Polar does
 * with omitted prices isn't documented, so the product is RE-READ and verified: exactly one
 * active fixed price per currency at the requested amount. Anything else = failed, not success.
 * Never sent: recurring_interval (one-time stays one-time), is_archived (never archives).
 */
import type { Cur } from "./price-sync.ts";

export type Requested = { name: string; maxPlayers: number; phpMinor: number; usdMinor: number };

export type PolarPrice = { id: string; currency: string; amount: number | null; amountType: string; archived: boolean; taxBehavior: string | null };
export type PolarProduct = {
  id: string; name: string; isRecurring: boolean; isArchived: boolean; organizationId: string | null;
  modifiedAt: string | null; metadata: Record<string, unknown>; prices: PolarPrice[];
};

export function readPolarProduct(json: unknown): PolarProduct | null {
  if (!json || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  if (typeof o.id !== "string" || typeof o.name !== "string" || !Array.isArray(o.prices)) return null;
  return {
    id: o.id.toLowerCase(),
    name: o.name,
    isRecurring: o.is_recurring === true || (o.recurring_interval !== null && o.recurring_interval !== undefined),
    isArchived: o.is_archived === true,
    organizationId: typeof o.organization_id === "string" ? o.organization_id.toLowerCase() : null,
    modifiedAt: typeof o.modified_at === "string" ? o.modified_at : null,
    metadata: o.metadata && typeof o.metadata === "object" ? (o.metadata as Record<string, unknown>) : {},
    prices: (o.prices as Record<string, unknown>[]).map((p) => ({
      id: String(p.id ?? ""),
      currency: String(p.price_currency ?? "").toUpperCase(),
      amount: typeof p.price_amount === "number" ? p.price_amount : null,
      amountType: String(p.amount_type ?? ""),
      archived: p.is_archived === true,
      taxBehavior: typeof p.tax_behavior === "string" ? p.tax_behavior : null,
    })),
  };
}

const active = (p: PolarProduct) => p.prices.filter((x) => !x.archived);
const want = (r: Requested): Record<Cur, number> => ({ PHP: r.phpMinor, USD: r.usdMinor });

/** Problems that make a product unsafe to touch at all. */
export function productProblem(p: PolarProduct, organizationId: string): string | null {
  if (p.organizationId !== organizationId) return "organization_mismatch";
  if (p.isRecurring) return "product_is_recurring";
  if (p.isArchived) return "product_is_archived";
  return null;
}

/** Minimal PATCH body, or null when Polar already matches (so retries never add prices). */
export function buildPatch(p: PolarProduct, r: Requested, planCode: string): Record<string, unknown> | null {
  const body: Record<string, unknown> = {};
  if (p.name !== r.name) body.name = r.name;
  if (p.metadata.bringme_plan !== planCode) body.metadata = { ...p.metadata, bringme_plan: planCode };
  const keep: { id: string }[] = [];
  const create: Record<string, unknown>[] = [];
  let pricesChange = false;
  for (const cur of ["USD", "PHP"] as Cur[]) {
    const inCur = active(p).filter((x) => x.currency === cur);
    const match = inCur.find((x) => x.amountType === "fixed" && x.amount === want(r)[cur]);
    if (match) {
      keep.push({ id: match.id });
      if (inCur.length > 1) pricesChange = true;              // drop stray duplicates in this currency
    } else {
      pricesChange = true;
      const prev = inCur.find((x) => x.amountType === "fixed");
      create.push({
        amount_type: "fixed", price_currency: cur.toLowerCase(), price_amount: want(r)[cur],
        ...(prev?.taxBehavior && prev.taxBehavior !== "exclusive" ? { tax_behavior: prev.taxBehavior } : {}),
      });
    }
  }
  // Preserve unrelated prices (other currencies) exactly as they are.
  for (const x of active(p)) if (x.currency !== "USD" && x.currency !== "PHP") keep.push({ id: x.id });
  if (pricesChange) body.prices = [...keep, ...create];
  return Object.keys(body).length ? body : null;
}

/** Polar's ACTUAL state must equal the request. Returns a reason or null. */
export function verifyProduct(p: PolarProduct, r: Requested, organizationId: string): string | null {
  const problem = productProblem(p, organizationId);
  if (problem) return problem;
  if (p.name !== r.name) return "name_not_updated";
  for (const cur of ["USD", "PHP"] as Cur[]) {
    const inCur = active(p).filter((x) => x.currency === cur);
    if (inCur.length !== 1) return `${cur.toLowerCase()}_active_prices_${inCur.length}`;
    if (inCur[0].amountType !== "fixed") return `${cur.toLowerCase()}_not_fixed`;
    if (inCur[0].amount !== want(r)[cur]) return `${cur.toLowerCase()}_amount_${inCur[0].amount}`;
    if (inCur[0].taxBehavior === "exclusive") return `${cur.toLowerCase()}_tax_exclusive`;
  }
  return null;
}

/** Summary stored locally (ids + amounts only). */
export function summarize(p: PolarProduct) {
  const one = (cur: Cur) => { const x = active(p).find((y) => y.currency === cur && y.amountType === "fixed"); return x ? { id: x.id, amount: x.amount } : null; };
  return { product_id: p.id, name: p.name, modified_at: p.modifiedAt, prices: { PHP: one("PHP"), USD: one("USD") } };
}

export type SyncDeps = {
  /** null when this plan has no Polar product in this deployment (local-only change). */
  polar: { environment: string; organizationId: string; productId: string } | null;
  begin(): Promise<string>;                                     // job id
  fetchProduct(id: string): Promise<unknown>;                   // throws on transport failure
  patchProduct(id: string, body: Record<string, unknown>): Promise<unknown>;
  finish(jobId: string, polar: ReturnType<typeof summarize> | null): Promise<void>;
  fail(jobId: string, stage: string, error: string, polar?: ReturnType<typeof summarize>): Promise<void>;
};

export type SyncResult =
  | { status: "synced"; jobId: string; environment: string; patched: boolean }
  | { status: "local_only"; jobId: string }
  | { status: "failed"; jobId: string; stage: string; error: string }
  | { status: "polar_ahead"; jobId: string; error: string };

export async function syncPlan(deps: SyncDeps, planCode: string, r: Requested): Promise<SyncResult> {
  const jobId = await deps.begin();
  if (!deps.polar) {
    await deps.finish(jobId, null);
    return { status: "local_only", jobId };
  }
  const { productId, organizationId, environment } = deps.polar;
  const failed = async (stage: string, error: string, s?: ReturnType<typeof summarize>): Promise<SyncResult> => {
    await deps.fail(jobId, stage, error, s);
    return { status: "failed", jobId, stage, error };
  };

  let before: PolarProduct | null;
  try { before = readPolarProduct(await deps.fetchProduct(productId)); } catch (e) { return failed("fetch", msg(e)); }
  if (!before) return failed("fetch", "polar_product_not_found");
  const problem = productProblem(before, organizationId);
  if (problem) return failed("validate", problem);

  const body = buildPatch(before, r, planCode);
  if (body) {
    try { await deps.patchProduct(productId, body); } catch (e) { return failed("polar_update", msg(e)); }
  }
  let after: PolarProduct | null;
  try { after = readPolarProduct(await deps.fetchProduct(productId)); } catch (e) { return failed("verify", msg(e)); }
  if (!after) return failed("verify", "polar_product_not_found");
  const bad = verifyProduct(after, r, organizationId);
  if (bad) return failed("verify", bad, summarize(after));

  const s = summarize(after);
  try {
    await deps.finish(jobId, s);
  } catch (e) {
    // Polar is updated, BringMe! isn't: recoverable (Retry Sync re-verifies and saves; no new prices).
    try { await deps.fail(jobId, "local_save", msg(e), s); } catch { /* job stays pending; retry still works after 2 min */ }
    return { status: "polar_ahead", jobId, error: msg(e) };
  }
  return { status: "synced", jobId, environment, patched: body !== null };
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);
