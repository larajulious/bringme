/**
 * Read-only audit of a Polar product against the approved catalogue (pure; unit-tested).
 * Used by scripts/polar-audit.ts. Never creates or edits products.
 */
export type ApprovedPlan = { code: string; prices: Partial<Record<"PHP" | "USD", number>> };

export function auditProduct(plan: ApprovedPlan, product: unknown): string[] {
  if (!product || typeof product !== "object") return [`${plan.code}: product not found`];
  const p = product as Record<string, unknown>;
  const issues: string[] = [];
  if (p.is_archived === true) issues.push(`${plan.code}: product is archived`);
  if (p.is_recurring === true || (p.recurring_interval !== null && p.recurring_interval !== undefined)) {
    issues.push(`${plan.code}: product is RECURRING; Game Passes must be one-time (create a new one-time product)`);
  }
  const prices = Array.isArray(p.prices) ? (p.prices as Record<string, unknown>[]) : [];
  const live = prices.filter((x) => x.is_archived !== true);
  for (const [cur, amount] of Object.entries(plan.prices)) {
    const matches = live.filter((x) => String(x.price_currency ?? "").toUpperCase() === cur);
    if (matches.length === 0) { issues.push(`${plan.code}: no ${cur} price`); continue; }
    if (matches.length > 1) issues.push(`${plan.code}: more than one active ${cur} price`);
    const m = matches[0];
    if (m.amount_type !== "fixed") issues.push(`${plan.code}: ${cur} price is ${String(m.amount_type)}, expected fixed`);
    if (m.price_amount !== amount) issues.push(`${plan.code}: ${cur} price is ${String(m.price_amount)}, expected ${amount}`);
    if (m.tax_behavior === "exclusive") issues.push(`${plan.code}: ${cur} price adds tax on top (use inclusive) — the charge would exceed the advertised price`);
  }
  return issues;
}
