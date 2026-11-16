import { HttpError, handle, json } from "@/lib/api/http";
import { CLEANUP_MAX_PER_RUN } from "@/lib/admin/image-cleanup";
import { requireSuperAdmin } from "@/lib/auth/guards";

/**
 * Preview Cleanup: what a delete run would remove right now, and why. Deletes nothing.
 * Runs under the admin's own session; the SQL functions re-check super_admin and classify.
 */
export async function GET() {
  return handle(async () => {
    const { supabase } = await requireSuperAdmin();
    const [summary, candidates] = await Promise.all([
      supabase.rpc("admin_image_summary"),
      supabase.rpc("admin_image_cleanup_candidates", { p_names: null, p_limit: CLEANUP_MAX_PER_RUN }),
    ]);
    if (summary.error || candidates.error) {
      console.error("image cleanup preview failed", { summary: summary.error?.code, candidates: candidates.error?.code });
      throw new HttpError(500, "preview_failed");
    }
    const s = summary.data?.[0];
    return json({
      evaluated: Number(s?.total_count ?? 0),
      eligibleCount: Number(s?.eligible_count ?? 0),
      eligibleBytes: Number(s?.eligible_bytes ?? 0),
      perRun: CLEANUP_MAX_PER_RUN,
      items: (candidates.data ?? []).map((c) => ({
        name: c.object_name, bytes: Number(c.bytes), uploadedAt: c.uploaded_at, ageDays: c.age_days,
        gameId: c.game_id, gameTitle: c.game_title, gameStatus: c.game_status,
        ownerId: c.owner_id, owner: c.owner_name ?? c.owner_email, passStatus: c.pass_status, passEndsAt: c.pass_ends_at,
      })),
    });
  });
}
