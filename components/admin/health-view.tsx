import Link from "next/link";
import { AlertTriangle, ArrowRight, Camera, CheckCircle2, DoorOpen, ExternalLink, Info, Radio, Users } from "lucide-react";

import { AutoRefresh } from "@/components/admin/auto-refresh";
import { MetricCard } from "@/components/admin/metric-card";
import { UsageMeter } from "@/components/admin/usage-meter";
import { PageHeading } from "@/components/layout/dashboard-shell";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatBytes } from "@/lib/admin/image-cleanup";
import { IDLE_ROOM_MINUTES, assessUtilization, type Advice, type Level, type Limits, type Utilization } from "@/lib/admin/utilization";
import { cn } from "@/lib/utils";

const LEVEL: Record<Level, { title: string; body: string; className: string; icon: typeof CheckCircle2 }> = {
  ok: { title: "All good", body: "Everything has headroom. Players should get fast, smooth rounds.", className: "border-brand-success/40 bg-brand-success/10", icon: CheckCircle2 },
  watch: { title: "Keep an eye on it", body: "Nothing is hurting players yet, but something is trending toward a limit.", className: "border-brand-yellow bg-brand-yellow/20", icon: Info },
  act: { title: "Action recommended", body: "A limit is getting close. Act before the next busy game.", className: "border-brand-coral/50 bg-brand-coral/10", icon: AlertTriangle },
  urgent: { title: "Act now", body: "Players may already notice slowdowns. Start with the first item below.", className: "border-destructive/50 bg-destructive/10", icon: AlertTriangle },
};

const SEVERITY: Record<Advice["severity"], { label: string; variant: "secondary" | "yellow" | "coral" | "destructive" }> = {
  info: { label: "Info", variant: "secondary" },
  watch: { label: "Watch", variant: "yellow" },
  act: { label: "Act soon", variant: "coral" },
  urgent: { label: "Urgent", variant: "destructive" },
};

