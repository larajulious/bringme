"use client";

import { ArrowDown, Camera, Check, Crown, Timer, Volume2, VolumeX } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { Mascot } from "@/components/brand/mascot";
import { Confetti } from "@/components/game/confetti";
import { useShutterSound } from "@/components/marketing/shutter-sound";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { StoryConfig } from "./engine";
import { SNAP_ITEMS, type SnapItem } from "./items";
import { PARTS, fmtTime, restStyle, type Part, type Styled } from "./scene";

/* ================================================================================================
 * STORYBOARD: every timing in the section.
 * - Scroll only picks the TARGET stage (from `stageStart`); each stage then plays at its own `durations`.
 * - The card → phone morph is the one scrubbed part (stageStart.morph → stageStart.viewfinder, `morph.scrub`).
 * - When scrolling stops, the page glides to the next stage boundary in the scroll direction (`scrollSnap`).
 * - Skipping stages with a fast scroll plays the skipped ones faster, up to `maxCatchUp`×; the snap always at 1×.
 * ============================================================================================== */
export const STORYBOARD = {
  /** Scroll distance while pinned, in % of the viewport height (svh: steady while mobile toolbars slide). */
  pin: { mobile: 200, desktop: 250 },
  /** Desktop layout from this width up (Tailwind `md`). */
  desktopFrom: 768,
  /** Where each stage begins, as a fraction of the pinned scroll. */
  stageStart: { prompt: 0, morph: 0.15, viewfinder: 0.35, snap: 0.55, lockedIn: 0.65, win: 0.85 },
  /** Each stage's playback duration (s). `prompt` = the shout as the section comes in. The morph is scrubbed instead. */
  durations: { prompt: 0.5, viewfinder: 2.4, snap: 0.9, lockedIn: 1.1, win: 1.3 },
  /** Scrub smoothing for the morph (s to catch up with the scrollbar). */
  morph: { scrub: 0.3 },
  /** Settling on a stage boundary after scrolling stops. */
  scrollSnap: { duration: { min: 0.25, max: 0.6 }, delay: 0.08, ease: "power2.out" },
  /** Fastest catch-up when a scroll skips several stages (× normal speed). */
  maxCatchUp: 2,
  /** When the shutter fires (s into the snap stage), and the time frozen on screen. */
  shutterAt: 0.4,
  winTime: 7.412,
  /** The snap's flash, punch and shake (ms). */
  flashMs: 120,
  punchMs: 220,
  shakeMs: 380,
  /** Smooth wheel scrolling (Lenis); touch stays native. */
  lenis: { lerp: 0.1 },
} satisfies StoryConfig;

/* ------------------------------------------ pieces ------------------------------------------ */

const C = "absolute left-1/2 top-1/2";
const REST = Object.fromEntries(PARTS.map((k) => [k, restStyle(k)])) as Record<Part, React.CSSProperties | undefined>;

/** The camera's view of the "room": a dim purple backdrop with a floor and a few out-of-focus lights. */
function Backdrop({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cn("overflow-hidden bg-gradient-to-b from-brand-night to-primary", className)}>
      <span className="absolute inset-x-0 bottom-0 h-[38%] bg-white/10" />
      <span className="absolute left-[18%] top-[16%] size-10 rounded-full bg-brand-yellow/20" />
      <span className="absolute right-[14%] top-[28%] size-6 rounded-full bg-white/15" />
      <span className="absolute left-[60%] top-[8%] size-14 rounded-full bg-brand-coral/20" />
    </div>
  );
}

function Polaroid({ item, className }: { item: SnapItem; className?: string }) {
  return (
    <div className={cn("w-[196px] rounded-md bg-white p-3 pb-3.5 text-left shadow-[0_22px_40px_-18px_rgb(42_15_92/0.6)]", className)}>
      <div className="relative h-[172px] overflow-hidden rounded-sm">
        <Backdrop className="absolute inset-0" />
        <item.Art className="absolute left-1/2 top-1/2 w-[150px] -translate-x-1/2 -translate-y-[38%]" />
      </div>
      <p className="mt-2.5 font-display text-lg font-bold leading-tight text-brand-night">{item.caption}</p>
      <p className="font-mono text-xs font-bold text-primary">Migs · {fmtTime(STORYBOARD.winTime)}</p>
    </div>
  );
}

