import type { Metadata } from "next";
import Link from "next/link";
import { Users } from "lucide-react";

import { Pagination } from "@/components/admin/pagination";
import { SubscriberFilters } from "@/components/admin/subscriber-filters";
import { PageHeading } from "@/components/layout/dashboard-shell";
import { AccessBadge, formatDate } from "@/components/subscription/access-badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PAGE_SIZE, parseListParams } from "@/lib/admin/validation";
import { listSubscribers } from "@/lib/admin/queries";
import { requireAdminPage } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Subscribers" };

export default async function SubscribersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; state?: string; page?: string }>;
}) {
  await requireAdminPage();
  const { q, state, page } = parseListParams(await searchParams);
  const { rows, total } = await listSubscribers({ q, state, page, pageSize: PAGE_SIZE });
  const filtered = Boolean(q || state);

  return (
    <>
      <PageHeading title="Subscribers" description="Search, review and manage Game Master accounts." />
      <SubscriberFilters q={q} state={state} />

      {rows.length === 0 ? (
        <EmptyState
          icon={<Users />}
          title={filtered ? "No subscribers match" : "No subscribers yet"}
          description={filtered ? "Try a different search or status." : "New Game Master signups will appear here."}
          action={filtered ? <Button asChild variant="outline"><Link href="/admin/subscribers">Clear filters</Link></Button> : undefined}
        />
      ) : (
        <>
          <div className="overflow-x-auto rounded-3xl border bg-card shadow-card">
            <table className="w-full min-w-[44rem] text-left text-sm">
              <caption className="sr-only">Subscribers and their access status</caption>
              <thead className="bg-secondary text-secondary-foreground">
                <tr>
                  {["Subscriber", "Status", "Plan", "Ends", "Joined"].map((h) => (
                    <th key={h} scope="col" className="px-4 py-3 font-display font-semibold">{h}</th>
                  ))}
                  <th scope="col" className="px-4 py-3"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((s) => (
                  <tr key={s.user_id}>
                    <td className="px-4 py-3">
                      <div className="font-semibold">{s.display_name ?? "—"}</div>
                      <div className="text-muted-foreground">{s.email}</div>
                    </td>
                    <td className="px-4 py-3"><AccessBadge state={s.state} /></td>
                    <td className="px-4 py-3 capitalize">{s.plan_code ?? "—"}</td>
                    <td className="px-4 py-3">{formatDate(s.current_period_end)}</td>
                    <td className="px-4 py-3">{formatDate(s.joined_at)}</td>
                    <td className="px-4 py-3 text-right">
                      <Button asChild size="sm" variant="outline">
                        <Link href={`/admin/subscribers/${s.user_id}`}>
                          View<span className="sr-only"> {s.display_name ?? s.email}</span>
                        </Link>
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination basePath="/admin/subscribers" params={{ q, state }} page={page} pageSize={PAGE_SIZE} total={total} />
        </>
      )}
    </>
  );
}
