import type { NextRequest } from "next/server";

import { HttpError, handle, isUuid, json, readJson } from "@/lib/api/http";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { createAdminClient } from "@/lib/supabase/admin";

const BAN_FOREVER = "876000h"; // ~100 years; 'none' lifts the ban

/**
 * Deactivate / reactivate a subscriber account. Deactivation (1) flags the
 * profile, which removes entitlement in the database immediately, and (2) bans
 * the auth user so they cannot sign in or refresh a session. If the ban call
 * fails the flag is rolled back, so the two never diverge.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { userId: actorId } = await requireSuperAdmin();

    const { id } = await params;
    if (!isUuid(id)) throw new HttpError(400, "invalid_user");
    if (id === actorId) throw new HttpError(409, "cannot_change_own_account");
    const body = await readJson(request);
    if (body.action !== "deactivate" && body.action !== "reactivate") throw new HttpError(400, "invalid_action");
    const active = body.action === "reactivate";

    const admin = createAdminClient();
    const flag = await admin.rpc("admin_set_account_active", { p_user: id, p_active: active });
    if (flag.error) {
      if (flag.error.message.includes("user_not_found")) throw new HttpError(404, "user_not_found");
      throw new HttpError(500, "update_failed");
    }
    const ban = await admin.auth.admin.updateUserById(id, { ban_duration: active ? "none" : BAN_FOREVER });
    if (ban.error) {
      await admin.rpc("admin_set_account_active", { p_user: id, p_active: !active }); // roll back
      throw new HttpError(500, "update_failed");
    }
    return json({ ok: true });
  });
}
