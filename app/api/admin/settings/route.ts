import type { NextRequest } from "next/server";

import { HttpError, handle, json, readJson } from "@/lib/api/http";
import { parseSettingsInput } from "@/lib/admin/validation";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { createAdminClient } from "@/lib/supabase/admin";

/** Update platform settings (single row). A DB trigger syncs the photo size limit to Storage. */
export async function PUT(request: NextRequest) {
  return handle(async () => {
    await requireSuperAdmin();
    const parsed = parseSettingsInput(await readJson(request));
    if (!parsed.ok) throw new HttpError(400, parsed.error);

    const { error } = await createAdminClient()
      .from("platform_settings")
      .update(parsed.value)
      .eq("id", true);
    if (error) throw new HttpError(500, "update_failed");
    return json({ ok: true });
  });
}
