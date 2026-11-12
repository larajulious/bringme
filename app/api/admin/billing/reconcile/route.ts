import type { NextRequest } from "next/server";

import { HttpError, handle, isUuid, json, readJson } from "@/lib/api/http";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { parseWebhookEnv } from "@/lib/billing/config";
import { getPolarCheckout, getPolarOrder } from "@/lib/billing/polar";
import { processEvent, readPolarOrder } from "@/lib/billing/webhook";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/database.types";

/**
 * Super admin: re-check one of OUR orders against Polar's current state (uncertain payments,
 * missed webhooks). Body: { orderId, polarOrderId? } — polarOrderId (from the Polar dashboard)
 * is only accepted if that Polar order belongs to this order's checkout. Same verified,
 * idempotent path as the webhook (stable reconcile:* event ids), so it can't double-grant.
 */
export async function POST(request: NextRequest) {
  return handle(async () => {
    await requireSuperAdmin();
    const body = await readJson(request);
    if (!isUuid(body.orderId)) throw new HttpError(400, "invalid_order");
    const polarOrderId = typeof body.polarOrderId === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(body.polarOrderId) ? body.polarOrderId : null;

    const config = parseWebhookEnv(process.env);
    if (!config.enabled) throw new HttpError(503, "polar_not_configured");
    const db = createAdminClient();
    const { data: order } = await db.from("pass_orders")
      .select("id, status, polar_environment, polar_order_id, polar_checkout_id").eq("id", body.orderId).maybeSingle();
    if (!order) throw new HttpError(404, "order_not_found");
    if (order.polar_environment && order.polar_environment !== config.environment) throw new HttpError(409, "other_environment");

    const deps = {
      config,
      fetchOrder: (id: string) => getPolarOrder(config, id),
      fetchCheckout: (id: string) => getPolarCheckout(config, id),
      async apply(eventId: string, type: string, summary: Record<string, unknown>, effect: Record<string, unknown>) {
        const { data, error } = await db.rpc("apply_payment_event", {
          p_provider: "polar", p_event_id: eventId, p_event_type: type, p_payload: summary as Json, p_effect: effect as Json,
        });
        if (error) throw new HttpError(500, "reconcile_failed");
        return data as string;
      },
    };

    const target = polarOrderId ?? order.polar_order_id;
    if (target) {
      const facts = readPolarOrder(await getPolarOrder(config, target));
      if (!facts) throw new HttpError(404, "polar_order_not_found");
      if (!order.polar_checkout_id || facts.checkoutId !== order.polar_checkout_id) throw new HttpError(409, "not_this_order");
      const r = await processEvent(deps, `reconcile:${facts.id}`, "order.reconcile", { id: facts.id });
      return json({ polarStatus: facts.status, outcomes: r.body.outcomes });
    }
    if (order.polar_checkout_id) {
      const r = await processEvent(deps, `reconcile:${order.polar_checkout_id}`, "checkout.reconcile", { id: order.polar_checkout_id });
      return json({ outcomes: r.body.outcomes, note: "No Polar order id known: pass polarOrderId from the Polar dashboard if the customer paid." });
    }
    throw new HttpError(409, "order_never_reached_polar");
  });
}
