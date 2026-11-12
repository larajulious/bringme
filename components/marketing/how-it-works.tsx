"use client";

import { Camera, Check, GripVertical, Play, QrCode, Timer, UserPlus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Mascot } from "@/components/brand/mascot";
import { Reveal } from "@/components/marketing/reveal";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------------------------------------
 * The stage: one small, honest mock of the real product per step. Decorative (aria-hidden): the
 * step list carries the meaning. Every scene has a complete resting state for reduced motion.
 * ---------------------------------------------------------------------------------------------- */

const pop = (i: number) => ({ className: "animate-pop-in motion-reduce:animate-none", style: { animationDelay: `${120 + i * 110}ms` } });

function SetupScene() {
  const items = ["a red stapler", "your company ID", "the aircon remote"];
  return (
    <div className="w-[17rem] rounded-3xl bg-white p-4 text-left text-foreground shadow-[0_24px_48px_-20px_rgb(0_0_0/0.55)]">
      <div className="mb-3 flex items-center justify-between">
        <span className="font-display text-lg font-bold text-primary">Office party</span>
        <span className="rounded-lg bg-secondary px-2 py-0.5 font-mono text-xs font-bold text-primary">4F2K</span>
      </div>
      <p className="mb-1.5 text-xs font-bold uppercase tracking-wide text-muted-foreground">Bring me…</p>
      <ol className="mb-3 grid gap-1.5">
        {items.map((t, i) => (
          <li key={t} {...pop(i)} className={cn("flex items-center gap-2 rounded-xl border border-primary/10 bg-background px-2.5 py-2 text-sm font-semibold", pop(i).className)}>
            <span className="grid size-5 place-items-center rounded-md bg-primary text-[0.65rem] font-bold text-white">{i + 1}</span>
            {t}
            <GripVertical className="ml-auto size-4 text-muted-foreground/60" />
          </li>
        ))}
      </ol>
      <span className="flex items-center justify-center gap-1.5 rounded-2xl bg-brand-yellow py-2.5 font-display font-bold text-brand-night shadow-pop">
        <Play className="size-4" /> Start game
      </span>
    </div>
  );
}

function Phone({ children, dark = false }: { children: React.ReactNode; dark?: boolean }) {
  return (
    <div className={cn("grid h-[17.5rem] w-[9.5rem] grid-rows-[auto_1fr] gap-2 rounded-[1.9rem] border-[5px] border-brand-night p-2.5 shadow-[0_24px_48px_-20px_rgb(0_0_0/0.6)]", dark ? "bg-brand-night" : "bg-white")}>
      <span className={cn("mx-auto h-1.5 w-9 rounded-full", dark ? "bg-white/25" : "bg-brand-night/15")} />
      {children}
    </div>
  );
}

function JoinScene() {
  return (
    <div className="flex items-center gap-5">
      <div className="hidden w-28 rotate-[-4deg] rounded-2xl bg-white p-3 text-center shadow-card sm:block">
        <QrCode className="mx-auto size-20 text-primary" />
        <span className="mt-1 block font-mono text-[0.65rem] font-bold text-primary">SCAN TO JOIN</span>
      </div>
      <Phone>
        <div className="grid content-start gap-2 text-center">
          <span className="font-mono text-[0.65rem] font-bold text-primary">ROOM 4F2K</span>
          <span className="rounded-xl border-2 border-primary/25 px-2 py-1.5 text-left text-sm font-semibold text-foreground">
            Migs<span className="ml-px inline-block h-4 w-0.5 translate-y-0.5 bg-primary" />
          </span>
          <span className="flex items-center justify-center gap-1 rounded-xl bg-brand-yellow py-1.5 font-display text-sm font-bold text-brand-night shadow-pop">
            <UserPlus className="size-4" /> Join
          </span>
          <ul className="mt-1 grid gap-1">
            {["Ana", "Joy", "Migs"].map((n, i) => (
              <li key={n} {...pop(i + 1)} className={cn("rounded-full bg-secondary py-0.5 font-display text-xs font-bold text-secondary-foreground", pop(i + 1).className)}>{n}</li>
            ))}
          </ul>
        </div>
      </Phone>
    </div>
  );
}

