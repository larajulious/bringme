/**
 * READ-ONLY Polar product audit (POLAR_PRODUCT_SETUP.md §5). Never creates or edits anything.
 *   node --env-file=.env.local scripts/polar-audit.ts
 * Reads POLAR_SERVER, POLAR_ACCESS_TOKEN, POLAR_PRODUCT_ID_{STARTER,PARTY,PRO} and the approved
 * amounts from the database (plan_prices via the server key). Exit 0 = every mapping matches.
 */
import { auditProduct } from "../lib/billing/audit.ts";
import { PAID_PLAN_CODES, POLAR_API_BASE } from "../lib/billing/config.ts";

const env = process.env;
const server = env.POLAR_SERVER === "production" ? "production" : env.POLAR_SERVER === "sandbox" ? "sandbox" : null;
if (!server || !env.POLAR_ACCESS_TOKEN) {
  console.error("Set POLAR_SERVER (sandbox|production) and POLAR_ACCESS_TOKEN.");
  process.exit(2);
}
if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY (to read the approved prices).");
  process.exit(2);
}

const db = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/plan_prices?select=currency,amount_minor,subscription_plans(code)&is_active=eq.true`, {
  headers: { apikey: env.SUPABASE_SECRET_KEY, authorization: `Bearer ${env.SUPABASE_SECRET_KEY}` },
});
if (!db.ok) { console.error(`Could not read plan_prices (HTTP ${db.status}). Is migration 20261112000002 applied?`); process.exit(2); }
const rows = (await db.json()) as { currency: "PHP" | "USD"; amount_minor: number; subscription_plans: { code: string } }[];

console.log(`Polar ${server} (${POLAR_API_BASE[server]})`);
let problems = 0;
for (const code of PAID_PLAN_CODES) {
  const id = env[`POLAR_PRODUCT_ID_${code.toUpperCase()}`];
  const prices = Object.fromEntries(rows.filter((r) => r.subscription_plans?.code === code).map((r) => [r.currency, r.amount_minor]));
  if (!id) { console.log(`  ${code}: no POLAR_PRODUCT_ID_${code.toUpperCase()} (plan will not be offered)`); continue; }
  const res = await fetch(`${POLAR_API_BASE[server]}/v1/products/${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${env.POLAR_ACCESS_TOKEN}`, accept: "application/json" },
  });
  const product = res.ok ? await res.json() : null;
  if (!res.ok) console.log(`  ${code}: GET product -> HTTP ${res.status}`);
  const issues = auditProduct({ code, prices }, product);
  problems += issues.length;
  console.log(issues.length ? issues.map((i) => `  ✗ ${i}`).join("\n") : `  ✓ ${code}: one-time, ${Object.entries(prices).map(([c, a]) => `${c} ${a}`).join(" / ")}`);
}
console.log(problems ? `\n${problems} problem(s). Fix them in the Polar dashboard; this script changes nothing.` : "\nAll mapped products match.");
process.exit(problems ? 1 : 0);
