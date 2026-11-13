"use client";

import { Clock, DoorClosed, Hourglass, QrCode, Timer, Trophy, type LucideIcon } from "lucide-react";
import { useState } from "react";

import type { HostSnapshot } from "@/lib/game/types";
import { cn } from "@/lib/utils";

export type OnScreen = { key: string; Icon: LucideIcon; title: string; detail?: string };

/**
 * "What the audience sees right now" for the host. The dashboards are for managing the game; the
 * presenter screen shows it. This chip mirrors that screen in words and replays a short
 * transform/opacity animation whenever it changes, so a host who is looking at their own
 * screen (or the players) still knows the effect of the button they just pressed.
 * At rest (and with reduced motion) it is simply a static label.
 */
export function OnScreenNow({ screen, className }: { screen: OnScreen; className?: string }) {
  const [seen, setSeen] = useState(screen.key);
  const [changes, setChanges] = useState(0);
  if (seen !== screen.key) { setSeen(screen.key); setChanges((c) => c + 1); }
  const fresh = changes > 0;
  const { Icon } = screen;

  return (
    <section aria-label="On the presenter screen" className={cn("flex items-center gap-4 rounded-3xl border bg-card p-4 shadow-card", className)}>
      <div className="relative shrink-0">
        {fresh ? <span key={`ring-${changes}`} aria-hidden="true" className="absolute inset-0 animate-tick-ring rounded-2xl border-4 border-brand-yellow motion-reduce:hidden" /> : null}
        <div key={`tile-${changes}`} className={cn("grid size-14 place-items-center rounded-2xl bg-brand-yellow text-brand-night", fresh && "animate-bounce-in motion-reduce:animate-none")}>
          <Icon aria-hidden="true" className="size-7" />
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">On the presenter screen</p>
        <p key={`title-${changes}`} className={cn("truncate font-display text-xl font-bold text-primary", fresh && "animate-pop-in motion-reduce:animate-none")}>{screen.title}</p>
        {screen.detail ? <p className="break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">{screen.detail}</p> : null}
      </div>
      <p className="sr-only" role="status" aria-live="polite">{fresh ? `Presenter screen now shows: ${screen.title}` : ""}</p>
    </section>
  );
}

/** What /present/[id] shows for a Bring Me game in this state (mirrors components/game/presenter-screen.tsx). */
export function bringMeOnScreen(s: HostSnapshot): OnScreen {
  const r = s.round;
  if (s.status === "canceled") return { key: "ended", Icon: DoorClosed, title: "Game ended" };
  if (s.status === "finished") return { key: "final", Icon: Trophy, title: "Final results", detail: "Champion and every round's winner" };
  if (s.phase === "lobby" && s.status === "lobby") {
    return { key: "join", Icon: QrCode, title: "Join screen", detail: `QR code and room ${s.joinCode ?? ""} · ${s.playerCount} joined`.replace("room  ·", "room ·") };
  }
  const roundNo = r?.no ?? s.totalRounds - s.roundsRemaining + 1;
  if (s.phase === "countdown") return { key: `count:${roundNo}`, Icon: Clock, title: "Countdown", detail: `Round ${roundNo} of ${s.totalRounds}` };
  if (s.phase === "active" && r) {
    return r.status === "closed"
      ? { key: `closed:${r.no}`, Icon: Timer, title: "Time's up", detail: `${s.submissionCount} ${s.submissionCount === 1 ? "photo" : "photos"} in` }
      : { key: `live:${r.no}`, Icon: Timer, title: `Round ${r.no}: the item and timer`, detail: `Bring me… ${r.prompt}` };
  }
  if (s.phase === "reviewing") return { key: `review:${r?.no}`, Icon: Hourglass, title: "Judging time!", detail: r?.prompt ? `Does it show ${r.prompt}?` : undefined };
  if (s.phase === "winner_announced" && r) {
    return { key: `winner:${r.no}`, Icon: Trophy, title: r.winnerName ? `Winner: ${r.winnerName}` : "No winner this round", detail: `Round ${r.no} of ${s.totalRounds}` };
  }
  return s.roundsRemaining > 0
    ? { key: `ready:${roundNo}`, Icon: Hourglass, title: "Get ready!", detail: `Round ${roundNo} of ${s.totalRounds} is up next` }
    : { key: "wrap", Icon: Trophy, title: "That's all the rounds!", detail: "Time to wrap up the game" };
}
