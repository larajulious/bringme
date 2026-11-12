import type { NextRequest } from "next/server";

import { HttpError, handle, json } from "@/lib/api/http";
import { requireRole } from "@/lib/auth/guards";
import { returnState } from "@/lib/billing/checkout-flow";
import { createPollThrottle } from "@/lib/billing/poll-throttle";
import { getBillingConfig, getPolarCheckoutStatus } from "@/lib/billing/polar";
import { createAdminClient } from "@/lib/supabase/admin";

// QA fix (Phase 9): Polar's answer per checkout is reused for 10 s (lib/billing/poll-throttle.ts).
const throttle = createPollThrottle<string | null>(10_000);

type OrderStatus = { found: boolean; orderId?: string; status?: string; passGranted?: boolean; environment?: string | null; planName?: string; currency?: string; amountMinor?: number; resumeUrl?: string | null };

/**
 * Status of the signed-in host's OWN checkout, for the return page. A `?checkout_id=` in the
 * URL is only a lookup key: it is matched to the caller's order in the database and can
 * never mark anything paid. While the order is pending we ask Polar (server-to-server) how
 * the session ended, so a failed or expired payment is shown and the order closed. A paid
 * order is recognised ONLY from the verified webhook (Phase 6).
 */
export async function GET(request: NextRequest) {
  return handle(async () => {
    const { supabase } = await requireRole("subscriber");
    const checkoutId = request.nextUrl.searchParams.get("checkout_id") ?? "";
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(checkoutId)) throw new HttpError(400, "invalid_checkout");

    const { data, error } = await supabase.rpc("my_checkout_status", { p_checkout_id: checkoutId });
    if (error) throw new HttpError(500, "status_failed");
    let order = (data ?? { found: false }) as OrderStatus;

    let providerStatus: string | null = null;
    const config = getBillingConfig();
    if (order.found && order.status === "pending" && config.enabled && order.environment === config.environment) {
      providerStatus = await throttle(checkoutId, async () => (await getPolarCheckoutStatus(config, checkoutId))?.status ?? null);
      if (providerStatus === "failed" || providerStatus === "expired") {
        // Closing an unpaid order is safe on our own API read (it grants nothing); idempotent per status.
        await createAdminClient().rpc("apply_payment_event", {
          p_provider: "polar", p_event_id: `poll:${checkoutId}:${providerStatus}`, p_event_type: `checkout.${providerStatus}.poll`,
          p_payload: { checkout_id: checkoutId, status: providerStatus },
          p_effect: { kind: providerStatus === "failed" ? "order_failed" : "order_expired", order_id: order.orderId },
        });
        const again = await supabase.rpc("my_checkout_status", { p_checkout_id: checkoutId });
        if (!again.error && again.data) order = again.data as OrderStatus;
      }
    }

    const state = returnState(order, providerStatus);
    return json({
      state,
      plan: order.planName ?? null,
      currency: order.currency ?? null,
      amountMinor: order.amountMinor ?? null,
      environment: order.environment ?? null,
      resumeUrl: state === "not_completed" ? (order.resumeUrl ?? null) : null,
    });
  });
}