function SnapScene() {
  const corner = "absolute size-5 border-white/90";
  return (
    <Phone dark>
      <div className="grid grid-rows-[auto_1fr_auto] gap-2 text-white">
        <div className="flex items-start justify-between gap-1">
          <span className="text-left">
            <span className="block text-[0.6rem] font-bold uppercase tracking-widest text-white/70">Bring me…</span>
            <span className="font-display text-base font-bold leading-tight text-brand-yellow">a red stapler</span>
          </span>
          <span className="flex items-center gap-0.5 rounded-full bg-white/15 px-1.5 py-0.5 font-mono text-[0.65rem] font-bold"><Timer className="size-3" />0:07</span>
        </div>
        <div className="relative overflow-hidden rounded-2xl bg-gradient-to-b from-neutral-700 to-neutral-900">
          <span className={cn(corner, "left-1.5 top-1.5 rounded-tl-lg border-l-[3px] border-t-[3px]")} />
          <span className={cn(corner, "right-1.5 top-1.5 rounded-tr-lg border-r-[3px] border-t-[3px]")} />
          <span className={cn(corner, "bottom-1.5 left-1.5 rounded-bl-lg border-b-[3px] border-l-[3px]")} />
          <span className={cn(corner, "bottom-1.5 right-1.5 rounded-br-lg border-b-[3px] border-r-[3px]")} />
          {/* the "stapler" */}
          <span className="absolute left-1/2 top-1/2 h-5 w-16 -translate-x-1/2 -translate-y-1/2 rotate-[-8deg] rounded-md bg-brand-coral shadow-[0_6px_0_0_hsl(var(--brand-coral-deep))]" />
          <span className="absolute inset-0 animate-flash-loop bg-white opacity-0 motion-reduce:hidden" />
        </div>
        <span className="mx-auto grid size-11 place-items-center rounded-full border-[3px] border-white p-0.5">
          <span className="grid size-full place-items-center rounded-full bg-brand-coral"><Camera className="size-4" /></span>
        </span>
      </div>
    </Phone>
  );
}

