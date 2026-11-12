import Link from "next/link";
import { CalendarClock, Hourglass, Layers, Ticket, Users } from "lucide-react";

import { PassStatus, passStatusCovers } from "@/components/subscription/pass-status";
import { LocalDateTime, RemainingTime } from "@/components/subscription/remaining-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PASS_STATE_LABEL, SOURCE_LABEL } from "@/lib/game-pass/ui";
import type { GamePassSummary, PassTimelineEntry } from "@/lib/supabase/database.types";

const PLANS = "#plans";
const days = (s: number) => Math.round((s / 86_400) * 10) / 10;

function Row({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-primary">
      {icon}
      <div><dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</dt><dd className="font-semibold text-foreground">{children}</dd></div>
    </div>
  );
}

/** Host's current entitlement, from the database (never decided in the browser). */
export function CurrentPass({ summary, timeline }: { summary: GamePassSummary | null; timeline: PassTimelineEntry[] }) {
  if (!summary) return null;
  const s = summary;
  const upcoming = timeline.filter((t) => t.state === "queued" || t.state === "paused");

  if (s.state !== "active") {
    if (passStatusCovers(s)) return <PassStatus summary={s} showUpgrade={false} />;   // trial ended / start trial
    const expired = s.state === "expired";
    return (
      <Card aria-labelledby="current-h">
        <CardHeader>
          <CardTitle id="current-h" className="flex items-center gap-3">
            <Hourglass aria-hidden="true" className="size-6 text-brand-coral" /> {expired ? "Pass expired" : "No active Game Pass"}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-4">
          <p className="min-w-[15rem] flex-1 text-foreground">
            {expired ? "Your Game Pass has ended. Choose a 7-Day Game Pass to continue hosting." : "Buy a 7-Day Game Pass to start hosting."}
          </p>
          {s.state === "expired" || s.state === "pending" ? (
            <Button asChild size="lg"><Link href={PLANS}>{expired ? "Purchase Again" : "Buy Game Pass"}</Link></Button>
          ) : null}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card aria-labelledby="current-h">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
        <CardTitle id="current-h" className="flex items-center gap-3">
          <Ticket aria-hidden="true" className="size-6 text-brand-coral" /> Active Game Pass: {s.planName}
        </CardTitle>
        <div className="flex flex-wrap gap-2">
          <Badge variant="success">Active</Badge>
          {s.source ? <Badge variant="secondary">{SOURCE_LABEL[s.source]}</Badge> : null}
        </div>
      </CardHeader>
      <CardContent className="grid gap-6">
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Row icon={<Users aria-hidden="true" />} label="Maximum players">{s.maxPlayers} per game</Row>
          {s.passStartedAt ? <Row icon={<CalendarClock aria-hidden="true" />} label="Activated"><LocalDateTime iso={s.passStartedAt} /></Row> : null}
          {s.passEndsAt ? <Row icon={<Hourglass aria-hidden="true" />} label="Expires on"><LocalDateTime iso={s.passEndsAt} /></Row> : null}
          {s.passRemainingSeconds != null ? <Row icon={<Hourglass aria-hidden="true" />} label="Time remaining"><RemainingTime seconds={s.passRemainingSeconds} /></Row> : null}
          {s.accessUntil && s.accessUntil !== s.passEndsAt ? (
            <Row icon={<Layers aria-hidden="true" />} label="Hosting until (incl. queued passes)"><LocalDateTime iso={s.accessUntil} /></Row>
          ) : null}
        </dl>

        {upcoming.length ? (
          <div>
            <h3 className="mb-2 font-display text-base font-semibold text-primary">Queued passes</h3>
            <ul className="divide-y rounded-2xl border text-sm">
              {upcoming.map((t) => (
                <li key={t.pass_id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
                  <span className="font-semibold">{t.plan_name} · {t.max_players} players</span>
                  <span className="text-muted-foreground">
                    {t.state === "queued" && t.first_start ? <>Starts <LocalDateTime iso={t.first_start} /></> : `${days(t.remaining_seconds)} days left, resumes after the current pass`}
                  </span>
                  <Badge variant="secondary">{PASS_STATE_LABEL[t.state] ?? t.state}</Badge>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-3">
          <Button asChild><Link href={PLANS}>Upgrade Pass</Link></Button>
          <Button asChild variant="outline"><Link href={PLANS}>Purchase Again</Link></Button>
        </div>
      </CardContent>
    </Card>
  );
}
