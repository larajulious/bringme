import type { NextRequest } from "next/server";

import { HttpError, handle, isUuid, json, readJson } from "@/lib/api/http";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Privileged administration: change a user's role.
 * Authorization happens HERE, on the server, before the service-role client is
 * created. Direct client updates of `profiles.role` are impossible (column
 * grants + trigger), so this is the only path.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { userId: actorId } = await requireSuperAdmin();

    const { id } = await params;
    if (!isUuid(id)) throw new HttpError(400, "invalid_user");
    if (id === actorId) throw new HttpError(409, "cannot_change_own_role"); // no self lock-out

    const body = await readJson(request);
    if (body.role !== "super_admin" && body.role !== "subscriber") throw new HttpError(400, "invalid_role");

    const admin = createAdminClient();
    const { data, error } = await admin
      .from("profiles")
      .update({ role: body.role } as never) // role is service-role-only, so absent from the client Update type
      .eq("id", id)
      .select("id, role")
      .maybeSingle();
    if (error) throw new HttpError(500, "update_failed");
    if (!data) throw new HttpError(404, "user_not_found");
    return json({ user: data });
  });
}
