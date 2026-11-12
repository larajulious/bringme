import Link from "next/link";
import { Hourglass, Sparkles, Ticket, Users } from "lucide-react";

import { LocalDateTime, RemainingTime } from "@/components/subscription/remaining-time";
import { StartTrialButton } from "@/components/subscription/start-trial-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { GamePassSummary } from "@/lib/supabase/database.types";

export const TRIAL_ENDED_MESSAGE = "Your free trial has ended. Choose a 7-Day Game Pass to continue hosting.";
const PLANS_HREF = "/dashboard/subscription#plans";

/** Does this summary get its own card (instead of the generic restriction screen)? */
export function passStatusCovers(s: GamePassSummary | null): boolean {
  if (!s) return false;
  return s.state === "active" || s.trialEndedNoPass || (s.state === "pending" && s.trial.eligible);
}

function Fact({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2 text-sm text-foreground [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-primary">
      {icon}
      <span>{children}</span>
    </li>
  );
}

/**
 * Host's current access, from the database (my_game_pass_summary). Everything shown here is
 * informational: whether a game can be created or started is always decided by the server.
 */
export function PassStatus({ summary, showUpgrade = true }: { summary: GamePassSummary | null; showUpgrade?: boolean }) {
  if (!summary) return null;
  const s = summary;

  if (s.state === "active" && s.isTrial) {
    return (
      <Card className="border-brand-yellow/60" aria-labelledby="pass-status-h">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
          <CardTitle id="pass-status-h" className="flex items-center gap-3">
            <Sparkles aria-hidden="true" className="size-6 text-brand-coral" /> Free Trial Active
          </CardTitle>
          <Badge variant="yellow">Free</Badge>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end justify-between gap-5">
          <ul className="grid min-w-[15rem] flex-1 gap-2">
            <Fact icon={<Users aria-hidden="true" />}>Maximum <strong>3 players</strong> per game</Fact>
            {s.passEndsAt ? <Fact icon={<Hourglass aria-hidden="true" />}>Expires on <strong><LocalDateTime iso={s.passEndsAt} /></strong></Fact> : null}
            {s.passRemainingSeconds != null ? (
              <Fact icon={<Ticket aria-hidden="true" />}><RemainingTime seconds={s.passRemainingSeconds} className="font-semibold text-primary" /></Fact>
            ) : null}
          </ul>
          {showUpgrade ? (
            <Button asChild size="lg"><Link href={PLANS_HREF}>Upgrade Pass</Link></Button>
          ) : null}
        </CardContent>
      </Card>
    );
  }

  if (s.state === "active") {
    return (
      <Card aria-labelledby="pass-status-h">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
          <CardTitle id="pass-status-h" className="flex items-center gap-3">
            <Ticket aria-hidden="true" className="size-6 text-brand-coral" /> Active Game Pass: {s.planName ?? "7-Day Game Pass"}
          </CardTitle>
          <Badge variant="success">Active</Badge>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end justify-between gap-5">
          <ul className="grid min-w-[15rem] flex-1 gap-2">
            {s.maxPlayers ? <Fact icon={<Users aria-hidden="true" />}>Up to <strong>{s.maxPlayers} players</strong> per game</Fact> : null}
            {s.accessUntil ? <Fact icon={<Hourglass aria-hidden="true" />}>Expires on <strong><LocalDateTime iso={s.accessUntil} /></strong></Fact> : null}
            {s.accessRemainingSeconds != null ? (
              <Fact icon={<Ticket aria-hidden="true" />}><RemainingTime seconds={s.accessRemainingSeconds} className="font-semibold text-primary" /></Fact>
            ) : null}
          </ul>
          {showUpgrade ? (
            <Button asChild variant="outline"><Link href={PLANS_HREF}>Purchase Again</Link></Button>
          ) : null}
        </CardContent>
      </Card>
    );
  }

  if (s.trialEndedNoPass) {
    return (
      <Card className="border-brand-coral/50" aria-labelledby="pass-status-h">
        <CardHeader>
          <CardTitle id="pass-status-h" className="flex items-center gap-3">
            <Hourglass aria-hidden="true" className="size-6 text-brand-coral" /> Free trial ended
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-4">
          <p className="min-w-[15rem] flex-1 text-foreground">{TRIAL_ENDED_MESSAGE}</p>
          <Button asChild size="lg"><Link href={PLANS_HREF}>Buy Game Pass</Link></Button>
        </CardContent>
      </Card>
    );
  }

  if (s.state === "pending" && s.trial.eligible) {
    return (
      <Card aria-labelledby="pass-status-h">
        <CardHeader>
          <CardTitle id="pass-status-h" className="flex items-center gap-3">
            <Sparkles aria-hidden="true" className="size-6 text-brand-coral" /> Try BringMe! free for 7 days
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-4">
          <p className="min-w-[15rem] flex-1 text-muted-foreground">Host games for up to 3 players. No credit card needed, nothing renews.</p>
          <StartTrialButton />
        </CardContent>
      </Card>
    );
  }

  return null;
}
