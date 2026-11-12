/**
 * Polar billing configuration (pure; unit-tested). The ONLY source of Polar product ids:
 * per-deployment env vars, so sandbox and production never share ids. Nothing here comes
 * from the request. Secrets are read by lib/billing/polar.ts (server-only) and passed in.
 *
 * Env vars (see POLAR_PRODUCT_SETUP.md):
 *   BILLING_CHECKOUT_ENABLED   "true" to allow checkout at all (default off)
 *   POLAR_SERVER               "sandbox" | "production" (required; no default)
 *   POLAR_ACCESS_TOKEN         organization access token for THAT environment (secret)
 *   POLAR_WEBHOOK_SECRET       webhook signing secret for THAT environment (secret)
 *   POLAR_PRODUCT_ID_STARTER / _PARTY / _PRO   one-time product ids in THAT environment
 *   POLAR_ORGANIZATION_ID      the Polar organization (UUID) in THAT environment; orders of
 *                              any other organization are never accepted
 *   BILLING_PRODUCTION_APPROVED "true" once the sandbox checklist passed (production only)
 */
export type PolarEnvironment = "sandbox" | "production";
export const PAID_PLAN_CODES = ["starter", "party", "pro"] as const;
export type PaidPlanCode = (typeof PAID_PLAN_CODES)[number];

export const POLAR_API_BASE: Record<PolarEnvironment, string> = {
  sandbox: "https://sandbox-api.polar.sh",
  production: "https://api.polar.sh",
};

/** The verified webhook handler (app/api/webhooks/polar) exists since Phase 6. */
export const WEBHOOK_HANDLER_READY = true;

