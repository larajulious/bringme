import type { Metadata } from "next";
import Link from "next/link";
import { Clock, HardDrive, ImageIcon, ShieldCheck, Trash2 } from "lucide-react";

import { formatDateTime } from "@/components/admin/game-badges";
import { CleanupStatusBadge, PassStatusBadge } from "@/components/admin/image-badges";
import { ImageCleanupActions } from "@/components/admin/image-cleanup-actions";
import { ImageFilters } from "@/components/admin/image-filters";
import { ImageThumb } from "@/components/admin/image-thumb";
import { MetricCard } from "@/components/admin/metric-card";
import { Pagination } from "@/components/admin/pagination";
import { PageHeading } from "@/components/layout/dashboard-shell";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { REASON_LABEL, formatBytes } from "@/lib/admin/image-cleanup";
import { getImageCleanup } from "@/lib/admin/queries";
import { PAGE_SIZE, parseImageListParams } from "@/lib/admin/validation";
import { requireAdminPage } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Image cleanup" };

type RunDetails = {
  evaluated?: number; deleted?: number; skipped?: number; failed?: number; bytes_recovered?: number;
  failure_reasons?: Record<string, number>;
};

export default async function ImageCleanupPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; from?: string; to?: string; owner?: string; page?: string }>;
}) {
  await requireAdminPage();
  const params = parseImageListParams(await searchParams);
  const { status, from, to, owner, page } = params;
  const { summary, rows, total, history } = await getImageCleanup({ ...params, pageSize: PAGE_SIZE });
  const n = (v: number | undefined) => Number(v ?? 0);
  const filtered = Boolean(status || from || to || owner);

  return (
    <>
      <p className="mb-1 text-sm font-semibold text-muted-foreground">Storage Management</p>
      <PageHeading
        title="Image cleanup"
        description="Gameplay photos in storage. Photos under 7 days old, from active games, or whose host has an unexpired Game Pass are always protected. After 14 days, other photos can be deleted by a Super Admin."
      />

      <section aria-label="Storage totals" className="mb-6 grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-3">
        <MetricCard label="Total images" value={n(summary?.total_count)} icon={<ImageIcon />} />
        <MetricCard label="Storage used" value={n(summary?.total_bytes)} display={formatBytes(n(summary?.total_bytes))} icon={<HardDrive />} />
        <MetricCard label="Pending cleanup" value={n(summary?.pending_count)} accent="yellow" icon={<Clock />} hint="7–13 days old" />
        <MetricCard label="Eligible for deletion" value={n(summary?.eligible_count)} accent="coral" icon={<Trash2 />} hint="14+ days, no active pass" />
        <MetricCard label="Protected" value={n(summary?.protected_count)} accent="success" icon={<ShieldCheck />} />
        <MetricCard label="Recoverable space" value={n(summary?.eligible_bytes)} display={formatBytes(n(summary?.eligible_bytes))} accent="coral" />
      </section>

      <ImageCleanupActions eligibleCount={n(summary?.eligible_count)} eligibleBytes={n(summary?.eligible_bytes)} />

      <h2 className="mb-3 font-display text-lg font-bold">Images</h2>
      <ImageFilters status={status} from={from} to={to} owner={owner} />

      {rows.length === 0 ? (
        <EmptyState
          icon={<ImageIcon />}
          title={filtered ? "No images match" : "No images in storage"}
          description={filtered ? "Try a different filter." : "Gameplay photos appear here once players submit them."}
          action={filtered ? <Button asChild variant="outline"><Link href="/admin/storage">Clear filters</Link></Button> : undefined}
        />
      ) : (
        <>
          <div className="overflow-x-auto rounded-3xl border bg-card shadow-card">
            <table className="w-full min-w-[64rem] text-left text-sm">
              <caption className="sr-only">Stored gameplay images and their cleanup status, oldest first</caption>
              <thead className="bg-secondary text-secondary-foreground">
                <tr>
                  {["Image", "Game", "Owner", "Uploaded", "Age", "Pass status", "File size", "Cleanup status"].map((h) => (
                    <th key={h} scope="col" className="px-4 py-3 font-display font-semibold">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((r) => (
                  <tr key={r.object_name}>
                    <td className="px-4 py-3">
                      {r.thumbUrl ? (
                        <ImageThumb src={r.thumbUrl} title={r.game_title ?? "Unknown game"}
                          details={`${r.owner_name ?? r.owner_email ?? "Unknown owner"} · uploaded ${formatDateTime(r.uploaded_at)} · ${formatBytes(Number(r.bytes))}`} />
                      ) : (
                        <span className="grid size-14 place-items-center rounded-xl border bg-muted text-muted-foreground" title={r.object_name}>
                          <ImageIcon aria-hidden="true" className="size-5" /><span className="sr-only">No preview</span>
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {r.game_id && r.game_title ? (
                        <Link href={`/admin/games/${r.game_id}`} className="block max-w-56 break-words font-semibold text-primary underline-offset-4 hover:underline">{r.game_title}</Link>
                      ) : <span className="text-muted-foreground">Unknown game</span>}
                      {r.game_status ? <div className="text-muted-foreground">{r.game_status[0].toUpperCase() + r.game_status.slice(1)}</div> : null}
                    </td>
                    <td className="px-4 py-3">
                      {r.owner_id ? (
                        <>
                          <Link href={`/admin/subscribers/${r.owner_id}`} className="font-semibold text-primary underline-offset-4 hover:underline">{r.owner_name ?? r.owner_email ?? "Host"}</Link>
                          {r.owner_name && r.owner_email ? <div className="text-muted-foreground">{r.owner_email}</div> : null}
                        </>
                      ) : <span className="text-muted-foreground">Unknown owner</span>}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">{formatDateTime(r.uploaded_at)}</td>
                    <td className="px-4 py-3 tabular-nums whitespace-nowrap">{r.age_days == null ? "—" : `${r.age_days} ${r.age_days === 1 ? "day" : "days"}`}</td>
                    <td className="px-4 py-3"><PassStatusBadge status={r.pass_status} /></td>
                    <td className="px-4 py-3 tabular-nums whitespace-nowrap">{formatBytes(Number(r.bytes))}</td>
                    <td className="px-4 py-3">
                      <CleanupStatusBadge status={r.cleanup_status} />
                      <div className="mt-1 max-w-48 text-xs text-muted-foreground">{REASON_LABEL[r.reason] ?? r.reason}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination basePath="/admin/storage" params={{ status, from, to, owner }} page={page} pageSize={PAGE_SIZE} total={total} />
        </>
      )}

      <h2 className="mb-3 mt-10 font-display text-lg font-bold">Cleanup history</h2>
      {history.length === 0 ? (
        <p className="rounded-3xl border bg-card p-5 text-sm text-muted-foreground shadow-card">No cleanup has been run yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-3xl border bg-card shadow-card">
          <table className="w-full min-w-[48rem] text-left text-sm">
            <caption className="sr-only">Past cleanup runs, newest first</caption>
            <thead className="bg-secondary text-secondary-foreground">
              <tr>
                {["When", "Admin", "Evaluated", "Deleted", "Skipped", "Failed", "Recovered", "Failure reasons"].map((h) => (
                  <th key={h} scope="col" className="px-4 py-3 font-display font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {history.map((h) => {
                const d = (h.details ?? {}) as RunDetails;
                const reasons = Object.entries(d.failure_reasons ?? {});
                return (
                  <tr key={h.id}>
                    <td className="px-4 py-3 whitespace-nowrap">{formatDateTime(h.at)}</td>
                    <td className="px-4 py-3">{h.admin_email ?? <span className="text-muted-foreground">Unknown</span>}</td>
                    <td className="px-4 py-3 tabular-nums">{n(d.evaluated).toLocaleString("en-US")}</td>
                    <td className="px-4 py-3 tabular-nums">{n(d.deleted).toLocaleString("en-US")}</td>
                    <td className="px-4 py-3 tabular-nums">{n(d.skipped).toLocaleString("en-US")}</td>
                    <td className={`px-4 py-3 tabular-nums ${n(d.failed) ? "font-semibold text-destructive" : ""}`}>{n(d.failed).toLocaleString("en-US")}</td>
                    <td className="px-4 py-3 tabular-nums whitespace-nowrap">{formatBytes(n(d.bytes_recovered))}</td>
                    <td className="px-4 py-3 text-muted-foreground">{reasons.length ? reasons.map(([k, v]) => `${k} (${v})`).join(", ") : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
