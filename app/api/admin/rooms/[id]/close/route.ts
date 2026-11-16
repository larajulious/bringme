import type { NextRequest } from "next/server";

import { HttpError, handle, isUuid, json, readJson } from "@/lib/api/http";
import { requireSuperAdmin } from "@/lib/auth/guards";

/**
 * Super Admin force-closes an active room (lobby / live -> canceled). Runs under the admin's own session:
 * admin_close_room re-checks super_admin, notifies every connected screen and writes the audit log.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { supabase } = await requireSuperAdmin();

    const { id } = await params;
    if (!isUuid(id)) throw new HttpError(400, "room_not_found");
    const body = await readJson(request);
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (reason.length < 3 || reason.length > 200) throw new HttpError(400, "reason_required");

    const { error } = await supabase.rpc("admin_close_room", { p_game: id, p_reason: reason });
    if (error) {
      if (error.message.includes("room_not_found")) throw new HttpError(404, "room_not_found");
      if (error.message.includes("room_not_active")) throw new HttpError(409, "room_not_active");
      if (error.message.includes("forbidden")) throw new HttpError(403, "forbidden");
      console.error("admin_close_room failed", { game: id, code: error.code, message: error.message });
      throw new HttpError(500, "update_failed");
    }
    return json({ ok: true });
  });
}
