import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Gamepad2 } from "lucide-react";

import { Pagination } from "@/components/admin/pagination";
import { PassRevoke } from "@/components/admin/pass-revoke";
import { SubscriberActions } from "@/components/admin/subscriber-actions";
import { PurchaseHistory, type PurchaseRow } from "@/components/subscription/purchase-history";
import { PageHeading } from "@/components/layout/dashboard-shell";
import { AccessBadge, formatDate } from "@/components/subscription/access-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { getSubscriberDetail, listPlans } from "@/lib/admin/queries";
import { isUuid } from "@/lib/api/http";
import { requireAdminPage } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Subscriber" };
const GAMES_PAGE_SIZE = 10;

const SOURCE_LABEL = { trial: "Free trial", purchase: "Purchased", admin_grant: "Complimentary", legacy_subscription: "Legacy access" } as const;
const TRIAL_REASON: Record<string, string> = {
  trial_already_used: "Trial already used", has_paid_history: "Not eligible (has purchases / legacy access)",
  has_pass_history: "Not eligible (had a manual grant)", email_unconfirmed: "Email not confirmed yet",
  suspended: "Not eligible while suspended", deactivated: "Not eligible (deactivated)",
};

export default async function SubscriberDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  await requireAdminPage();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const n = Number.parseInt((await searchParams).page ?? "1", 10);
  const gamesPage = Number.isFinite(n) && n >= 1 && n <= 10_000 ? n : 1;

  const [detail, plans] = await Promise.all([getSubscriberDetail(id, gamesPage, GAMES_PAGE_SIZE), listPlans()]);
  if (!detail.profile || detail.profile.role !== "subscriber" || !detail.access) notFound();
  const { profile, access, passes, games, gameTotal, purchases, audit, trial } = detail;
  const label = profile.display_name ?? profile.email ?? "this subscriber";

  return (
    <>
      <p className="mb-3 text-sm">
        <Link href="/admin/subscribers" className="font-semibold text-primary underline-offset-4 hover:underline">← All subscribers</Link>
      </p>
      <PageHeading title={label} description={profile.email ?? undefined} />

      <div className="mb-6 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <span className="flex items-center gap-2 font-semibold">Status <AccessBadge state={access.state} /></span>
        <span><span className="font-semibold">Plan:</span> <span className="capitalize">{access.plan_code ?? "—"}</span></span>
        <span><span className="font-semibold">Ends:</span> {formatDate(access.current_period_end)}</span>
        <span><span className="font-semibold">Joined:</span> {formatDate(profile.created_at)}</span>
        <span><span className="font-semibold">Free trial:</span> {trial ? (trial.eligible ? "Eligible (not used yet)" : TRIAL_REASON[trial.reason ?? ""] ?? trial.reason) : "—"}</span>
      </div>

      <SubscriberActions
        userId={profile.id}
        label={label}
        state={access.state}
        currentPlanCode={access.plan_code}
        currentEnd={access.current_period_end}
        plans={plans.filter((p) => p.is_active).map((p) => ({ code: p.code, name: p.name }))}
      />

      <section aria-labelledby="games-h" className="mt-10">
        <h2 id="games-h" className="mb-4 text-xl font-bold text-primary">Games ({gameTotal})</h2>
        {games.length === 0 ? (
          <EmptyState icon={<Gamepad2 />} title="No games yet" description="Games created by this subscriber will be listed here." />
        ) : (
          <>
            <div className="overflow-x-auto rounded-3xl border bg-card shadow-card">
              <table className="w-full min-w-[34rem] text-left text-sm">
                <caption className="sr-only">Games created by {label}</caption>
                <thead className="bg-secondary text-secondary-foreground">
                  <tr>{["Title", "Status", "Code", "Max players", "Created"].map((h) => (
                    <th key={h} scope="col" className="px-4 py-3 font-display font-semibold">{h}</th>))}</tr>
                </thead>
                <tbody className="divide-y">
                  {games.map((g) => (
                    <tr key={g.id}>
                      <td className="px-4 py-3 font-semibold">{g.title}</td>
                      <td className="px-4 py-3"><Badge variant={g.status === "live" ? "coral" : g.status === "finished" ? "success" : "secondary"}>{g.status}</Badge></td>
                      <td className="px-4 py-3 font-mono">{g.join_code}</td>
                      <td className="px-4 py-3">{g.max_players}</td>
                      <td className="px-4 py-3">{formatDate(g.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination basePath={`/admin/subscribers/${id}`} params={{}} page={gamesPage} pageSize={GAMES_PAGE_SIZE} total={gameTotal} />
          </>
        )}
      </section>

      <section aria-labelledby="hist-h" className="mt-10">
        <Card>
          <CardHeader><CardTitle id="hist-h">Game Pass history (entitlements)</CardTitle></CardHeader>
          <CardContent>
            {passes.length === 0 ? (
              <p className="text-muted-foreground">No Game Pass has been granted yet.</p>
            ) : (
              <ul className="divide-y text-sm">
                {passes.map((p) => (
                  <li key={p.pass_id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span className="font-semibold">
                      {p.plan_name} <span className="font-normal text-muted-foreground">· {SOURCE_LABEL[p.source]}</span>
                    </span>
                    <span className="text-muted-foreground">
                      {p.first_start ? `${formatDate(p.first_start)} → ${formatDate(p.last_end)}` : "Not started"}
                    </span>
                    <span className="flex items-center gap-2">
                      <Badge variant="secondary">{p.state}</Badge>
                      {["active", "queued", "paused"].includes(p.state) ? <PassRevoke userId={profile.id} passId={p.pass_id} label={`${p.plan_name} pass`} /> : null}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </section>
      <section aria-labelledby="purchases-h" className="mt-10">
        <h2 id="purchases-h" className="mb-4 text-xl font-bold text-primary">Purchase History</h2>
        <PurchaseHistory rows={purchases as PurchaseRow[]} emptyText="No purchases." />
      </section>

      <section aria-labelledby="audit-h" className="mt-10">
        <Card>
          <CardHeader><CardTitle id="audit-h">Audit history</CardTitle></CardHeader>
          <CardContent>
            {audit.length === 0 ? <p className="text-muted-foreground">No events yet.</p> : (
              <ul className="divide-y text-sm">
                {audit.map((e) => (
                  <li key={e.id} className="flex flex-wrap justify-between gap-2 py-2">
                    <span><span className="font-semibold">{e.action.replaceAll("_", " ")}</span> <span className="text-muted-foreground">by {e.actor_kind}</span></span>
                    <span className="text-muted-foreground">{formatDate(e.at)} UTC</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </section>
    </>
  );
}
