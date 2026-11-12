"use client";

import { Hand, Play, QrCode, Timer, Trophy, UserPlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

const NAMES = ["Bea", "Paolo", "Kat", "Jun", "Rina", "Toto", "Liza", "Nico", "Gab", "Mae"];
const ITEMS = ["your company ID", "a yellow sticky note", "the aircon remote", "pandesal", "a red stapler"];

/** Small bobbing "Tap to try" chip that disappears after the first interaction. */
function TryHint({ show, className }: { show: boolean; className?: string }) {
  if (!show) return null;
  return (
    <span aria-hidden="true" className={cn("pointer-events-none absolute z-10 inline-flex -rotate-6 animate-bob items-center gap-1 rounded-full bg-brand-coral px-2.5 py-1 font-display text-xs font-bold text-white shadow-pop-coral motion-reduce:animate-none", className)}>
      <Hand className="size-3.5" /> Tap to try
    </span>
  );
}

/**
 * Players demo: a phone in a room. Nicknames pop in on a loop until the visitor taps "Join";
 * then each tap adds a new player (newest on top) with a live count.
 */
export function PhoneScene() {
  const [joined, setJoined] = useState<string[] | null>(null);
  const names = joined ?? ["Ana", "Migs", "Joy"];
  const add = () => setJoined((j) => [...(j ?? ["Ana", "Migs", "Joy"]), NAMES[(j?.length ?? 3) % NAMES.length]]);

  return (
    <div className="relative">
      <span aria-hidden="true" className="absolute -left-14 top-6 grid size-14 -rotate-6 place-items-center rounded-2xl bg-white text-primary shadow-card sm:-left-20 sm:size-16">
        <QrCode className="size-9 sm:size-10" />
      </span>
      <div className="grid h-56 w-40 grid-rows-[auto_auto_1fr_auto] gap-2 rounded-[1.75rem] border-[5px] border-brand-night bg-white p-3 shadow-[0_18px_40px_-12px_hsl(var(--brand-purple-deep)/0.45)]">
        <span aria-hidden="true" className="mx-auto h-1.5 w-10 rounded-full bg-brand-night/15" />
        <span className="text-center font-mono text-[0.7rem] font-bold text-primary">
          ROOM 4F2K · <span key={names.length} className="inline-block animate-pop-in">{names.length}</span>
          <span className="sr-only"> players in the demo room</span>
        </span>
        <ul aria-hidden="true" className="grid content-start gap-1.5 overflow-hidden">
          {names.slice(-3).reverse().map((n, i) => (
            <li
              key={`${n}-${names.length - i}`}
              className={cn(
                "rounded-full bg-secondary px-2 py-1 text-center font-display text-sm font-bold text-secondary-foreground",
                joined ? i === 0 && "animate-join-in motion-reduce:animate-none" : "reveal-loop animate-chip-loop motion-reduce:animate-none",
              )}
              style={joined ? undefined : { animationDelay: `${(2 - i) * 0.6}s` }}
            >
              {n}
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={add}
          className="inline-flex items-center justify-center gap-1.5 rounded-full bg-brand-yellow px-3 py-1.5 font-display text-sm font-bold text-brand-night shadow-pop transition-transform active:translate-y-0.5 active:shadow-none focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring"
        >
          <UserPlus aria-hidden="true" className="size-4" /> Join
          <span className="sr-only"> the demo room as a new player</span>
        </button>
      </div>
      <TryHint show={!joined} className="-right-6 -top-4 sm:-right-[6.5rem] sm:top-[42%]" />
    </div>
  );
}

const ROUND_MS = 3000;

/**
 * Game Master demo: a mini projector. Tap "Start round": the item changes, the timer drains once,
 * then a winner pops up, ready for the next round.
 */
export function ProjectorScene() {
  const [round, setRound] = useState(0);
  const [winner, setWinner] = useState<{ name: string; time: string } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const live = round > 0 && !winner;

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const start = () => {
    setWinner(null);
    setRound((r) => r + 1);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const name = NAMES[Math.floor(Math.random() * NAMES.length)];
      setWinner({ name, time: `0${1 + Math.floor(Math.random() * 8)}.${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}s` });
    }, ROUND_MS);
  };

  const item = round === 0 ? "a red stapler" : ITEMS[(round - 1) % ITEMS.length];

  return (
    <div className="relative">
      <div className="grid w-72 gap-3 rounded-2xl border-4 border-white/15 bg-brand-night/60 p-5 text-center text-white shadow-[0_18px_40px_-12px_rgb(0_0_0/0.5)]">
        <span className="text-[0.65rem] font-bold uppercase tracking-widest text-white/70">Round {Math.max(1, round)} · Bring me…</span>
        <span key={round} className="animate-pop-in font-display text-2xl font-bold leading-none text-brand-yellow" aria-live="polite">{item}</span>
        <span aria-hidden="true" className="flex items-center gap-2">
          <Timer className="size-4 shrink-0 text-white/80" />
          <span className="h-2 flex-1 overflow-hidden rounded-full bg-white/15">
            <span key={round} className={cn("block h-full origin-left rounded-full bg-brand-coral", round > 0 && "animate-[drain-once_3s_linear_forwards]")} />
          </span>
        </span>
        <div className="grid h-7 place-items-center">
          {winner ? (
            <span role="status" className="inline-flex animate-bounce-in items-center gap-1.5 rounded-full bg-brand-yellow px-3 py-1 font-display text-sm font-bold text-brand-night">
              <Trophy aria-hidden="true" className="size-4" /> {winner.name} · {winner.time}
            </span>
          ) : (
            <span className="font-mono text-xs font-bold text-white/75">{live ? "Players are hunting…" : "Ready when you are"}</span>
          )}
        </div>
        <button
          type="button"
          onClick={start}
          disabled={live}
          className="mx-auto inline-flex items-center gap-1.5 rounded-full bg-brand-coral px-5 py-2 font-display text-sm font-bold text-white shadow-pop-coral transition-transform active:translate-y-0.5 active:shadow-none disabled:opacity-70 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-yellow"
        >
          <Play aria-hidden="true" className="size-4" /> {live ? "Round live…" : round === 0 ? "Start round" : "Next round"}
        </button>
      </div>
      <TryHint show={round === 0} className="-right-4 -top-3" />
    </div>
  );
}
