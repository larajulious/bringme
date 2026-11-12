import type { Metadata } from "next";
import { Layers } from "lucide-react";

import { PlanEditor, PlanStatusToggle } from "@/components/admin/plan-editor";
import { PlanSyncEditor, SyncActions } from "@/components/admin/plan-sync-editor";
import { PriceEditor } from "@/components/admin/price-editor";
import { PageHeading } from "@/components/layout/dashboard-shell";
import { formatDate } from "@/components/subscription/access-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { listPlans } from "@/lib/admin/queries";
import { requireAdminPage } from "@/lib/auth/session";
import { PAID_PLAN_CODES, parseCatalogEnv, publicBillingState, type PaidPlanCode } from "@/lib/billing/config";
import { formatMoney } from "@/lib/billing/currency";
import { getBillingConfig } from "@/lib/billing/polar";
import { SYNC_LABEL, type SyncState } from "@/lib/billing/price-sync";
import { getPriceSync } from "@/lib/billing/price-sync-server";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Plans" };

function PriceCell({ minor, currency, sync, trial }: { minor: number | null; currency: "PHP" | "USD"; sync?: SyncState; trial: boolean }) {
  if (trial) return <span className="font-semibold">Free</span>;
  if (minor == null) return <span className="text-muted-foreground">Not set</span>;
  const ok = sync === "ok";
  return (
    <div>
      <div className="font-semibold">{formatMoney(minor, currency)}</div>
      {sync ? (
        <Badge variant={ok ? "success" : sync === "not_configured" ? "secondary" : "coral"} className="mt-1 normal-case tracking-normal" title={SYNC_LABEL[sync]}>
          {ok ? "Polar ✓" : sync === "not_configured" ? "No product" : sync === "unknown" ? "Unchecked" : "Needs sync"}
        </Badge>
      ) : null}
    </div>
  );
}

