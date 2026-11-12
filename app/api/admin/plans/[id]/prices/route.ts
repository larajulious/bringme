import type { NextRequest } from "next/server";

import { HttpError, handle, isUuid, json, readJson } from "@/lib/api/http";
import { parsePriceInput } from "@/lib/admin/validation";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { invalidatePriceSync } from "@/lib/billing/price-sync-server";
import { PAID_PLAN_CODES } from "@/lib/billing/config";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Set one plan's price in ONE currency (exact minor units). Never touches Polar: the old price
 * row is kept for history and checkout for this price stays blocked until Polar charges the
 * same amount (price sync). Audited in admin_audit_events.
 */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { userId: adminId } = await requireSuperAdmin();
    const { id } = await params;
    if (!isUuid(id)) throw new HttpError(400, "invalid_plan");
    const parsed = parsePriceInput(await readJson(request));
    if (!parsed.ok) throw new HttpError(400, parsed.error);
    // Paid plans: prices are changed through the Polar sync (POST …/sync), never locally only.
    const { data: plan } = await createAdminClient().from("subscription_plans").select("code").eq("id", id).maybeSingle();
    if (plan && (PAID_PLAN_CODES as readonly string[]).includes(plan.code)) throw new HttpError(409, "use_sync_editor");
    const { error } = await createAdminClient().rpc("admin_set_plan_price", {
      p_admin: adminId, p_plan: id, p_currency: parsed.value.currency, p_amount_minor: parsed.value.amountMinor,
    });
    if (error) {
      const known = ["plan_not_found", "invalid_currency", "invalid_price", "trial_price_must_be_zero", "paid_price_must_be_positive"].find((c) => error.message.includes(c));
      throw new HttpError(known === "plan_not_found" ? 404 : known ? 400 : 500, known ?? "update_failed");
    }
    invalidatePriceSync();
    return json({ ok: true });
  });
}