function LockedBadge({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-brand-success px-4 py-2 font-display text-lg font-bold text-white shadow-[0_4px_0_0_hsl(152_60%_18%)]", className)}>
      <Check className="size-5" strokeWidth={3.5} aria-hidden="true" /> Locked in!
    </span>
  );
}

function CrownBadge({ className }: { className?: string }) {
  return (
    <span className={cn("grid size-[72px] place-items-center rounded-full bg-brand-yellow text-brand-night shadow-pop ring-4 ring-white", className)}>
      <Crown className="size-9" strokeWidth={2.4} aria-hidden="true" />
    </span>
  );
}

function PromptText({ item, light = false }: { item: SnapItem; light?: boolean }) {
  return (
    <span className="block">
      <span className={cn("block text-sm font-bold uppercase tracking-[0.2em]", light ? "text-white/75" : "text-primary")}>Bring me…</span>
      <span className={cn("block font-display text-[36px] font-bold leading-[1.1]", light ? "text-brand-yellow" : "text-brand-night")}>{item.prompt}!</span>
    </span>
  );
}

const corner = "absolute size-[30px] border-white";

/** Runs `fn` in an idle moment (or soon, where requestIdleCallback is missing). */
function whenIdle(fn: () => void) {
  if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(fn, { timeout: 2000 });
  else globalThis.setTimeout(fn, 300);
}

/* ---------------------------------------- the section ---------------------------------------- */

/**
 * "One shout. Everyone runs.": a pinned replay of one round (see STORYBOARD above and engine.ts). The pin is CSS
 * `position: sticky` (compositor-driven, no iOS jitter). The GSAP + Lenis engine is code-split and starts lazily
 * after the hero has loaded. Reduced motion: no pin, no smooth scrolling, a static three-step version.
 */