const idleLabel = (m: number) => (m < 1 ? "just now" : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`);
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" });

/** The Capacity & health page body (data in, markup out) so it renders the same from the page and in checks. */
export function HealthView({ u, limits, dashboard }: { u: Utilization; limits: Limits; dashboard: string | null }) {
  const { level, advice } = assessUtilization(u, limits);
  const banner = LEVEL[level];
  const BannerIcon = banner.icon;

  return (
    <>
      <PageHeading
        title="Capacity & health"
        description={`How close BringMe! is to the ${limits.plan} plan limits that affect players during a game, and what to do about it.`}
      />
      <div className="mb-5"><AutoRefresh checkedAt={u.checked_at} /></div>

      <section aria-labelledby="status-heading" className={cn("mb-6 rounded-3xl border-2 p-5 sm:p-6", banner.className)}>
        <div className="flex items-start gap-3">
          <BannerIcon aria-hidden="true" className="mt-0.5 size-6 shrink-0 text-foreground" />
          <div>
            <h2 id="status-heading" className="font-display text-xl font-bold">{banner.title}</h2>
            <p className="text-muted-foreground">{banner.body}</p>
          </div>
        </div>

        {advice.length > 0 ? (
          <ol className="mt-4 grid gap-3" aria-label="Recommended actions">
            {advice.map((a) => (
              <li key={a.id} className="rounded-2xl bg-card p-4 shadow-card">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={SEVERITY[a.severity].variant}>{SEVERITY[a.severity].label}</Badge>
                  <h3 className="font-display font-bold">{a.title}</h3>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{a.detail}</p>
                <p className="mt-2 text-sm"><strong>What to do:</strong> {a.action}</p>
                {a.href ? (
                  <Link href={a.href} className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-primary underline-offset-4 hover:underline">
                    Open <ArrowRight aria-hidden="true" className="size-4" />
                  </Link>
                ) : null}
              </li>
            ))}
          </ol>
        ) : null}
      </section>

      <h2 className="mb-3 font-display text-lg font-bold">Plan limits</h2>
      <section aria-label="Plan limits" className="mb-6 grid gap-3 sm:gap-4 md:grid-cols-2">
        <UsageMeter
          label="Live connections now (estimated)" used={u.est_connections} limit={limits.realtimeConnections}
          usedLabel={u.est_connections.toLocaleString("en-US")} limitLabel={limits.realtimeConnections.toLocaleString("en-US")}
          hint="players + host + presenter + TVs in open rooms"
        />
        <UsageMeter
          label="Busiest moment, last 7 days" used={u.peak_7d_connections} limit={limits.realtimeConnections}
          usedLabel={u.peak_7d_connections.toLocaleString("en-US")} limitLabel={limits.realtimeConnections.toLocaleString("en-US")}
          hint={u.peak_7d_at ? `on ${when(u.peak_7d_at)}` : "no games this week"}
        />
        <UsageMeter
          label="Photo storage" used={u.storage_bytes} limit={limits.storageBytes}
          usedLabel={formatBytes(u.storage_bytes)} limitLabel={formatBytes(limits.storageBytes)}
        />
        <UsageMeter
          label="Database size" used={u.db_bytes} limit={limits.dbBytes}
          usedLabel={formatBytes(u.db_bytes)} limitLabel={formatBytes(limits.dbBytes)}
        />
        <UsageMeter
          label="Database connections" used={u.db_connections} limit={u.db_max_connections}
          usedLabel={String(u.db_connections)} limitLabel={String(u.db_max_connections)}
          hint="includes Supabase's own services"
        />
      </section>

      <h2 className="mb-3 font-display text-lg font-bold">Right now</h2>
      <section aria-label="Activity right now" className="mb-6 grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <MetricCard label="Open rooms" value={u.open_rooms} icon={<DoorOpen />} href="/admin/rooms" hint="lobby or live" />
        <MetricCard label="Live games" value={u.live_rooms} accent="coral" icon={<Radio />} />
        <MetricCard label="Players in rooms" value={u.players_in_rooms} accent="success" icon={<Users />} />
        <MetricCard label="Photos, last 5 min" value={u.photos_last_5m} accent="yellow" icon={<Camera />} hint={`busiest minute this week: ${u.peak_photos_per_minute_7d}`} />
      </section>

      <h2 className="mb-3 font-display text-lg font-bold">Open rooms</h2>
      {u.rooms.length === 0 ? (
        <EmptyState icon={<DoorOpen />} title="No open rooms" description="Rooms appear here while they are in the lobby or live." />
      ) : (
        <div className="mb-6 overflow-x-auto rounded-3xl border bg-card shadow-card">
          <table className="w-full min-w-[44rem] text-left text-sm">
            <caption className="sr-only">Open rooms by size, with live connections and idle time</caption>
            <thead className="bg-secondary text-secondary-foreground">
              <tr>
                {["Room", "Status", "Players", "TV links", "Last activity"].map((h) => (
                  <th key={h} scope="col" className="px-4 py-3 font-display font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {u.rooms.map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-3">
                    <Link href={`/admin/games/${r.id}`} className="font-semibold text-primary underline-offset-4 hover:underline">{r.title}</Link>
                    {r.join_code ? <span className="ml-2 font-mono text-xs text-muted-foreground">{r.join_code}</span> : null}
                  </td>
                  <td className="px-4 py-3"><Badge variant={r.status === "live" ? "coral" : "secondary"}>{r.status === "live" ? "Live" : "Lobby"}</Badge></td>
                  <td className="px-4 py-3 tabular-nums">{r.players}{r.max_players ? ` / ${r.max_players}` : ""}</td>
                  <td className="px-4 py-3 tabular-nums">{r.tvs}</td>
                  <td className={cn("px-4 py-3", r.idle_minutes >= IDLE_ROOM_MINUTES && "font-semibold text-brand-coral")}>
                    {r.idle_minutes >= IDLE_ROOM_MINUTES ? "Idle " : ""}{idleLabel(r.idle_minutes)}{r.idle_minutes >= 1 ? " ago" : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section aria-labelledby="not-measured" className="rounded-3xl border bg-secondary/50 p-5 text-sm text-muted-foreground">
        <h2 id="not-measured" className="mb-1 font-display text-base font-bold text-foreground">Not measured here</h2>
        <p>
          Monthly bandwidth (egress), Realtime messages per second and monthly active users are only visible in Supabase. Check them before a big
          event. Limits shown assume the {limits.plan} plan; after upgrading, set <code className="font-mono text-xs">SUPABASE_REALTIME_MAX_CONNECTIONS</code>,{" "}
          <code className="font-mono text-xs">SUPABASE_DB_LIMIT_MB</code> and <code className="font-mono text-xs">SUPABASE_STORAGE_LIMIT_MB</code>.
        </p>
        {dashboard ? (
          <a href={dashboard} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 font-semibold text-primary underline-offset-4 hover:underline">
            Open Supabase dashboard <ExternalLink aria-hidden="true" className="size-4" /><span className="sr-only">(opens in a new tab)</span>
          </a>
        ) : null}
      </section>
    </>
  );
}
