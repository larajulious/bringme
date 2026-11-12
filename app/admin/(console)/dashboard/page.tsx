import type { Metadata } from "next";
import { CheckCircle2, Clock, DoorOpen, Gamepad2, Hourglass, Trophy, Users } from "lucide-react";

import { MetricCard } from "@/components/admin/metric-card";
import { PageHeading } from "@/components/layout/dashboard-shell";
import { getOverview } from "@/lib/admin/queries";
import { requireAdminPage } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Admin dashboard" };

export default async function AdminDashboardPage() {
  await requireAdminPage();
  const o = await getOverview(); // live counts from the database

  const other = o.suspended_subscribers + o.deactivated_subscribers;

  return (
    <>
      <PageHeading title="Overview" description="Live numbers from your BringMe! platform." />

      <section aria-labelledby="subs-h" className="mb-10">
        <h2 id="subs-h" className="mb-4 text-xl font-bold text-primary">Subscribers</h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard label="Total subscribers" value={o.total_subscribers} icon={<Users />}
            hint={other ? `${other} suspended or deactivated` : undefined} href="/admin/subscribers" />
          <MetricCard label="Active" value={o.active_subscribers} accent="success" icon={<CheckCircle2 />} href="/admin/subscribers?state=active" />
          <MetricCard label="Pending activation" value={o.pending_subscribers} accent="yellow" icon={<Hourglass />}
            hint={o.pending_subscribers ? "Waiting for you" : undefined} href="/admin/subscribers?state=pending" />
          <MetricCard label="Expired" value={o.expired_subscribers} accent="coral" icon={<Clock />} href="/admin/subscribers?state=expired" />
        </div>
      </section>

      <section aria-labelledby="games-h">
        <h2 id="games-h" className="mb-4 text-xl font-bold text-primary">Games</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <MetricCard label="Games created" value={o.total_games} icon={<Gamepad2 />} />
          <MetricCard label="Completed" value={o.completed_games} accent="success" icon={<Trophy />} />
          <MetricCard label="Active rooms" value={o.active_rooms} accent="coral" icon={<DoorOpen />} hint="Lobby or live right now" />
        </div>
      </section>
    </>
  );
}
