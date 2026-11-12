import type { NextRequest } from "next/server";

import { json } from "@/lib/api/http";
import { parseCatalogEnv, parseWebhookEnv } from "@/lib/billing/config";
import { getPolarCheckout, getPolarOrder, getPolarProduct } from "@/lib/billing/polar";
import { handlePolarWebhook } from "@/lib/billing/webhook";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/database.types";

/**
 * Polar webhook (no session; allow-listed in lib/supabase/proxy.ts). Flow and trust model:
 * lib/billing/webhook.ts. Responses: 202 handled (incl. duplicates / ignored / held for review),
 * 403 bad signature, 5xx transient failure => Polar retries (up to 10x). Never logs the secret,
 * signature headers or the payload.
 */
export async function POST(request: NextRequest) {
  const config = parseWebhookEnv(process.env);
  const body = await request.text();
  const db = config.enabled ? createAdminClient() : null;
  const catalog = parseCatalogEnv(process.env);
  const productPlans = catalog.enabled ? Object.fromEntries(Object.entries(catalog.products).map(([code, pid]) => [pid!, code])) : {};
  try {
    const result = await handlePolarWebhook({
      config,
      fetchOrder: (id) => (config.enabled ? getPolarOrder(config, id) : Promise.resolve(null)),
      fetchCheckout: (id) => (config.enabled ? getPolarCheckout(config, id) : Promise.resolve(null)),
      productPlans,
      fetchProduct: (id) => (config.enabled ? getPolarProduct(config, id) : Promise.resolve(null)),
      async recordProduct(planCode, product) {
        const { data, error } = await db!.rpc("record_polar_product_state", { p_environment: config.enabled ? config.environment : "sandbox", p_plan_code: planCode, p_product: product as Json });
        if (error) throw new Error(`db:${error.code ?? "error"}`);
        return data as string;
      },
      async apply(eventId, type, summary, effect) {
        const { data, error } = await db!.rpc("apply_payment_event", {
          p_provider: "polar", p_event_id: eventId, p_event_type: type, p_payload: summary as Json, p_effect: effect as Json,
        });
        if (error) throw new Error(`db:${error.code ?? "error"}`);
        return data as string;
      },
    }, { headers: request.headers, body });
    if (result.log || result.status >= 400) {
      console.warn("[billing:webhook]", JSON.stringify({ status: result.status, ...(result.log ?? {}), outcomes: result.body.outcomes ?? null }));
    }
    return json(result.body, result.status);
  } catch (e) {
    // Transient (Polar API or database): nothing was committed for the failing effect; ask Polar to retry.
    console.error("[billing:webhook]", JSON.stringify({ error: e instanceof Error ? e.message.slice(0, 60) : "unknown" }));
    return json({ error: "temporary_failure" }, 503);
  }
}
