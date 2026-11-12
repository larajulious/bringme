"use client";

import { Expand, Hourglass, Minimize, Timer } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Backdrop } from "@/components/brand/backdrop";
import { Countdown } from "@/components/game/countdown";
import { WinnerStage } from "@/components/game/winner-stage";
import { useNow } from "@/components/game/use-game-sync";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { secondsUntil } from "@/lib/game/sync";
import type { HostSnapshot } from "@/lib/game/types";
import { cn } from "@/lib/utils";

/**
 * The big, projector-friendly view of the live game. It sits at the top of the
 * Game Master console and can go fullscreen; the phase's main button lives
 * inside it (`actions`), so the host can run the whole game from the projector.
 * Photos are never shown here except the winner's, after it is official.
 */
export function ProjectorStage({
  s, offsetMs, submittedNames, winnerPhotoUrl, actions, presenter = false,
}: {
  s: HostSnapshot;
  offsetMs: number;
  submittedNames: string[];
  winnerPhotoUrl: string | null;
  actions: ReactNode;
  /** Dedicated presenter window (/present/[id]): always full-viewport and large, no own fullscreen toggle. */
  presenter?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [fs, setFs] = useState(false);
  const timed = s.phase === "countdown" || s.phase === "active";
  const now = useNow(timed, 250);

  useEffect(() => {
    const on = () => setFs(document.fullscreenElement === ref.current);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);
  const toggle = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await ref.current?.requestFullscreen();
    } catch { /* not available: the inline view still works */ }
  };

  const r = s.round;
  const roundNo = r?.no ?? s.totalRounds - s.roundsRemaining + 1;
  const roundLabel = `Round ${Math.min(roundNo, s.totalRounds)} of ${s.totalRounds}`;
  const big = fs || presenter;
  const limitLeft = r?.openedAt ? Math.max(0, Math.ceil((Date.parse(r.openedAt) + r.timeLimitSeconds * 1000 - (now + offsetMs)) / 1000)) : 0;
  const started = r?.openedAt ? now + offsetMs >= Date.parse(r.openedAt) : false;

  let body: ReactNode;
  if (s.phase === "winner_announced" && r) {
    body = (
      <WinnerStage
        roundLabel={roundLabel} prompt={r.prompt} winnerName={r.winnerName} timeMs={r.winnerMs}
        photoUrl={winnerPhotoUrl} size={big ? "large" : "normal"}
        subline={s.roundsRemaining > 0 ? null : "That was the last round!"}
      >
        {actions}
      </WinnerStage>
    );
  } else {
    let main: ReactNode;
    if (s.phase === "countdown") {
      const left = secondsUntil(s.countdownEndsAt, now, offsetMs);
      main = <Countdown left={left} large={big} flash="absolute" />;
    } else if (s.phase === "active" && r) {
      main = (
        <div className="grid justify-items-center gap-4">
          <p className={cn("font-bold uppercase tracking-widest text-white/80", big ? "text-[clamp(1.125rem,3.4dvh,1.875rem)]" : "text-sm")}>Bring me…</p>
          <p className={cn("max-w-full break-words font-display font-bold leading-tight text-brand-yellow", big ? "text-[clamp(2.5rem,min(9dvh,6.5vw),6rem)]" : "text-5xl")}>{started ? r.prompt : "On your marks…"}</p>
          <p className={cn("flex items-center gap-3 font-mono font-bold tabular-nums", big ? "text-[clamp(2rem,7dvh,3.75rem)]" : "text-3xl")}>
            <Timer aria-hidden="true" className={big ? "size-[min(3rem,6dvh)]" : "size-7"} />
            {!started ? "Starting…" : r.status === "closed" ? "Time's up" : `${Math.floor(limitLeft / 60)}:${String(limitLeft % 60).padStart(2, "0")}`}
          </p>
        </div>
      );
    } else if (s.phase === "reviewing") {
      main = (
        <div className="grid justify-items-center gap-3">
          <Hourglass aria-hidden="true" className={cn("text-brand-yellow", big ? "size-[min(6rem,11dvh)]" : "size-14")} />
          <p className={cn("font-display font-bold text-brand-yellow", big ? "text-[clamp(3rem,11dvh,6rem)]" : "text-5xl")}>Judging time!</p>
          <p className={big ? "text-[clamp(1.5rem,4.2dvh,2.25rem)]" : "text-xl"}>{r?.prompt ? <>Does it show <strong>{r.prompt}</strong>?</> : null}</p>
        </div>
      );
    } else {
      main = (
        <div className="grid justify-items-center gap-3">
          <p className={cn("font-display font-bold text-brand-yellow", big ? "text-[clamp(3rem,11dvh,6rem)]" : "text-5xl")}>{s.roundsRemaining > 0 ? "Get ready!" : "That's all the rounds!"}</p>
          <p className={big ? "text-[clamp(1.5rem,4.2dvh,2.25rem)]" : "text-xl"}>{s.roundsRemaining > 0 ? `${roundLabel} is up next` : "Time to wrap up the game"}</p>
        </div>
      );
    }
    const showCount = s.phase === "active" || s.phase === "reviewing";
    body = (
      <div className={cn("grid min-h-0 justify-items-center", big ? "gap-[2.5dvh] py-[2dvh]" : "gap-6 py-6")}>
        <p className={cn("font-bold uppercase tracking-widest text-white/80", big ? "text-[clamp(1.125rem,3.4dvh,1.875rem)]" : "text-sm")}>{roundLabel}</p>
        {main}
        {showCount ? (
          <div className="grid justify-items-center gap-3">
            <p className={cn("font-display font-semibold", big ? "text-[clamp(1.75rem,5.5dvh,3rem)]" : "text-2xl")} aria-live="polite">
              <span key={s.submissionCount} className="inline-block animate-pop-in text-brand-yellow">{s.submissionCount}</span>{" "}
              {s.submissionCount === 1 ? "photo" : "photos"} in
              <span className="text-white/70"> · {s.playerCount} players</span>
            </p>
            {s.phase === "active" && submittedNames.length ? (
              <ul className={cn("flex max-w-4xl flex-wrap justify-center gap-2", big && "max-h-[18dvh] overflow-hidden")} aria-label="Players who have submitted">
                {submittedNames.map((n) => <li key={n} className={cn("rounded-full bg-white/15 px-4 py-1 font-display font-semibold animate-pop-in", big ? "text-[clamp(1.125rem,3.4dvh,1.875rem)]" : "text-base")}>{n}</li>)}
              </ul>
            ) : null}
          </div>
        ) : null}
        {actions ? <div className="flex flex-wrap justify-center gap-3">{actions}</div> : null}
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className={cn(
        "relative isolate flex flex-col justify-center overflow-hidden bg-gradient-to-b from-primary to-brand-night text-center text-white",
        big ? "h-viewport rounded-none p-[3dvh]" : "rounded-4xl p-4 sm:p-6",
      )}
    >
      <Backdrop />
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <span className="flex items-center gap-2">
          <Badge variant="yellow">{s.title}</Badge>
          {s.joinCode ? <span className="font-mono text-sm font-bold text-white/80">Room {s.joinCode}</span> : null}
        </span>
        {presenter ? null : (
          <Button type="button" variant="outline-light" size="sm" onClick={toggle}>
            {fs ? <Minimize aria-hidden="true" /> : <Expand aria-hidden="true" />}
            {fs ? "Exit fullscreen" : "Present fullscreen"}
          </Button>
        )}
      </div>
      {body}
    </div>
  );
}