export type BillingConfig =
  | {
      enabled: true;
      environment: PolarEnvironment;
      apiBase: string;
      accessToken: string;
      /** Plans with a configured product. Missing plans are simply not offered. */
      products: Partial<Record<PaidPlanCode, string>>;
      warnings: string[];
    }
  | { enabled: false; environment: PolarEnvironment | null; reasons: string[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Is this a production runtime? (Vercel production, or a plain `next start` with NODE_ENV=production and no VERCEL_ENV.) */
export function isProductionRuntime(env: Record<string, string | undefined>): boolean {
  if (env.VERCEL_ENV) return env.VERCEL_ENV === "production";
  return env.NODE_ENV === "production" && env.BILLING_RUNTIME !== "staging";
}

export function parseBillingEnv(env: Record<string, string | undefined>): BillingConfig {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const server = env.POLAR_SERVER?.trim();
  const environment: PolarEnvironment | null = server === "sandbox" || server === "production" ? server : null;

  if (env.BILLING_CHECKOUT_ENABLED?.trim() !== "true") reasons.push("checkout_disabled");
  if (!server) reasons.push("polar_server_missing");
  else if (!environment) reasons.push("polar_server_invalid");

  // Sandbox and production are never crossed.
  const prodRuntime = isProductionRuntime(env);
  if (environment === "production" && !prodRuntime) reasons.push("production_polar_outside_production");
  if (environment === "sandbox" && prodRuntime) reasons.push("sandbox_polar_in_production");
  if (environment === "production" && !WEBHOOK_HANDLER_READY) reasons.push("webhook_handler_not_ready");
  // Real money only after an operator confirmed the sandbox checklist (POLAR_PRODUCT_SETUP.md §9).
  if (environment === "production" && env.BILLING_PRODUCTION_APPROVED?.trim() !== "true") reasons.push("production_not_approved");
  if (!UUID.test(env.POLAR_ORGANIZATION_ID?.trim().toLowerCase() ?? "")) reasons.push("polar_organization_missing");

  const accessToken = env.POLAR_ACCESS_TOKEN?.trim() ?? "";
  if (!accessToken) reasons.push("polar_token_missing");
  if (!env.POLAR_WEBHOOK_SECRET?.trim()) reasons.push("webhook_secret_missing");

  const products: Partial<Record<PaidPlanCode, string>> = {};
  const seen = new Map<string, PaidPlanCode>();
  for (const code of PAID_PLAN_CODES) {
    const raw = env[`POLAR_PRODUCT_ID_${code.toUpperCase()}`]?.trim().toLowerCase();
    if (!raw) { warnings.push(`no product configured for ${code}`); continue; }
    if (!UUID.test(raw)) { reasons.push(`invalid_product_id_${code}`); continue; }
    if (seen.has(raw)) { reasons.push(`duplicate_product_id_${seen.get(raw)}_${code}`); continue; }
    seen.set(raw, code);
    products[code] = raw;
  }
  if (Object.keys(products).length === 0) reasons.push("no_products_configured");

  if (reasons.length || !environment) return { enabled: false, environment, reasons };
  return { enabled: true, environment, apiBase: POLAR_API_BASE[environment], accessToken, products, warnings };
}

/** Non-secret view for pages: which plans can be bought, and in which environment. */
export function publicBillingState(c: BillingConfig) {
  return c.enabled
    ? { checkout: true as const, environment: c.environment, plans: Object.keys(c.products) as PaidPlanCode[] }
    : { checkout: false as const, environment: c.environment, plans: [] as PaidPlanCode[] };
}

/** What the WEBHOOK needs (independent of BILLING_CHECKOUT_ENABLED: confirming payments must
 *  keep working even when new checkouts are switched off). */
export type WebhookConfig =
  | { enabled: true; environment: PolarEnvironment; apiBase: string; accessToken: string; webhookSecret: string; organizationId: string }
  | { enabled: false; reasons: string[] };

export function parseWebhookEnv(env: Record<string, string | undefined>): WebhookConfig {
  const reasons: string[] = [];
  const server = env.POLAR_SERVER?.trim();
  const environment: PolarEnvironment | null = server === "sandbox" || server === "production" ? server : null;
  if (!environment) reasons.push("polar_server_missing");
  const prodRuntime = isProductionRuntime(env);
  if (environment === "production" && !prodRuntime) reasons.push("production_polar_outside_production");
  if (environment === "sandbox" && prodRuntime) reasons.push("sandbox_polar_in_production");
  const accessToken = env.POLAR_ACCESS_TOKEN?.trim() ?? "";
  if (!accessToken) reasons.push("polar_token_missing");
  const webhookSecret = env.POLAR_WEBHOOK_SECRET?.trim() ?? "";
  if (!webhookSecret) reasons.push("webhook_secret_missing");
  const organizationId = env.POLAR_ORGANIZATION_ID?.trim().toLowerCase() ?? "";
  if (!UUID.test(organizationId)) reasons.push("polar_organization_missing");
  if (reasons.length || !environment) return { enabled: false, reasons };
  return { enabled: true, environment, apiBase: POLAR_API_BASE[environment], accessToken, webhookSecret, organizationId };
}

/** What ADMIN product sync needs: environment, token, organization and the plan -> product map
 *  (independent of BILLING_CHECKOUT_ENABLED: prices can be synced before checkout is switched on). */
export type CatalogConfig =
  | { enabled: true; environment: PolarEnvironment; apiBase: string; accessToken: string; organizationId: string; products: Partial<Record<PaidPlanCode, string>> }
  | { enabled: false; reasons: string[] };

export function parseCatalogEnv(env: Record<string, string | undefined>): CatalogConfig {
  const reasons: string[] = [];
  const server = env.POLAR_SERVER?.trim();
  const environment: PolarEnvironment | null = server === "sandbox" || server === "production" ? server : null;
  if (!environment) reasons.push("polar_server_missing");
  const prodRuntime = isProductionRuntime(env);
  if (environment === "production" && !prodRuntime) reasons.push("production_polar_outside_production");
  if (environment === "sandbox" && prodRuntime) reasons.push("sandbox_polar_in_production");
  const accessToken = env.POLAR_ACCESS_TOKEN?.trim() ?? "";
  if (!accessToken) reasons.push("polar_token_missing");
  const organizationId = env.POLAR_ORGANIZATION_ID?.trim().toLowerCase() ?? "";
  if (!UUID.test(organizationId)) reasons.push("polar_organization_missing");
  const products: Partial<Record<PaidPlanCode, string>> = {};
  for (const code of PAID_PLAN_CODES) {
    const raw = env[`POLAR_PRODUCT_ID_${code.toUpperCase()}`]?.trim().toLowerCase();
    if (raw && UUID.test(raw)) products[code] = raw;
    else if (raw) reasons.push(`invalid_product_id_${code}`);
  }
  if (reasons.length || !environment) return { enabled: false, reasons };
  return { enabled: true, environment, apiBase: POLAR_API_BASE[environment], accessToken, organizationId, products };
}
