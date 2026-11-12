import type { NextRequest } from "next/server";

import { HttpError, handle, json, readJson } from "@/lib/api/http";
import { requireRole } from "@/lib/auth/guards";
import { startCheckout } from "@/lib/billing/checkout-flow";
import { clientIp, createPolarCheckout, getBillingConfig, PolarError } from "@/lib/billing/polar";
import { getPriceSync } from "@/lib/billing/price-sync-server";
import { getSiteUrl } from "@/lib/site/url";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Start (or resume) a one-time Game Pass checkout for the signed-in Game Master.
 * Body: { planCode, currency }; nothing else is read. Logic + trust model:
 * lib/billing/checkout-flow.ts. Creating a checkout never grants access.
 */
export async function POST(request: NextRequest) {
  return handle(async () => {
    const { supabase, userId } = await requireRole("subscriber");
    const body = await readJson(request);
    const { data: me } = await supabase.from("profiles").select("email").eq("id", userId).maybeSingle();
    const db = createAdminClient();
    const config = getBillingConfig();

    const result = await startCheckout({
      config,
      buyer: { userId, email: me?.email ?? null, ip: clientIp(request.headers) },
      siteUrl: getSiteUrl().url,
      async startOrder(a) {
        const { data, error } = await db.rpc("start_checkout_order", {
          p_user: userId, p_plan_code: a.planCode, p_currency: a.currency, p_environment: a.environment as "sandbox" | "production", p_polar_product_id: a.productId,
        });
        if (error || !data?.[0]) throw new Error(error?.message ?? "order_failed");
        return data[0];
      },
      async readOrderUrl(orderId) {
        const { data } = await db.from("pass_orders").select("checkout_url, status").eq("id", orderId).eq("user_id", userId).maybeSingle();
        return data?.status === "pending" ? (data.checkout_url ?? null) : null;
      },
      async createCheckout(a) {
        if (!config.enabled) throw new Error("checkout_unavailable");
        try {
          return await createPolarCheckout(config, a);
        } catch (e) {
          throw new Error(e instanceof PolarError ? e.code : "polar_error");
        }
      },
      async attach(a) {
        const { data, error } = await db.rpc("attach_verified_checkout", {
          p_order: a.orderId, p_checkout_id: a.checkoutId, p_product_id: a.productId, p_currency: a.currency,
          p_amount_minor: a.amountMinor, p_total_minor: a.totalMinor, p_url: a.url, p_expires_at: a.expiresAt,
        });
        if (error) throw new HttpError(500, "order_failed");
        return data ?? "error";
      },
      async priceSynced(planCode, currency, amountMinor) {
        const sync = await getPriceSync({ [planCode]: { [currency]: amountMinor } }, config);
        return sync[planCode]?.[currency] === "ok";
      },
      async cancel(orderId, reason) {
        await db.rpc("cancel_unstarted_order", { p_order: orderId, p_reason: reason });
      },
    }, body);

    if (!result.ok) {
      if (result.log) console.warn("[billing:checkout]", JSON.stringify(result.log));
      throw new HttpError(result.status, result.code);
    }
    return json({ url: result.url, reused: result.reused, environment: result.environment }, result.status);
  });
}
