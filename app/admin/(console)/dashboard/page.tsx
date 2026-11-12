import type { Metadata } from "next";
import Link from "next/link";
import { AlertTriangle, ArrowRight, DoorOpen, Gamepad2, Hourglass, PartyPopper, Ticket, Users, Wallet } from "lucide-react";
import type { ReactNode } from "react";

import { DailyBars, type ChartSeries } from "@/components/admin/daily-bars";
import { MetricCard } from "@/components/admin/metric-card";
import { PageHeading } from "@/components/layout/dashboard-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getActivity, getOverview } from "@/lib/admin/queries";
import { requireAdminPage } from "@/lib/auth/session";
import { formatMoney, parseCurrency } from "@/lib/billing/currency";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Admin dashboard" };

// Chart colours (validated with the dataviz validator: adjacent CVD ΔE 32, normal-vision ΔE 38, ≥3:1 on white).
const PURPLE = "#6d28d9";
const ORANGE = "#eb6834";
const DAYS = 30;

const money = (minor: number, c: string) => { const cur = parseCurrency(c); return cur ? formatMoney(Number(minor), cur) : `${minor} ${c}`; };

function Panel({ title, icon, aside, children }: { title: string; icon?: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <Card className="min-w-0">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">{icon}{title}</CardTitle>
        {aside}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export default async function AdminDashboardPage() {
  await requireAdminPage();
  const supabase = await createClient();
  const [o, rev, passes, activity] = await Promise.all([
    getOverview(), // live counts from the database
    supabase.rpc("admin_revenue"),
    supabase.rpc("admin_pass_counts"),
    getActivity(DAYS),
  ]);

  const production = (rev.data ?? []).filter((r) => r.environment === "production");
  const needsReview = production.reduce((n, r) => n + Number(r.needs_review), 0);
  const activePasses = (passes.data ?? []).reduce((n, p) => n + Number(p.active_now), 0);

  const other = Math.max(0, o.total_subscribers - o.active_subscribers - o.pending_subscribers - o.expired_subscribers);
  const segments = [
    { label: "Active", n: o.active_subscribers, color: "bg-brand-success", href: "/admin/subscribers?state=active" },
    { label: "Pending activation", n: o.pending_subscribers, color: "bg-brand-yellow", href: "/admin/subscribers?state=pending" },
    { label: "Expired", n: o.expired_subscribers, color: "bg-brand-coral", href: "/admin/subscribers?state=expired" },
    { label: "Suspended / deactivated", n: other, color: "bg-muted-foreground/50", href: "/admin/subscribers" },
  ];
  const completion = o.total_games ? Math.round((o.completed_games / o.total_games) * 100) : null;

  const attention: { key: string; icon: ReactNode; text: string; href: string }[] = [];
  if (o.pending_subscribers) attention.push({ key: "pending", icon: <Hourglass />, text: `${o.pending_subscribers} ${o.pending_subscribers === 1 ? "subscriber is" : "subscribers are"} waiting for activation`, href: "/admin/subscribers?state=pending" });
  if (needsReview) attention.push({ key: "review", icon: <AlertTriangle />, text: `${needsReview} ${needsReview === 1 ? "order needs" : "orders need"} review`, href: "/admin/revenue" });

  const signupSeries: ChartSeries[] = [{ key: "signups", label: "New subscribers", color: PURPLE }];
  const gameSeries: ChartSeries[] = [
    { key: "bring_me", label: "Bring Me", color: PURPLE },
    { key: "bingosnap", label: "BingoSnap", color: ORANGE },
  ];
  const sum = (pts: { values: Record<string, number> }[], k: string) => pts.reduce((a, p) => a + (p.values[k] ?? 0), 0);
  const signups30 = sum(activity.signups, "signups");
  const games30 = sum(activity.games, "bring_me") + sum(activity.games, "bingosnap");

  return (
    <>
      <PageHeading title="Overview" description="Live numbers and the last 30 days of activity on BringMe!" />

      {attention.length ? (
        <ul className="mb-6 grid gap-3 sm:grid-cols-2" aria-label="Needs attention">
          {attention.map((a) => (
            <li key={a.key}>
              <Link href={a.href} className="group flex items-center gap-3 rounded-2xl border-2 border-brand-yellow bg-brand-yellow/20 p-3 font-semibold transition-colors hover:bg-brand-yellow/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand-yellow text-brand-night [&_svg]:size-5">{a.icon}</span>
                <span className="min-w-0 flex-1">{a.text}</span>
                <ArrowRight aria-hidden="true" className="size-5 shrink-0 transition-transform motion-safe:group-hover:translate-x-0.5" />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-6 flex items-center gap-2 text-sm font-semibold text-muted-foreground" role="status">
          <PartyPopper aria-hidden="true" className="size-4 text-brand-success" /> All clear: nothing is waiting for you.
        </p>
      )}

      {/* 1. Headline numbers */}
      <section aria-label="Key numbers" className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Subscribers" value={o.total_subscribers} icon={<Users />} href="/admin/subscribers"
          hint={`${o.active_subscribers} active · ${o.pending_subscribers} pending`} />
        <MetricCard label="Game Passes active" value={activePasses} accent="yellow" icon={<Ticket />} hint="Paid, trial and complimentary" />
        <MetricCard label="Games created" value={o.total_games} accent="success" icon={<Gamepad2 />}
          hint={completion === null ? undefined : `${o.completed_games} completed (${completion}%)`} />
        <MetricCard label="Active rooms" value={o.active_rooms} accent="coral" icon={<DoorOpen />} hint="Lobby or live right now" />
      </section>

      {/* 2. Trends */}
      <section aria-labelledby="trends-h" className="mb-6">
        <h2 id="trends-h" className="sr-only">Last {DAYS} days</h2>
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="New subscribers" aside={<span className="text-sm text-muted-foreground"><strong className="text-foreground tabular-nums">{signups30}</strong> in {DAYS} days</span>}>
            <DailyBars points={activity.signups} series={signupSeries} label="New subscribers per day" />
          </Panel>
          <Panel title="Games created" aside={<span className="text-sm text-muted-foreground"><strong className="text-foreground tabular-nums">{games30}</strong> in {DAYS} days</span>}>
            <DailyBars points={activity.games} series={gameSeries} label="Games created per day, by type" />
          </Panel>
        </div>
      </section>

      {/* 3. Breakdown + money */}
      <section aria-labelledby="split-h" className="grid gap-4 lg:grid-cols-2">
        <h2 id="split-h" className="sr-only">Subscriber health and revenue</h2>
        <Panel title="Subscriber health" icon={<Users aria-hidden="true" className="size-5 text-primary" />}>
          {o.total_subscribers ? (
            <>
              <div role="img" aria-label={segments.map((x) => `${x.label} ${x.n}`).join(", ")} className="flex h-3 gap-0.5 overflow-hidden rounded-full bg-secondary">
                {segments.filter((x) => x.n > 0).map((x) => <span key={x.label} className={x.color} style={{ width: `${(x.n / o.total_subscribers) * 100}%` }} />)}
              </div>
              <ul className="mt-4 grid gap-1">
                {segments.map((x) => (
                  <li key={x.label}>
                    <Link href={x.href} className="flex items-center gap-3 rounded-xl px-2 py-1.5 text-sm transition-colors hover:bg-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
                      <span aria-hidden="true" className={`size-2.5 rounded-full ${x.color}`} />
                      <span className="flex-1 text-muted-foreground">{x.label}</span>
                      <span className="font-semibold tabular-nums">{x.n.toLocaleString("en-US")}</span>
                      <span className="w-12 text-right tabular-nums text-muted-foreground">{Math.round((x.n / o.total_subscribers) * 100)}%</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          ) : <p className="text-muted-foreground">No subscribers yet.</p>}
        </Panel>

        <Panel
          title="Revenue" icon={<Wallet aria-hidden="true" className="size-5 text-primary" />}
          aside={<Link href="/admin/revenue" className="inline-flex items-center gap-1 text-sm font-semibold text-primary underline-offset-4 hover:underline">Full report <ArrowRight aria-hidden="true" className="size-4" /></Link>}
        >
          {production.length ? (
            <div className="grid gap-6">
              {production.map((r) => {
                const cur = parseCurrency(r.currency);
                return (
                  <div key={r.currency}>
                    <p className="text-sm font-semibold text-muted-foreground">Net sales · {r.currency}</p>
                    <p className="font-display text-3xl font-bold tabular-nums text-primary">{money(r.net_minor, r.currency)}</p>
                    <p className="mb-3 text-sm text-muted-foreground">{r.paid_orders} paid {Number(r.paid_orders) === 1 ? "order" : "orders"}{r.refunded_orders ? ` · ${r.refunded_orders} refunded` : ""}. Last {DAYS} days:</p>
                    {cur ? <DailyBars points={activity.revenue.map((p) => ({ day: p.day, values: { net: p.values[cur] ?? 0 } }))} series={[{ key: "net", label: `Net sales (${cur})`, color: PURPLE }]} label={`Net sales per day in ${cur}`} currency={cur} /> : null}
                  </div>
                );
              })}
              <p className="text-xs text-muted-foreground">Production only; PHP and USD are never added together.</p>
            </div>
          ) : (
            <p className="text-muted-foreground">No production orders yet. Sandbox test payments are not counted here.</p>
          )}
        </Panel>
      </section>
    </>
  );
}
