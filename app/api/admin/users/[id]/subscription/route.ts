import type { NextRequest } from "next/server";

import { HttpError, handle, isUuid, json, readJson } from "@/lib/api/http";
import { parseSubscriptionAction } from "@/lib/admin/validation";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { createAdminClient } from "@/lib/supabase/admin";

const KNOWN = [
  "user_not_found", "unknown_plan", "invalid_days", "invalid_expiry",
  "no_live_subscription", "no_subscription", "account_deactivated",
  "paid_pass_immutable", "reason_required", "pass_not_revocable", "pass_not_found",
];

/**
 * Manual access control (no payments): grant a Game Pass, change the plan or end of a
 * MANUAL pass, suspend. Order matters: authorize -> validate -> service-role call.
 * The SQL functions re-validate everything, re-check that the actor is a super admin,
 * and write an audit event (entitlement_events) with the admin's id.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { userId: adminId } = await requireSuperAdmin();

    const { id } = await params;
    if (!isUuid(id)) throw new HttpError(400, "invalid_user");
    const parsed = parseSubscriptionAction(await readJson(request));
    if (!parsed.ok) throw new HttpError(400, parsed.error);
    const a = parsed.value;

    const db = createAdminClient();
    if (a.action === "revoke") {
      // The pass must belong to THIS subscriber (never revoke by id alone).
      const { data: owned } = await db.from("game_passes").select("id").eq("id", a.passId).eq("user_id", id).maybeSingle();
      if (!owned) throw new HttpError(404, "pass_not_found");
    }
    let extendPlan: string | null = null;
    if (a.action === "extend") {
      // Extension = complimentary days of the host's CURRENT plan, queued by the normal policy
      // (paid passes themselves are never edited).
      const { data: ent } = await db.rpc("pass_entitlement", { p_user: id });
      extendPlan = ent?.[0]?.plan_code ?? null;
      if (!extendPlan) throw new HttpError(422, "no_live_subscription");
    }
    const { error } =
      a.action === "revoke"
        ? await db.rpc("admin_revoke_pass", { p_admin: adminId, p_pass: a.passId, p_reason: a.reason })
        : a.action === "unsuspend"
          ? await db.rpc("admin_set_suspended", { p_admin: adminId, p_user: id, p_suspended: false, p_reason: "Unsuspended from the admin console" })
          : a.action === "extend"
            ? await db.rpc("admin_grant_pass", { p_admin: adminId, p_user: id, p_plan_code: extendPlan!, p_days: a.days, p_reason: `Extension: ${a.reason}` })
            : a.action === "activate"
        ? await db.rpc("admin_grant_pass", {
            p_admin: adminId, p_user: id, p_plan_code: a.planCode, p_days: a.days, p_reason: "Manual grant from the admin console",
          })
        : a.action === "set_plan"
          ? await db.rpc("admin_set_pass_plan", { p_admin: adminId, p_user: id, p_plan_code: a.planCode })
          : a.action === "set_expiry"
            ? await db.rpc("admin_set_pass_expiry", { p_admin: adminId, p_user: id, p_expires: a.expires })
            : await db.rpc("admin_set_suspended", { p_admin: adminId, p_user: id, p_suspended: true, p_reason: "Suspended from the admin console" });
    if (error) {
      const known = KNOWN.find((c) => error.message.includes(c));
      if (known) throw new HttpError(known === "user_not_found" ? 404 : 422, known);
      throw new HttpError(500, "update_failed");
    }
    return json({ ok: true });
  });
}
