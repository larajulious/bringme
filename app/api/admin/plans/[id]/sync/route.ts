import type { NextRequest } from "next/server";

import { HttpError, handle, isUuid, json, readJson } from "@/lib/api/http";
import { parsePlanSyncInput } from "@/lib/admin/validation";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { parseCatalogEnv, type PaidPlanCode } from "@/lib/billing/config";
import { getPolarProduct, patchPolarProduct, PolarError } from "@/lib/billing/polar";
import { invalidatePriceSync } from "@/lib/billing/price-sync-server";
import { productProblem, readPolarProduct, summarize, syncPlan, type Requested, type SyncResult } from "@/lib/billing/product-sync";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/database.types";

/**
 * Super admin: edit a paid plan and synchronise it to Polar (lib/billing/product-sync.ts).
 *   { name, maxPlayers, phpMinor, usdMinor }  -> edit (Polar first, verified, then local)
 *   { action: "retry", jobId }                 -> retry a failed / half-done sync (never duplicates prices)
 *   { action: "check" }                        -> read Polar and record in/out of sync (no writes to Polar)
 * Success is reported only when Polar AND BringMe! are confirmed.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { userId: adminId } = await requireSuperAdmin();
    const { id } = await params;
    if (!isUuid(id)) throw new HttpError(400, "invalid_plan");
    const body = await readJson(request);

    const db = createAdminClient();
    const { data: plan } = await db.from("subscription_plans").select("id, code, is_trial").eq("id", id).maybeSingle();
    if (!plan) throw new HttpError(404, "plan_not_found");
    if (plan.is_trial) throw new HttpError(400, "trial_is_internal");

    const catalog = parseCatalogEnv(process.env);
    const productId = catalog.enabled ? catalog.products[plan.code as PaidPlanCode] : undefined;
    const polar = catalog.enabled && productId ? { environment: catalog.environment, organizationId: catalog.organizationId, productId } : null;

    if (body.action === "check") {
      if (!catalog.enabled || !productId) throw new HttpError(409, "polar_not_configured");
      const p = readPolarProduct(await getPolarProduct(catalog, productId).catch(() => { throw new HttpError(502, "polar_unreachable"); }));
      if (!p) throw new HttpError(404, "polar_product_not_found");
      const problem = productProblem(p, catalog.organizationId);
      const { data, error } = await db.rpc("record_polar_product_state", {
        p_environment: catalog.environment, p_plan_code: plan.code, p_product: { ...summarize(p), ...(problem ? { problem } : {}) } as Json,
      });
      if (error) throw new HttpError(500, "check_failed");
      invalidatePriceSync();
      return json({ status: data });
    }

    let requested: Requested;
    let begin: () => Promise<string>;
    if (body.action === "retry") {
      if (!isUuid(body.jobId)) throw new HttpError(400, "invalid_job");
      const { data, error } = await db.rpc("admin_retry_plan_sync", { p_admin: adminId, p_job: body.jobId as string });
      if (error) throw new HttpError(409, error.message.includes("sync_in_progress") ? "sync_in_progress" : "job_not_retryable");
      const job = data as { plan_id: string; requested: { name: string; max_players: number; php_minor: number; usd_minor: number } };
      if (job.plan_id !== id) throw new HttpError(400, "invalid_job");
      requested = { name: job.requested.name, maxPlayers: job.requested.max_players, phpMinor: job.requested.php_minor, usdMinor: job.requested.usd_minor };
      begin = async () => body.jobId as string;
    } else {
      const parsed = parsePlanSyncInput(body);
      if (!parsed.ok) throw new HttpError(400, parsed.error);
      requested = parsed.value;
      begin = async () => {
        const { data, error } = await db.rpc("admin_begin_plan_sync", {
          p_admin: adminId, p_plan: id, p_environment: polar?.environment ?? null, p_product_id: polar?.productId ?? null,
          p_requested: { name: requested.name, max_players: requested.maxPlayers, php_minor: requested.phpMinor, usd_minor: requested.usdMinor },
        });
        if (error) {
          // PGRST202 = function not found: migration 20261112000014 isn't applied to this database.
          if (error.code === "PGRST202" || /admin_begin_plan_sync/.test(error.message)) throw new HttpError(503, "sync_not_installed");
          throw new HttpError(409, error.message.includes("sync_in_progress") ? "sync_in_progress" : "sync_start_failed");
        }
        return data as string;
      };
    }

    const result: SyncResult = await syncPlan({
      polar,
      begin,
      fetchProduct: (pid) => getPolarProduct(catalog.enabled ? catalog : { apiBase: "", accessToken: "" }, pid),
      patchProduct: (pid, patch) => patchPolarProduct(catalog.enabled ? catalog : { apiBase: "", accessToken: "" }, pid, patch)
        .catch((e) => { throw new Error(e instanceof PolarError ? e.code : "polar_error"); }),
      async finish(jobId, s) {
        const { error } = await db.rpc("admin_finish_plan_sync", { p_admin: adminId, p_job: jobId, p_polar: s as Json });
        if (error) throw new Error(`local_save_failed: ${error.message.slice(0, 120)}`);
      },
      async fail(jobId, stage, err, s) {
        await db.rpc("admin_fail_plan_sync", { p_admin: adminId, p_job: jobId, p_stage: stage, p_error: err, p_polar: (s ?? null) as Json });
      },
    }, plan.code, requested);

    invalidatePriceSync();
    if (result.status === "synced" || result.status === "local_only") return json(result);
    console.warn("[admin:plan-sync]", JSON.stringify({ plan: plan.code, status: result.status, stage: "stage" in result ? result.stage : "local_save" }));
    return json(result, 502);
  });
}