function WinScene() {
  const rest = [["Ana", "03.902s"], ["Joy", "05.117s"]];
  return (
    <div className="w-[17rem] rounded-3xl border-4 border-white/15 bg-brand-night/70 p-4 text-center text-white shadow-[0_24px_48px_-20px_rgb(0_0_0/0.6)]">
      <span className="text-[0.65rem] font-bold uppercase tracking-widest text-white/70">Round 1 winner</span>
      <div className="my-2 flex items-center justify-center gap-2">
        <Mascot mood="cheer" className="w-12" />
        <span className="grid text-left">
          <span className="animate-bounce-in font-display text-3xl font-bold leading-none text-brand-yellow motion-reduce:animate-none">Migs</span>
          <span className="font-mono text-sm font-bold text-white/85">02.418s</span>
        </span>
      </div>
      <ol className="grid gap-1 text-sm">
        {rest.map(([n, t], i) => (
          <li key={n} {...pop(i + 2)} className={cn("flex items-center justify-between rounded-xl bg-white/10 px-3 py-1.5", pop(i + 2).className)}>
            <span><span className="mr-2 font-mono text-white/60">{i + 2}</span>{n}</span>
            <span className="font-mono text-white/80">{t}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

const steps = [
  { title: "Set up the game", text: "Open a room and list what players must bring. It takes about a minute.", scene: SetupScene, chip: "bg-brand-yellow text-brand-night" },
  { title: "Everyone scans in", text: "Players scan the QR code on the big screen. No app, no account.", scene: JoinScene, chip: "bg-primary text-white" },
  { title: "Find it, snap it", text: "Each round reveals an item. Players race to find it and snap a photo.", scene: SnapScene, chip: "bg-brand-coral text-white" },
  { title: "Crown the winner", text: "You check the photos. The fastest valid snap wins the round.", scene: WinScene, chip: "bg-brand-night text-brand-yellow" },
] as const;

const STEP_MS = 4200;
const DESKTOP = "(min-width: 1024px)";

/** The product mock for one step, on the brand-purple stage (decorative). */
function Stage({ step, className, pill = true }: { step: number; className?: string; pill?: boolean }) {
  const Scene = steps[step].scene;
  return (
    <div aria-hidden="true" className={cn("relative isolate grid place-items-center overflow-hidden rounded-4xl bg-primary", className)}>
      <span className="absolute inset-0 -z-10 opacity-[0.12] [background-image:radial-gradient(#fff_1.5px,transparent_1.5px)] [background-size:22px_22px]" />
      {pill ? (
        <span className="absolute left-5 top-5 rounded-full bg-white/15 px-3 py-1 font-display text-sm font-bold text-white">
          Step {step + 1} of {steps.length}
        </span>
      ) : null}
      <div key={step} className="animate-pop-in motion-reduce:animate-none"><Scene /></div>
    </div>
  );
}

/**
 * "How it works" as one round, start to finish: a numbered step list with a stage that shows the
 * real product for the active step. Desktop: the stage sits beside the list and plays through on
 * its own once on screen (a progress bar fills on the active step), pausing on hover / focus and
 * handing control to you as soon as you pick a step. Phones: an accordion, the stage opens right
 * under the tapped step (no autoplay, no scrolling up to see it). Reduced motion: no autoplay.
 */
export function HowItWorks() {
  const [active, setActive] = useState(0);
  const [auto, setAuto] = useState(false);
  const [held, setHeld] = useState(false);
  const [hiddenTab, setHiddenTab] = useState(false);

  const items = useRef<(HTMLLIElement | null)[]>([]);
  // Autoplay on desktop only: on phones the stage opens inside the tapped step, and nothing should
  // move under the reader's thumb.
  const start = useCallback(() => {
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches && window.matchMedia(DESKTOP).matches) setAuto(true);
  }, []);
  // Don't run in a background tab.
  useEffect(() => {
    const onVis = () => setHiddenTab(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const pick = (i: number) => {
    setAuto(false);
    setActive(i);
    // Phones: keep the opened step and its animation on screen (an earlier step just collapsed above it).
    if (!window.matchMedia(DESKTOP).matches) {
      const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      requestAnimationFrame(() => items.current[i]?.scrollIntoView({ block: "nearest", behavior: smooth ? "smooth" : "auto" }));
    }
  };

  return (
    <Reveal
      as="section" aria-labelledby="how-heading" onEnter={start}
      className="relative isolate mx-auto flex min-h-svh w-full max-w-6xl flex-col justify-center px-5 py-[clamp(3rem,8svh,6rem)]"
    >
      <div className="mb-[clamp(2rem,6svh,4rem)] text-center">
        <h2 id="how-heading" className="reveal-item mb-3 text-3xl font-bold text-primary sm:text-4xl lg:text-5xl">How it works</h2>
        <p className="reveal-item mx-auto max-w-xl text-muted-foreground [--i:1] lg:text-lg">One round, start to finish. Most groups are playing within five minutes.</p>
      </div>

      <div
        className="grid items-center gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:gap-12"
        onMouseEnter={() => setHeld(true)} onMouseLeave={() => setHeld(false)}
        onFocus={() => setHeld(true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setHeld(false); }}
      >
        {/* stage (desktop: beside the steps) */}
        <Stage step={active} className="reveal-item hidden h-[30rem] [--i:2] lg:order-2 lg:grid" />

        {/* steps */}
        <ol className="grid gap-2 lg:order-1" aria-label="Steps">
          {steps.map((s, i) => {
            const on = active === i;
            const done = i < active;
            return (
              <li key={s.title} ref={(el) => { items.current[i] = el; }} className="reveal-item scroll-my-4" style={{ "--i": i + 3 } as React.CSSProperties}>
                <button
                  type="button"
                  onClick={() => pick(i)}
                  aria-current={on ? "step" : undefined}
                  className={cn(
                    "group relative grid w-full grid-cols-[auto_minmax(0,1fr)] items-start gap-4 overflow-hidden rounded-3xl p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring sm:p-5",
                    on ? "bg-card shadow-card ring-1 ring-primary/10" : "hover:bg-card/60",
                  )}
                >
                  <span className={cn("grid size-11 place-items-center rounded-2xl font-display text-xl font-bold transition-colors", on ? s.chip : "bg-secondary text-primary")}>
                    {done ? <Check aria-hidden="true" className="size-5" strokeWidth={3} /> : i + 1}
                    <span className="sr-only">{done ? `Step ${i + 1}, done` : `Step ${i + 1}`}</span>
                  </span>
                  <span className="grid gap-1">
                    <span className={cn("font-display text-xl font-bold transition-colors", on ? "text-primary" : "text-foreground")}>{s.title}</span>
                    <span className="text-muted-foreground">{s.text}</span>
                  </span>
                  {on && auto ? (
                    <span aria-hidden="true" className="absolute inset-x-5 bottom-0 h-1 overflow-hidden rounded-full bg-primary/10">
                      <span
                        key={active}
                        className="block h-full origin-left animate-[fill-once_linear_forwards] rounded-full bg-brand-yellow"
                        style={{ animationDuration: `${STEP_MS}ms`, animationPlayState: held || hiddenTab ? "paused" : "running" }}
                        onAnimationEnd={() => setActive((a) => (a + 1) % steps.length)}
                      />
                    </span>
                  ) : null}
                </button>
                {/* phones: the animation opens right under the step you tapped */}
                {on ? <Stage step={i} pill={false} className="mt-2 h-[19.5rem] lg:hidden" /> : null}
              </li>
            );
          })}
        </ol>
      </div>
    </Reveal>
  );
}
