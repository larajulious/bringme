import type { NextRequest } from "next/server";

import { HttpError, handle, json, readJson } from "@/lib/api/http";
import { CLEANUP_BUCKET, runImageCleanup } from "@/lib/admin/image-cleanup";
import { requireSuperAdmin } from "@/lib/auth/guards";
import type { Json } from "@/lib/supabase/database.types";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Delete Eligible Images (Super Admin only, manual, explicit confirmation).
 * - Eligibility is re-evaluated by the database immediately before every Storage batch.
 * - Objects are deleted ONLY through the Storage API (service role, server-side), never by deleting rows.
 * - The database then verifies which objects are gone, marks those submissions and writes the audit event.
 * Safe to retry: anything not deleted stays eligible and is picked up by the next run.
 */
export async function POST(request: NextRequest) {
  return handle(async () => {
    const { supabase, userId } = await requireSuperAdmin();
    const body = await readJson(request);
    if (body.confirm !== "delete_permanently") throw new HttpError(400, "confirmation_required");

    const storage = createAdminClient().storage.from(CLEANUP_BUCKET); // authorized above; scoped to this bucket
    const report = await runImageCleanup({
      async countImages() {
        const { data, error } = await supabase.rpc("admin_image_summary");
        if (error) throw new HttpError(500, "cleanup_failed");
        return Number(data?.[0]?.total_count ?? 0);
      },
      async candidates(names, limit) {
        const { data, error } = await supabase.rpc("admin_image_cleanup_candidates", { p_names: names, p_limit: limit });
        if (error) throw new Error("revalidation_failed");
        return (data ?? []).map((c) => ({ object_name: c.object_name, bytes: Number(c.bytes) }));
      },
      async remove(paths) {
        const { data, error } = await storage.remove(paths);
        if (error) {
          console.error("image cleanup: storage remove failed", { count: paths.length, message: error.message });
          throw new Error("storage_error");
        }
        return (data ?? []).map((o) => o.name);
      },
      async record(evaluated, skipped, attempted) {
        const { data, error } = await supabase.rpc("admin_record_image_cleanup", {
          p_evaluated: evaluated, p_skipped: skipped, p_attempted: attempted as unknown as Json,
        });
        if (error || !data?.[0]) {
          // Deletions may already have happened; the next run's record step repairs the references.
          console.error("image cleanup: record failed", { admin: userId, attempted: attempted.length, code: error?.code });
          throw new HttpError(500, "cleanup_record_failed");
        }
        const r = data[0];
        return { ...r, bytes_recovered: Number(r.bytes_recovered), failed_items: r.failed_items ?? [] };
      },
    });
    return json(report);
  });
}