export function SnapStory() {
  const [index, setIndex] = useState(0);
  const [burst, setBurst] = useState(0);
  const [muted, setMuted] = useState(false);
  const item = SNAP_ITEMS[index % SNAP_ITEMS.length];

  const sectionRef = useRef<HTMLElement>(null);
  const pinRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const stepsRef = useRef<HTMLOListElement>(null);
  const els = useRef<Partial<Record<Part, Styled | null>>>({});
  const [bind] = useState(() => Object.fromEntries(PARTS.map((k) => [k, (el: Styled | null) => { els.current[k] = el; }])) as Record<Part, (el: Styled | null) => void>);

  const click = useShutterSound();
  const sound = useRef({ on: true, click });
  useEffect(() => { sound.current = { on: !muted, click }; });
  // Sound is on by default, but browsers only allow audio after a real gesture (click, tap, key; a scroll
  // doesn't count). Use the browser's own flag where it exists, else watch for one.
  // The audio context is created ahead of time in an idle moment after the first gesture (creating it takes
  // ~100–200 ms, far too long for the snap frame), and resumed from later gestures (that's what unlocks iOS).
  const interacted = useRef(false);
  useEffect(() => {
    const onGesture = () => {
      interacted.current = true;
      const s = sound.current;
      if (!s.on) return;
      if (s.click.created()) s.click.warm(); // cheap: resume inside the gesture
      else whenIdle(() => sound.current.click.warm());
    };
    window.addEventListener("pointerup", onGesture, { capture: true, passive: true });
    window.addEventListener("keydown", onGesture, { capture: true });
    return () => { window.removeEventListener("pointerup", onGesture, { capture: true }); window.removeEventListener("keydown", onGesture, { capture: true }); };
  }, []);

  // Fit the stage to its area right away (cheap); the engine itself starts lazily (below).
  useEffect(() => {
    const area = areaRef.current, stage = stageRef.current;
    if (!area || !stage) return;
    const fit = () => {
      const s = Math.min(area.clientWidth / 440, area.clientHeight / 600, 1.1);
      if (s > 0) stage.style.setProperty("--fit", String(Math.round(s * 1000) / 1000));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(area);
    return () => ro.disconnect();
  }, []);

  // The engine (GSAP + ScrollTrigger + Lenis), code-split. Starts after the page (hero) has loaded and the main
  // thread is idle, or as soon as the section comes near the viewport, whichever is first. Never with reduced motion.
  useEffect(() => {
    const section = sectionRef.current, pin = pinRef.current, area = areaRef.current, stage = stageRef.current;
    if (!section || !pin || !area || !stage) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let stop: (() => void) | undefined;
    let gone = false, starting = false;

    const canPlay = () => (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive ?? interacted.current;
    const start = () => {
      if (stop || starting || gone || reduced.matches) return;
      starting = true;
      void import("./engine").then(({ startSnapStory }) => {
        starting = false;
        if (gone || reduced.matches || stop) return;
        // the visitor interacted before this mounted: warm the shutter now, in an idle moment
        if (sound.current.on && canPlay() && !sound.current.click.created()) {
          whenIdle(() => sound.current.click.warm());
        }
        stop = startSnapStory({
          config: STORYBOARD, section, pin, area, stage, els: els.current,
          onSnap: () => {
            const s = sound.current;
            if (!s.on || !canPlay()) return;
            // never create the audio context here (slow, mid-animation): it's warmed after the visitor's first gesture
            if (s.click.created()) s.click();
          },
          onConfetti: (on) => setBurst((b) => (on ? b + 1 : 0)),
          onNextItem: () => setIndex((i) => (i + 1) % SNAP_ITEMS.length),
        });
      });
    };
    const halt = () => { stop?.(); stop = undefined; setBurst(0); };

    let idle = 0, timer = 0;
    const hasIdle = "requestIdleCallback" in window;
    const onLoad = () => { idle = hasIdle ? window.requestIdleCallback(start, { timeout: 1500 }) : window.setTimeout(start, 200); };
    if (document.readyState === "complete") onLoad();
    else window.addEventListener("load", onLoad, { once: true });
    const near = new IntersectionObserver(([e]) => { if (e.isIntersecting) { near.disconnect(); timer = window.setTimeout(start, 0); } }, { rootMargin: "75% 0px" });
    near.observe(section);

    const onMotionPref = () => { if (reduced.matches) halt(); else start(); };
    reduced.addEventListener("change", onMotionPref);
    return () => {
      gone = true;
      halt();
      near.disconnect();
      if (hasIdle) window.cancelIdleCallback(idle); else window.clearTimeout(idle);
      window.clearTimeout(timer);
      window.removeEventListener("load", onLoad);
      reduced.removeEventListener("change", onMotionPref);
    };
  }, []);

  // Reduced motion: the static steps fade in (opacity only) as they scroll into view.
  useEffect(() => {
    const ol = stepsRef.current;
    if (!ol || !window.matchMedia("(prefers-reduced-motion: reduce)").matches || typeof IntersectionObserver === "undefined") return;
    ol.dataset.snapSteps = "armed";
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { ol.dataset.snapSteps = "in"; io.disconnect(); } }, { threshold: 0.25 });
    io.observe(ol);
    return () => io.disconnect();
  }, []);

  const pinVars = { "--pin-m": `${100 + STORYBOARD.pin.mobile}svh`, "--pin-d": `${100 + STORYBOARD.pin.desktop}svh` } as React.CSSProperties;

  return (
    <section
      ref={sectionRef}
      id="one-round"
      aria-labelledby="snap-story-heading"
      style={pinVars}
      className="relative h-[var(--pin-m)] md:h-[var(--pin-d)] motion-reduce:!h-auto"
    >
      <div ref={pinRef} className="sticky top-0 h-svh overflow-hidden motion-reduce:static motion-reduce:h-auto">
        <div className="mx-auto grid h-full w-full max-w-6xl grid-rows-[auto_minmax(0,1fr)] gap-2 px-5 pb-5 pt-[clamp(1.25rem,5svh,3rem)] motion-reduce:py-[clamp(3rem,8svh,6rem)] md:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] md:grid-rows-1 md:items-center md:gap-10 md:py-10 md:motion-reduce:grid-cols-1 md:motion-reduce:py-[clamp(3rem,8svh,6rem)]">
          {/* copy (real text) */}
          <div className="text-center md:text-left md:motion-reduce:text-center">
            <Badge variant="coral" className="mb-4 hidden md:inline-flex">One round, start to finish</Badge>
            <h2 id="snap-story-heading" className="mb-2 text-3xl font-bold text-primary sm:mb-3 sm:text-4xl lg:text-5xl">One shout. Everyone runs.</h2>
            <p className="mx-auto max-w-md text-muted-foreground short:text-sm md:mx-0 md:motion-reduce:mx-auto lg:text-lg">
              The host calls an item. Every phone becomes a camera<span className="hidden sm:inline">, the room turns into a treasure hunt,</span> and the fastest snap takes the round.
            </p>
            <div
              ref={bind.cta}
              style={{ ...REST.cta, pointerEvents: "none" }}
              className="absolute inset-x-5 bottom-5 z-10 grid gap-2 focus-within:!pointer-events-auto focus-within:!opacity-100 focus-within:![transform:none] motion-reduce:static motion-reduce:mt-6 motion-reduce:!pointer-events-auto motion-reduce:!opacity-100 motion-reduce:![transform:none] sm:flex sm:justify-center md:static md:mt-8 md:justify-start md:motion-reduce:justify-center"
            >
              <Button asChild size="lg" className="group">
                <Link href="/play"><Camera aria-hidden="true" className="group-hover:animate-wiggle motion-reduce:animate-none" /> Play free — no app needed</Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link href="#how-it-works"><ArrowDown aria-hidden="true" /> How it works</Link>
              </Button>
            </div>
          </div>

          {/* the pinned stage (decorative) */}
          <div ref={areaRef} className="relative min-h-0 motion-reduce:hidden md:h-[min(100%,680px)]">
            <div
              ref={stageRef}
              aria-hidden="true"
              className="absolute left-1/2 top-1/2 h-[600px] w-[440px] select-none [--fit:0.6] [transform:translate(-50%,-50%)_scale(var(--fit))] md:[--fit:1]"
            >
              <div ref={bind.group} style={REST.group} className="absolute inset-0">
                <div ref={bind.rigMorph} style={REST.rigMorph} className="absolute inset-0">
                  <div ref={bind.rigSlide} className="absolute inset-0">
                    <div ref={bind.kick} className="absolute inset-0">
                      {/* the card: one pre-rendered layer (shadow included) that turns, stretches and fades */}
                      <div ref={bind.card} style={REST.card} className={cn(C, "h-[216px] w-[352px] rounded-[30px] bg-card shadow-[0_30px_60px_-24px_rgb(42_15_92/0.55)]")}>
                        <span className="absolute left-5 top-4 rounded-full bg-secondary px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide text-primary">Round 1</span>
                        {/* "shout" lines off the card's corner */}
                        <svg ref={bind.shout} style={REST.shout} viewBox="0 0 60 60" className="absolute -left-9 -top-10 w-[60px] text-brand-coral" fill="none" stroke="currentColor" strokeWidth="6" strokeLinecap="round">
                          <path d="M30 8v14M8 30h14M14 14l9 9" />
                        </svg>
                      </div>

                      {/* the phone: the other pre-rendered layer (bezel, screen, island), turned upright by the morph */}
                      <div ref={bind.phone} style={REST.phone} className={cn(C, "h-[510px] w-[250px] rounded-[46px] bg-brand-night p-[9px] shadow-[0_30px_60px_-24px_rgb(42_15_92/0.55)]")}>
                        <div className="relative size-full overflow-hidden rounded-[37px] bg-background">
                          {/* the player's prompt screen */}
                          <span className={cn(C, "flex h-12 w-[180px] -translate-x-1/2 translate-y-[166px] items-center justify-center gap-2 rounded-2xl bg-brand-coral font-display text-lg font-bold text-white shadow-pop-coral")}>
                            <Camera className="size-5" /> Open camera
                          </span>
                          <span className={cn(C, "grid -translate-x-1/2 -translate-y-1/2 justify-items-center gap-1 text-center text-sm font-semibold text-muted-foreground")}>
                            <span className="grid size-16 place-items-center rounded-full border-2 border-dashed border-primary/30 text-primary"><Camera className="size-7" /></span>
                            Find it. Snap it.
                          </span>
                          {/* the camera */}
                          <div ref={bind.camera} style={REST.camera} className="absolute inset-0 bg-brand-night">
                            <div ref={bind.scene} style={REST.scene} className={cn(C, "h-[520px] w-[380px]")}>
                              <Backdrop className="absolute inset-0" />
                            </div>
                            <div className="absolute inset-0">
                              <span className="absolute inset-y-0 left-1/3 w-px bg-white/25" />
                              <span className="absolute inset-y-0 left-2/3 w-px bg-white/25" />
                              <span className="absolute inset-x-0 top-1/3 h-px bg-white/25" />
                              <span className="absolute inset-x-0 top-2/3 h-px bg-white/25" />
                            </div>
                            <div ref={bind.item} style={REST.item} className={cn(C, "w-[168px]")}>
                              <item.Art className="block w-full" />
                            </div>
                            <span ref={bind.bTL} style={REST.bTL} className={cn(C, corner, "rounded-tl-xl border-l-4 border-t-4")} />
                            <span ref={bind.bTR} style={REST.bTR} className={cn(C, corner, "rounded-tr-xl border-r-4 border-t-4")} />
                            <span ref={bind.bBL} style={REST.bBL} className={cn(C, corner, "rounded-bl-xl border-b-4 border-l-4")} />
                            <span ref={bind.bBR} style={REST.bBR} className={cn(C, corner, "rounded-br-xl border-b-4 border-r-4")} />
                            <span className={cn(C, "flex -translate-x-1/2 -translate-y-[150px] items-center gap-1 rounded-full bg-black/35 px-3 py-1 font-mono text-sm font-bold tabular-nums text-white")}>
                              <Timer className="size-4 text-brand-yellow" />
                              <span ref={bind.timer}>{fmtTime(0)}</span>
                            </span>
                            {(["d3", "d2", "d1"] as const).map((k, i) => (
                              <span key={k} ref={bind[k]} style={REST[k]} className={cn(C, "font-display text-[96px] font-bold leading-none text-brand-yellow [text-shadow:0_6px_0_hsl(var(--brand-yellow-deep))]")}>{3 - i}</span>
                            ))}
                            <span ref={bind.shutter} style={REST.shutter} className={cn(C, "grid size-[62px] place-items-center rounded-full border-4 border-white p-1")}>
                              <span className="size-full rounded-full bg-brand-coral" />
                            </span>
                            <span ref={bind.flash} style={REST.flash} className="absolute inset-0 bg-white" />
                          </div>
                        </div>
                        <span className="absolute left-1/2 top-[15px] h-[26px] w-[84px] -translate-x-1/2 rounded-full bg-black" />
                      </div>

                      {/* the prompt (shrinks from the card into the phone screen, then up into the camera HUD) */}
                      <div ref={bind.promptOuter} style={REST.promptOuter} className={cn(C, "w-[310px] text-center")}>
                        <div ref={bind.promptInner} className="relative">
                          <span key={item.key} className="block animate-pop-in"><PromptText item={item} /></span>
                          <span ref={bind.promptLight} style={REST.promptLight} className="absolute inset-0">
                            <span key={item.key} className="block animate-pop-in"><PromptText item={item} light /></span>
                          </span>
                        </div>
                      </div>

                      {/* Snappy: beside the card, then the phone's lens */}
                      <div ref={bind.snappyOuter} style={REST.snappyOuter} className={cn(C, "w-[120px]")}>
                        <div ref={bind.snappyInner} className="relative">
                          <Mascot mood="happy" className="block w-full" />
                          <span ref={bind.cheer} style={{ ...REST.cheer, display: "none" }} className="absolute inset-0"><Mascot mood="cheer" className="block w-full" /></span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* locked in */}
                <div ref={bind.polaroid} style={REST.polaroid} className={C}>
                  <div ref={bind.polaroidInner}><Polaroid item={item} /></div>
                </div>
                <div ref={bind.locked} style={REST.locked} className={C}><LockedBadge /></div>
                <div ref={bind.crown} style={REST.crown} className={C}><CrownBadge /></div>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setMuted((m) => !m)}
              aria-pressed={!muted}
              aria-label="Shutter sound"
              title={muted ? "Sound off" : "Sound on"}
              className="absolute right-0 top-0 z-10 grid size-10 place-items-center rounded-full bg-primary/10 text-primary transition-colors hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring"
            >
              {muted ? <VolumeX aria-hidden="true" className="size-5" /> : <Volume2 aria-hidden="true" className="size-5" />}
            </button>
          </div>

          {/* reduced motion: the round in three still steps */}
          <ol ref={stepsRef} aria-label="A round in three steps" className="hidden gap-6 motion-reduce:mt-10 motion-reduce:grid sm:grid-cols-3">
            <li className="grid justify-items-center gap-4 text-center" style={{ "--i": 0 } as React.CSSProperties}>
              <div aria-hidden="true" className="relative grid h-64 place-items-center">
                <div className="relative w-64 -rotate-2 rounded-[1.75rem] bg-card px-5 py-7 shadow-card">
                  <PromptText item={SNAP_ITEMS[0]} />
                  <Mascot mood="happy" className="absolute -bottom-8 -right-6 w-20 rotate-6" />
                </div>
              </div>
              <p className="font-display text-xl font-bold text-primary"><span className="text-brand-coral">1.</span> The host shouts an item</p>
            </li>
            <li className="grid justify-items-center gap-4 text-center" style={{ "--i": 1 } as React.CSSProperties}>
              <div aria-hidden="true" className="relative grid h-64 place-items-center">
                <div className="relative h-64 w-32 overflow-hidden rounded-[1.6rem] border-[5px] border-brand-night bg-brand-night shadow-card">
                  <Backdrop className="absolute inset-0 rounded-[1.2rem]" />
                  <span className="absolute left-1/2 top-2 h-3.5 w-12 -translate-x-1/2 rounded-full bg-black" />
                  <span className="absolute left-1/2 top-10 -translate-x-1/2 rounded-full bg-black/35 px-2 py-0.5 font-mono text-[0.65rem] font-bold text-white">{fmtTime(STORYBOARD.winTime)}</span>
                  {(() => { const Art = SNAP_ITEMS[0].Art; return <Art className="absolute left-1/2 top-1/2 w-24 -translate-x-1/2 -translate-y-1/2" />; })()}
                  <span className="absolute left-1/2 top-1/2 h-20 w-24 -translate-x-1/2 -translate-y-1/2 rounded-lg border-2 border-white/90" />
                  <span className="absolute bottom-3 left-1/2 grid size-9 -translate-x-1/2 place-items-center rounded-full border-[3px] border-white p-0.5"><span className="size-full rounded-full bg-brand-coral" /></span>
                </div>
              </div>
              <p className="font-display text-xl font-bold text-primary"><span className="text-brand-coral">2.</span> Everyone runs and snaps it</p>
            </li>
            <li className="grid justify-items-center gap-4 text-center" style={{ "--i": 2 } as React.CSSProperties}>
              <div aria-hidden="true" className="relative grid h-64 place-items-center">
                <div className="relative rotate-3 scale-90">
                  <Polaroid item={SNAP_ITEMS[0]} />
                  <CrownBadge className="absolute -left-6 -top-6 size-14 -rotate-12 [&_svg]:size-7" />
                  <LockedBadge className="absolute -bottom-9 -right-8 -rotate-6" />
                </div>
              </div>
              <p className="font-display text-xl font-bold text-primary"><span className="text-brand-coral">3.</span> The fastest snap is locked in</p>
            </li>
          </ol>
        </div>

        <span ref={bind.roomFlash} aria-hidden="true" style={REST.roomFlash} className="pointer-events-none absolute inset-0 bg-white motion-reduce:hidden" />
        {burst > 0 ? <Confetti key={burst} once pieces={36} /> : null}
      </div>
    </section>
  );
}
