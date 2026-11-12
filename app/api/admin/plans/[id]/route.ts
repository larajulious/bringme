import type { NextRequest } from "next/server";

import { HttpError, handle, isUuid, json, readJson } from "@/lib/api/http";
import { parsePlanInput } from "@/lib/admin/validation";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { PAID_PLAN_CODES } from "@/lib/billing/config";
import { createAdminClient } from "@/lib/supabase/admin";

/** Edit a plan or (de)activate it (audited). Sold passes keep their player-cap snapshot. */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { userId: adminId } = await requireSuperAdmin();
    const { id } = await params;
    if (!isUuid(id)) throw new HttpError(400, "invalid_plan");
    const parsed = parsePlanInput(await readJson(request), "update");
    if (!parsed.ok) throw new HttpError(400, parsed.error);
    // Prices are edited separately (per currency, kept as history); legacy price_cents is ignored.
    const { price_cents: _ignored, ...patch } = parsed.value;
    void _ignored;
    if (Object.keys(patch).length === 0) throw new HttpError(400, "nothing_to_update");
    // Paid plans: name and player limit are synchronised with Polar (POST …/sync); never edited locally only.
    if ("name" in patch || "max_players_per_game" in patch) {
      const { data: plan } = await createAdminClient().from("subscription_plans").select("code").eq("id", id).maybeSingle();
      if (plan && (PAID_PLAN_CODES as readonly string[]).includes(plan.code)) throw new HttpError(409, "use_sync_editor");
    }

    const { error } = await createAdminClient().rpc("admin_update_plan", { p_admin: adminId, p_plan: id, p_patch: patch });
    if (error) {
      if (error.message.includes("plan_not_found")) throw new HttpError(404, "plan_not_found");
      if (error.message.includes("field_not_editable")) throw new HttpError(400, "field_not_editable");
      if (error.code === "23514") throw new HttpError(400, "invalid_max_players");
      throw new HttpError(500, "update_failed");
    }
    return json({ ok: true });
  });
}