export default async function PlansPage() {
  await requireAdminPage();
  const supabase = await createClient();
  const catalog = parseCatalogEnv(process.env);
  const env = catalog.enabled ? catalog.environment : null;
  const [plans, prices, audit, states, jobs] = await Promise.all([
    listPlans(),
    supabase.from("plan_prices").select("plan_id, currency, amount_minor").eq("is_active", true),
    supabase.from("admin_audit_events").select("id, at, action, target, details").order("at", { ascending: false }).limit(10),
    supabase.from("plan_polar_state").select("*"),
    supabase.from("plan_sync_jobs").select("id, plan_id, environment, status, stage, last_error, updated_at").in("status", ["pending", "polar_applied", "failed"]),
  ]);
  const stateOf = (planId: string) => (states.data ?? []).find((s) => s.plan_id === planId && s.environment === env) ?? null;
  const openJob = (planId: string) => (jobs.data ?? []).find((j) => j.plan_id === planId && (j.environment ?? null) === env) ?? null;
  const priceOf = (planId: string, c: "PHP" | "USD") => prices.data?.find((x) => x.plan_id === planId && x.currency === c)?.amount_minor ?? null;

  const config = getBillingConfig();
  const billing = publicBillingState(config);
  const paid = plans.filter((p) => (PAID_PLAN_CODES as readonly string[]).includes(p.code));
  const local = Object.fromEntries(paid.map((p) => [p.code, Object.fromEntries((["PHP", "USD"] as const).flatMap((c) => {
    const v = priceOf(p.id, c); return v == null ? [] : [[c, v]];
  }))]));
  const sync = await getPriceSync(local, config);
  const needsSync = Object.values(sync).some((s) => Object.values(s ?? {}).some((x) => x !== "ok" && x !== "not_configured"));

  return (
    <>
      <PageHeading title="Game Pass plans" description="7-Day Game Passes: one-time purchases, no automatic renewal. Capacity and limits apply to new passes; sold passes keep theirs." />
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <PlanEditor />
        <Badge variant={billing.checkout ? (billing.environment === "production" ? "success" : "yellow") : "secondary"}>
          Checkout: {billing.checkout ? `on (${billing.environment})` : "off"}
        </Badge>
      </div>

      {needsSync ? (
        <p role="status" className="mb-5 rounded-2xl border border-brand-coral/40 bg-brand-coral/10 px-4 py-3 text-sm">
          <strong>Needs sync:</strong> at least one price here differs from what Polar would charge. Those prices are <strong>not offered for checkout</strong> until the Polar product is updated to the same amount (POLAR_PRODUCT_SETUP.md §6). Editing a price here never changes Polar.
        </p>
      ) : null}

      {plans.length === 0 ? (
        <EmptyState icon={<Layers />} title="No plans yet" description="Create your first plan." />
      ) : (
        <div className="overflow-x-auto rounded-3xl border bg-card shadow-card">
          <table className="w-full min-w-[64rem] text-left text-sm">
            <caption className="sr-only">Game Pass plans</caption>
            <thead className="bg-secondary text-secondary-foreground">
              <tr>
                {["Plan", "Players", "PHP", "USD", "Duration", "Status", "Polar sync"].map((h) => (
                  <th key={h} scope="col" className="px-4 py-3 font-display font-semibold">{h}</th>
                ))}
                <th scope="col" className="px-4 py-3 text-right font-display font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {plans.map((p) => {
                const s = sync[p.code as PaidPlanCode];
                return (
                  <tr key={p.id}>
                    <td className="px-4 py-3">
                      <div className="font-semibold">{p.name}</div>
                      <div className="font-mono text-xs text-muted-foreground">{p.code}{p.is_trial ? " · automatic for new hosts" : ""}</div>
                      <div className="text-xs text-muted-foreground">{p.max_active_games} open at once · {p.max_rounds_per_game} rounds · {p.max_games_per_period ?? "unlimited"} games/pass</div>
                    </td>
                    <td className="px-4 py-3 font-semibold">{p.max_players_per_game}</td>
                    <td className="px-4 py-3"><PriceCell minor={priceOf(p.id, "PHP")} currency="PHP" sync={s?.PHP} trial={p.is_trial} /></td>
                    <td className="px-4 py-3"><PriceCell minor={priceOf(p.id, "USD")} currency="USD" sync={s?.USD} trial={p.is_trial} /></td>
                    <td className="px-4 py-3">{Math.round(p.duration_seconds / 86_400)} days</td>
                    <td className="px-4 py-3">
                      <Badge variant={p.is_active ? "success" : "secondary"}>{p.is_active ? "Available" : "Unavailable"}</Badge>
                      {p.is_trial ? <div className="mt-1 text-xs text-muted-foreground">{p.is_active ? "New hosts get the trial" : "No new trials"}</div> : null}
                    </td>
                    <td className="px-4 py-3">
                      {(() => {
                        if (p.is_trial) return <span className="text-xs text-muted-foreground">Internal (no Polar product)</span>;
                        if (!(PAID_PLAN_CODES as readonly string[]).includes(p.code)) return <span className="text-xs text-muted-foreground">Not sold online</span>;
                        const st = stateOf(p.id);
                        const job = openJob(p.id);
                        const mapped = catalog.enabled && catalog.products[p.code as PaidPlanCode];
                        const label = job?.status === "pending" ? "Syncing…" : job?.status === "polar_applied" ? "Polar updated, local save failed"
                          : job?.status === "failed" ? "Sync failed" : !mapped ? "No Polar product" : st?.status === "in_sync" ? "In sync"
                          : st?.status === "out_of_sync" ? "Changed in Polar" : st ? st.status.replaceAll("_", " ") : "Not checked";
                        const good = !job && st?.status === "in_sync";
                        return (
                          <div className="grid gap-1 text-xs">
                            <Badge variant={good ? "success" : job || st?.status === "out_of_sync" ? "coral" : "secondary"} className="w-fit normal-case tracking-normal">{label}</Badge>
                            {st?.last_synced_at ? <span className="text-muted-foreground">Last synced {formatDate(st.last_synced_at)} UTC</span> : null}
                            {job?.last_error || st?.last_error ? <span className="text-destructive">{job?.last_error ?? st?.last_error}</span> : null}
                            <SyncActions planId={p.id} retryJobId={job && job.status !== "pending" ? job.id : null} canCheck={Boolean(mapped)} />
                          </div>
                        );
                      })()}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        {(PAID_PLAN_CODES as readonly string[]).includes(p.code) ? (
                          <>
                            <PlanSyncEditor plan={p} php={priceOf(p.id, "PHP")} usd={priceOf(p.id, "USD")} />
                            <PlanEditor plan={p} limitsOnly />
                          </>
                        ) : (
                          <>
                            <PlanEditor plan={p} />
                            <PriceEditor planId={p.id} planName={p.name} php={priceOf(p.id, "PHP")} usd={priceOf(p.id, "USD")} isTrial={p.is_trial} />
                          </>
                        )}
                        <PlanStatusToggle plan={p} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Card className="mt-8">
        <CardHeader><CardTitle>Recent plan changes</CardTitle></CardHeader>
        <CardContent>
          {(audit.data ?? []).length === 0 ? <p className="text-muted-foreground">No changes recorded yet.</p> : (
            <ul className="divide-y text-sm">
              {(audit.data ?? []).map((e) => (
                <li key={e.id} className="flex flex-wrap justify-between gap-2 py-2">
                  <span><span className="font-semibold">{e.action.replaceAll("_", " ")}</span> · <span className="font-mono">{e.target}</span></span>
                  <span className="text-muted-foreground">{formatDate(e.at)} UTC</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}
