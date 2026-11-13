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

import { SNAP_ITEMS, type SnapItem } from "./items";

/* ================================================================================================
 * STORYBOARD: every timing in the section. Phases are [start, end] fractions of the pinned scroll
 * (0 = pin starts, 1 = pin ends). Each phase's sub-steps are placed as fractions *inside* it, so moving
 * or resizing a phase carries its contents along.
 * ============================================================================================== */
export const STORYBOARD = {
  /** Scroll distance while pinned, in % of the viewport height (svh: steady while mobile toolbars slide). */
  pin: { mobile: 200, desktop: 250 },
  /** Desktop layout from this width up (Tailwind `md`). */
  desktopFrom: 768,
  /** Scrub smoothing time constant (s): how quickly the scene catches up with the scrollbar. 0 = locked to it. */
  scrub: 0.14,
  phases: {
    prompt: [0, 0.15], //     "Bring me… a red stapler!" card + Snappy
    morph: [0.15, 0.35], //   card → phone; Snappy hops on and becomes the lens
    viewfinder: [0.35, 0.55], // camera UI, 3-2-1, timer runs, the item drifts into frame
    snap: [0.55, 0.65], //    focus brackets close in, shutter
    locked: [0.65, 0.85], //  polaroid slides out, "Locked in!" springs
    win: [0.85, 1], //        crown, confetti, CTA
  },
  /** When the shutter fires, as a fraction of the snap phase. */
  shutterAt: 0.45,
  /** The time frozen on screen when the shutter fires. */
  winTime: 7.412,
  /** The snap plays on the clock (ms), so it stays sharp at any scroll speed. */
  flashMs: 120,
  punchMs: 220,
  shakeMs: 380,
} as const;

/* ------------------------------------------- math ------------------------------------------- */

type Win = readonly [number, number];
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** 0 → 1 as q crosses the window. */
const prog = (q: number, w: Win) => clamp01((q - w[0]) / (w[1] - w[0]));
/** The part of a phase from fraction a to b. */
const sub = (w: Win, a: number, b: number): Win => [lerp(w[0], w[1], a), lerp(w[0], w[1], b)];
/** 0 → 1 → 0. */
const bump = (t: number) => Math.sin(Math.PI * clamp01(t));
const ease = {
  out: (t: number) => 1 - (1 - t) ** 3,
  inOut: (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2),
  /** overshoots, then settles (pops) */
  back: (t: number, s = 1.9) => (t >= 1 ? 1 : 1 + (s + 1) * (t - 1) ** 3 + s * (t - 1) ** 2),
  /** a damped spring: ~18% overshoot, one wobble */
  spring: (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : 1 - Math.exp(-6.5 * t) * Math.cos(12 * t)),
};
const r2 = (v: number) => Math.round(v * 100) / 100;
const tf = (x: number, y: number, rot = 0, s = 1) =>
  `translate(-50%,-50%) translate(${r2(x)}px,${r2(y)}px) rotate(${r2(rot)}deg) scale(${Math.round(s * 1000) / 1000})`;
const SHUTTER = lerp(STORYBOARD.phases.snap[0], STORYBOARD.phases.snap[1], STORYBOARD.shutterAt);
const CONFETTI_AT = lerp(STORYBOARD.phases.win[0], STORYBOARD.phases.win[1], 0.1);
const fmtTime = (s: number) => `${s.toFixed(3).padStart(6, "0")}s`;

/* ----------------------------------------- geometry ----------------------------------------- */
// Design units (px inside the stage, which is scaled to fit its area). Origin = stage centre.
const W = 440;
const H = 600;
const CARD = { w: 352, h: 216, r: 30 };
const PHONE = { w: 250, h: 510, r: 46, bezel: 9 };
const LENS_Y = -PHONE.h / 2 + 27;
const ITEM_Y = 14;
const LAYOUTS = {
  desktop: { phoneX: -80, polaroid: { x: 120, y: 30, rot: 7, s: 1 } },
  mobile: { phoneX: -60, polaroid: { x: 92, y: 64, rot: 7, s: 0.9 } },
};
type Layout = { mobile: boolean; /** room the mobile CTA needs at the bottom (design units) */ ctaRoom: number };

/* ------------------------------------------ frame ------------------------------------------- */

const PARTS = [
  "group", "rig", "kick", "shout", "shell", "cardFace", "bezel", "screen", "camera", "scene", "item", "grid",
  "lightUi", "bTL", "bTR", "bBL", "bBR", "shutter", "d3", "d2", "d1", "island", "prompt", "promptLight", "snappy",
  "cheer", "polaroid", "locked", "crown", "cta", "flash", "roomFlash", "timer",
] as const;
type Part = (typeof PARTS)[number];
type St = { t?: string; o?: number; w?: number; h?: number; r?: number };
type Frame = Partial<Record<Part, St>> & { time: number; ctaIn: number };

/** The whole scene at scroll progress q (0–1). Pure: the same q always draws the same frame. */
function frame(q: number, L: Layout): Frame {
  const P = STORYBOARD.phases;
  const lay = L.mobile ? LAYOUTS.mobile : LAYOUTS.desktop;

  // PROMPT: the shout (the card pumps, Snappy jumps)
  const shout = bump(prog(q, P.prompt));

  // MORPH: card → phone (the one layout animation: size + radius)
  const m = ease.inOut(prog(q, sub(P.morph, 0, 0.85)));
  const w = lerp(CARD.w, PHONE.w, m);
  const h = lerp(CARD.h, PHONE.h, m);
  const r = lerp(CARD.r, PHONE.r, m);
  const toScreen = ease.inOut(prog(q, sub(P.morph, 0.1, 0.85)));
  const cam = ease.out(prog(q, sub(P.viewfinder, 0, 0.22)));

  // the phone as a whole: tilt settles, slides aside for the polaroid, then settles again
  const slide = ease.inOut(prog(q, sub(P.locked, 0.05, 0.55)));
  const settle = ease.out(prog(q, sub(P.win, 0.3, 0.9)));
  const rigX = lay.phoneX * slide;
  const rigRot = lerp(-3, 0, ease.out(prog(q, sub(P.morph, 0, 0.6)))) - 4 * slide + 2.5 * settle;

  // Snappy hops onto the phone (with a flip) and becomes the lens; cheers at the win
  const hop = prog(q, sub(P.morph, 0.3, 0.95));
  const he = ease.inOut(hop);
  const cheerPop = ease.spring(prog(q, sub(P.win, 0, 0.35)));

  // VIEWFINDER: looking around, then the item drifts into frame; a handheld wobble until the shutter
  const vf = P.viewfinder;
  const pan = ease.out(prog(q, sub(vf, 0.3, 1)));
  const itemIn = prog(q, sub(vf, 0.55, 1));
  const sway = (1 - prog(q, [SHUTTER - 0.03, SHUTTER])) * cam;
  const swX = Math.sin(q * 90) * 3 * sway;
  const swY = Math.cos(q * 70) * 2 * sway;
  const digit = (k: number): St => {
    const t = prog(q, sub(vf, 0.16 + k * 0.13, 0.16 + (k + 1) * 0.13));
    const inn = clamp01(t / 0.3);
    const out = clamp01((t - 0.72) / 0.28);
    return { t: tf(0, ITEM_Y, 0, lerp(1.9, 1, ease.back(inn, 2.2)) * lerp(1, 0.7, out)), o: r2(Math.min(inn * 3, 1) * (1 - out)) };
  };
  const timerStart = sub(vf, 0.55, 0.55)[0];

  // SNAP: brackets close in on the item (springy), the shutter button presses
  const lock = ease.back(prog(q, sub(P.snap, 0, 0.42)), 2.4);
  const bx = lerp(98, 80, lock);
  const by = lerp(196, 58, lock);
  const press = 1 - 0.16 * bump(prog(q, [SHUTTER - 0.012, SHUTTER + 0.025]));

  // LOCKED IN: the frame lifts out of the phone as a polaroid
  const pe = prog(q, sub(P.locked, 0, 0.55));
  const pm = ease.back(pe, 1.25);
  const pol = lay.polaroid;
  const px = lerp(0, pol.x, pm);
  const py = lerp(ITEM_Y, pol.y, pm) - Math.sin(Math.PI * pe) * 46;
  const prot = lerp(0, pol.rot, ease.out(pe));
  const ps = lerp(0.74, pol.s, ease.out(pe));
  const winPop = 1 + 0.05 * bump(prog(q, sub(P.win, 0, 0.3)));
  // badges ride on the polaroid's corners
  const corner = (dx: number, dy: number) => {
    const a = (prot * Math.PI) / 180;
    return [px + (dx * Math.cos(a) - dy * Math.sin(a)) * ps, py + (dx * Math.sin(a) + dy * Math.cos(a)) * ps] as const;
  };
  const lockT = prog(q, sub(P.locked, 0.5, 0.85));
  const [lx, ly] = corner(58, 124);
  const crownT = prog(q, sub(P.win, 0.02, 0.32));
  const [cx, cy] = corner(-84, -126);

  // WIN (phones): the scene shrinks up a little to make room for the CTA
  const room = L.mobile ? L.ctaRoom * ease.inOut(prog(q, sub(P.win, 0.2, 0.7))) : 0;
  const gk = (H - room) / H;

  return {
    group: { t: `translate(0px,${r2(-room / 2)}px) scale(${Math.round(gk * 1000) / 1000})` },
    rig: { t: `translate(${r2(rigX)}px,0px) rotate(${r2(rigRot)}deg) scale(${r2(1 + 0.045 * shout)})` },
    shout: { t: tf(-182, -118, -8, 1 + 0.35 * shout), o: r2(1 - prog(q, sub(P.morph, 0, 0.3))) },
    shell: { w: r2(w), h: r2(h), r: r2(r) },
    // the light screen fades in over the white card first, so the bezel only ever shows as a growing dark rim
    cardFace: { o: r2(1 - prog(q, sub(P.morph, 0.3, 0.5))) },
    bezel: { o: r2(prog(q, sub(P.morph, 0.15, 0.45))) },
    screen: { o: r2(prog(q, sub(P.morph, 0.05, 0.3))), r: r2(Math.max(0, r - PHONE.bezel)) },
    lightUi: { o: r2(prog(q, sub(P.morph, 0.65, 0.95))) },
    island: { o: r2(prog(q, sub(P.morph, 0.55, 0.9))) },
    camera: { o: r2(cam) },
    scene: { t: tf(lerp(70, 0, pan) + swX, swY) },
    item: { t: tf(lerp(190, 0, ease.back(itemIn, 1.4)) + swX * 1.4, ITEM_Y + swY, lerp(22, -4, ease.out(itemIn))) },
    grid: { o: r2(cam * 0.9) },
    bTL: { t: tf(-bx, ITEM_Y - by) },
    bTR: { t: tf(bx, ITEM_Y - by) },
    bBL: { t: tf(-bx, ITEM_Y + by) },
    bBR: { t: tf(bx, ITEM_Y + by) },
    shutter: { t: tf(0, 196, 0, press) },
    d3: digit(0),
    d2: digit(1),
    d1: digit(2),
    prompt: { t: tf(0, lerp(lerp(-4, -150, toScreen), -180, cam), 0, lerp(lerp(1, 0.66, toScreen), 0.5, cam)) },
    promptLight: { o: r2(cam) },
    snappy: {
      t: tf(
        lerp(150, 0, he),
        lerp(98, LENS_Y, he) - Math.sin(Math.PI * hop) * 130 - shout * 18 - 6 * cheerPop,
        lerp(10, 0, he) - 360 * he,
        lerp(1, 0.36, he) + 0.08 * cheerPop,
      ),
    },
    cheer: { o: r2(prog(q, sub(P.win, 0, 0.1))) },
    polaroid: { t: tf(px, py, prot, ps * winPop), o: r2(prog(q, sub(P.locked, 0, 0.06))) },
    locked: { t: tf(lx, ly, prot - 10, ease.spring(lockT) * ps), o: r2(clamp01(lockT * 5)) },
    crown: { t: tf(cx, cy, prot - 22 + lerp(-40, 0, ease.out(crownT)), ease.spring(crownT) * ps), o: r2(clamp01(crownT * 5)) },
    time: STORYBOARD.winTime * prog(q, [timerStart, SHUTTER]),
    ctaIn: ease.out(prog(q, sub(P.win, 0.35, 0.85))),
  };
}

const toReact = (s: St | undefined): React.CSSProperties | undefined =>
  s && { transform: s.t, opacity: s.o, width: s.w, height: s.h, borderRadius: s.r };
/** Server render = the first frame, so the page paints the resting state and hydration changes nothing. */
const FIRST = frame(0, { mobile: false, ctaRoom: 0 });
const INIT = Object.fromEntries(PARTS.map((k) => [k, toReact(FIRST[k])])) as Record<Part, React.CSSProperties | undefined>;
const CTA_INIT: React.CSSProperties = { opacity: 0, transform: "translateY(16px)" };

/* ------------------------------------------ pieces ------------------------------------------ */

const C = "absolute left-1/2 top-1/2";
type Styled = HTMLElement | SVGElement;

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

/* ---------------------------------------- the section ---------------------------------------- */

/**
 * "One shout. Everyone runs.": a pinned, scroll-scrubbed replay of one round (see STORYBOARD above).
 * The pin is CSS `position: sticky` (compositor-driven, so no iOS jitter); a small rAF loop eases the
 * scene towards the scroll position and draws `frame(q)`. Transforms and opacity only, except the
 * card → phone size morph. Reduced motion: no pin, a static three-step version.
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
  /** Last value written per element and property (skips redundant style writes). Cleared when React swaps a node. */
  const written = useRef<Partial<Record<Part, St>>>({});
  const [bind] = useState(() => Object.fromEntries(PARTS.map((k) => [k, (el: Styled | null) => {
    if (els.current[k] !== el) delete written.current[k];
    els.current[k] = el;
  }])) as Record<Part, (el: Styled | null) => void>);

  const click = useShutterSound();
  const sound = useRef({ on: true, click });
  useEffect(() => { sound.current = { on: !muted, click }; });
  // Sound is on by default, but browsers only allow audio after a real gesture (click, tap, key; a scroll
  // doesn't count). Use the browser's own flag where it exists, else watch for one.
  const interacted = useRef(false);
  useEffect(() => {
    const mark = () => { interacted.current = true; };
    window.addEventListener("pointerup", mark, { once: true, capture: true });
    window.addEventListener("keydown", mark, { once: true, capture: true });
    return () => { window.removeEventListener("pointerup", mark, { capture: true }); window.removeEventListener("keydown", mark, { capture: true }); };
  }, []);
  const canPlay = () => (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive ?? interacted.current;
  const canPlayRef = useRef(canPlay);

  // Fit the stage to its area right away (cheap); the scroll loop itself starts lazily (below).
  useEffect(() => {
    const area = areaRef.current, stage = stageRef.current;
    if (!area || !stage) return;
    const fit = () => {
      const s = Math.min(area.clientWidth / W, area.clientHeight / H, 1.1);
      if (s > 0) stage.style.setProperty("--fit", String(Math.round(s * 1000) / 1000));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(area);
    return () => ro.disconnect();
  }, []);

  // The scroll engine.
  useEffect(() => {
    const section = sectionRef.current, pin = pinRef.current, area = areaRef.current, stage = stageRef.current;
    if (!section || !pin || !area || !stage) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const prev = written.current;
    let layout: Layout = { mobile: false, ctaRoom: 0 };
    let shown = -1; // drawn progress (-1 = nothing drawn yet: jump straight to the scroll position)
    let raf = 0, last = 0, visible = false, running = false;
    let kickAt = -1, kicked = false, played = false, confetti = false;
    let lastTime = "";

    const write = (k: Part, s: St | undefined) => {
      const el = els.current[k];
      if (!el || !s) return;
      const p = (prev[k] ??= {});
      if (s.t !== undefined && s.t !== p.t) el.style.transform = p.t = s.t;
      if (s.o !== undefined && s.o !== p.o) el.style.opacity = String((p.o = s.o));
      if (s.w !== undefined && s.w !== p.w) el.style.width = `${(p.w = s.w)}px`;
      if (s.h !== undefined && s.h !== p.h) el.style.height = `${(p.h = s.h)}px`;
      if (s.r !== undefined && s.r !== p.r) el.style.borderRadius = `${(p.r = s.r)}px`;
    };
    const draw = (q: number) => {
      const f = frame(q, layout);
      for (const k of PARTS) write(k, f[k]);
      const time = fmtTime(f.time);
      const timer = els.current.timer;
      if (timer && time !== lastTime) timer.textContent = lastTime = time;
      const cta = els.current.cta;
      if (cta) {
        write("cta", { o: r2(f.ctaIn), t: `translateY(${r2((1 - f.ctaIn) * 16)}px)` });
        cta.style.pointerEvents = f.ctaIn > 0.5 ? "" : "none";
      }
    };
    /** The snap: flash, punch and a tiny shake, on the clock. */
    const drawKick = (now: number) => {
      const t = kickAt < 0 ? Infinity : now - kickAt;
      const { flashMs, punchMs, shakeMs } = STORYBOARD;
      const active = t < Math.max(flashMs, punchMs, shakeMs);
      if (!active && !kicked) return false;
      kicked = active;
      const fl = !active ? 0 : t < flashMs * 0.3 ? t / (flashMs * 0.3) : Math.max(0, 1 - (t - flashMs * 0.3) / (flashMs * 0.7));
      const amp = active ? Math.max(0, 1 - t / shakeMs) ** 2 : 0;
      const punch = active && t < punchMs ? 1 + 0.03 * Math.sin((Math.PI * t) / punchMs) : 1;
      write("kick", { t: `translate(${r2(5 * amp * Math.sin(t * 0.14))}px,${r2(3 * amp * Math.cos(t * 0.17))}px) rotate(${r2(0.8 * amp * Math.sin(t * 0.11))}deg) scale(${r2(punch * 1000) / 1000})` });
      write("flash", { o: r2(fl) });
      write("roomFlash", { o: r2(fl * 0.35) });
      return active;
    };

    const measure = () => {
      const vw = document.documentElement.clientWidth;
      const mobile = vw < STORYBOARD.desktopFrom;
      let ctaRoom = 0;
      const cta = els.current.cta as HTMLElement | null | undefined;
      const s = parseFloat(stage.style.getPropertyValue("--fit")) || 1;
      if (mobile && cta) {
        // the CTA is laid over the bottom of the stage area: measure the overlap (layout boxes, not transforms)
        const overlap = area.offsetTop + area.offsetHeight - cta.offsetTop + 12;
        ctaRoom = Math.max(0, overlap) / s;
      }
      layout = { mobile, ctaRoom: Math.min(ctaRoom, H * 0.4) };
      for (const k of PARTS) delete prev[k];
      if (shown >= 0) draw(shown);
    };

    const tick = (now: number) => {
      raf = 0;
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
      last = now;
      const box = section.getBoundingClientRect();
      const len = box.height - pin.offsetHeight;
      const target = len > 0 ? clamp01(-box.top / len) : 0;
      let q = shown < 0 || STORYBOARD.scrub <= 0 ? target : shown + (target - shown) * (1 - Math.exp(-dt / STORYBOARD.scrub));
      if (Math.abs(target - q) < 0.0005) q = target;
      const from = shown < 0 ? q : shown;

      // one-shot moments, forward only (the scrubbed state itself is reversible)
      if (from < SHUTTER && q >= SHUTTER) {
        kickAt = now;
        if (sound.current.on && canPlayRef.current()) sound.current.click();
      }
      if (!confetti && q >= CONFETTI_AT && from < CONFETTI_AT) { confetti = true; setBurst((b) => b + 1); }
      if (confetti && q < CONFETTI_AT - 0.03) { confetti = false; setBurst(0); }
      // the rotation: back above the section → the host calls the next item
      if (q > 0.1) played = true;
      if (played && target <= 0 && box.top > 0) { played = false; setIndex((i) => (i + 1) % SNAP_ITEMS.length); }

      if (q !== shown) { draw(q); shown = q; }
      const kicking = drawKick(now);
      if (visible && (q !== target || kicking)) raf = requestAnimationFrame(tick);
      else last = 0;
    };
    const wake = () => { if (running && !raf) raf = requestAnimationFrame(tick); };

    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; wake(); }, { rootMargin: "10% 0px" });
    let resizeQueued = 0;
    const onResize = () => { cancelAnimationFrame(resizeQueued); resizeQueued = requestAnimationFrame(() => { measure(); wake(); }); };
    const ro = new ResizeObserver(onResize);

    const start = () => {
      if (running || reduced.matches) return;
      running = true;
      measure();
      io.observe(section);
      ro.observe(pin);
      window.addEventListener("scroll", wake, { passive: true });
      window.addEventListener("resize", onResize);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(raf); raf = 0; last = 0;
      io.disconnect(); ro.disconnect();
      window.removeEventListener("scroll", wake);
      window.removeEventListener("resize", onResize);
    };

    // Lazy init: after the page (hero) has loaded and the main thread is idle, or as soon as the section
    // comes near the viewport, whichever is first. Never competes with the hero's LCP.
    let idle = 0, timer = 0;
    const hasIdle = "requestIdleCallback" in window;
    const onLoad = () => { idle = hasIdle ? window.requestIdleCallback(start, { timeout: 1500 }) : window.setTimeout(start, 200); };
    if (document.readyState === "complete") onLoad();
    else window.addEventListener("load", onLoad, { once: true });
    const near = new IntersectionObserver(([e]) => { if (e.isIntersecting) { near.disconnect(); timer = window.setTimeout(start, 0); } }, { rootMargin: "75% 0px" });
    near.observe(section);

    const onMotionPref = () => { if (reduced.matches) stop(); else start(); };
    reduced.addEventListener("change", onMotionPref);
    return () => {
      stop();
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
              style={CTA_INIT}
              className="absolute inset-x-5 bottom-5 z-10 grid gap-2 focus-within:!opacity-100 focus-within:![transform:none] motion-reduce:static motion-reduce:mt-6 motion-reduce:!opacity-100 motion-reduce:![transform:none] sm:flex sm:justify-center md:static md:mt-8 md:justify-start md:motion-reduce:justify-center"
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
              <div ref={bind.group} style={INIT.group} className="absolute inset-0">
                {/* "shout" lines off the card's corner */}
                <svg ref={bind.shout} style={INIT.shout} viewBox="0 0 60 60" className={cn(C, "w-[60px] text-brand-coral")} fill="none" stroke="currentColor" strokeWidth="6" strokeLinecap="round">
                  <path d="M30 8v14M8 30h14M14 14l9 9" />
                </svg>

                <div ref={bind.rig} style={INIT.rig} className="absolute inset-0">
                  <div ref={bind.kick} className="absolute inset-0">
                    {/* card → phone */}
                    <div ref={bind.shell} style={INIT.shell} className={cn(C, "-translate-x-1/2 -translate-y-1/2 overflow-hidden shadow-[0_30px_60px_-24px_rgb(42_15_92/0.55)]")}>
                      <div ref={bind.bezel} style={INIT.bezel} className="absolute inset-0 bg-brand-night" />
                      <div ref={bind.cardFace} style={INIT.cardFace} className="absolute inset-0 bg-card">
                        <span className="absolute left-5 top-4 rounded-full bg-secondary px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide text-primary">Round 1</span>
                      </div>
                      <div ref={bind.screen} style={INIT.screen} className="absolute inset-[9px] overflow-hidden bg-background">
                        {/* the player's prompt screen */}
                        <div ref={bind.lightUi} style={INIT.lightUi} className="absolute inset-0">
                        <span className={cn(C, "flex h-12 w-[180px] -translate-x-1/2 translate-y-[166px] items-center justify-center gap-2 rounded-2xl bg-brand-coral font-display text-lg font-bold text-white shadow-pop-coral")}>
                          <Camera className="size-5" /> Open camera
                        </span>
                        <span className={cn(C, "grid -translate-x-1/2 -translate-y-1/2 justify-items-center gap-1 text-center text-sm font-semibold text-muted-foreground")}>
                          <span className="grid size-16 place-items-center rounded-full border-2 border-dashed border-primary/30 text-primary"><Camera className="size-7" /></span>
                          Find it. Snap it.
                        </span>
                        </div>
                        {/* the camera */}
                        <div ref={bind.camera} style={INIT.camera} className="absolute inset-0 bg-brand-night">
                          <div ref={bind.scene} style={INIT.scene} className={cn(C, "h-[520px] w-[380px]")}>
                            <Backdrop className="absolute inset-0" />
                          </div>
                          <div ref={bind.grid} style={INIT.grid} className="absolute inset-0">
                            <span className="absolute inset-y-0 left-1/3 w-px bg-white/25" />
                            <span className="absolute inset-y-0 left-2/3 w-px bg-white/25" />
                            <span className="absolute inset-x-0 top-1/3 h-px bg-white/25" />
                            <span className="absolute inset-x-0 top-2/3 h-px bg-white/25" />
                          </div>
                          <div ref={bind.item} style={INIT.item} className={cn(C, "w-[168px]")}>
                            <item.Art className="block w-full" />
                          </div>
                          <span ref={bind.bTL} style={INIT.bTL} className={cn(C, corner, "rounded-tl-xl border-l-4 border-t-4")} />
                          <span ref={bind.bTR} style={INIT.bTR} className={cn(C, corner, "rounded-tr-xl border-r-4 border-t-4")} />
                          <span ref={bind.bBL} style={INIT.bBL} className={cn(C, corner, "rounded-bl-xl border-b-4 border-l-4")} />
                          <span ref={bind.bBR} style={INIT.bBR} className={cn(C, corner, "rounded-br-xl border-b-4 border-r-4")} />
                          <span className={cn(C, "flex -translate-x-1/2 -translate-y-[150px] items-center gap-1 rounded-full bg-black/35 px-3 py-1 font-mono text-sm font-bold tabular-nums text-white")}>
                            <Timer className="size-4 text-brand-yellow" />
                            <span ref={bind.timer}>{fmtTime(0)}</span>
                          </span>
                          {(["d3", "d2", "d1"] as const).map((k, i) => (
                            <span key={k} ref={bind[k]} style={INIT[k]} className={cn(C, "font-display text-[96px] font-bold leading-none text-brand-yellow [text-shadow:0_6px_0_hsl(var(--brand-yellow-deep))]")}>{3 - i}</span>
                          ))}
                          <span ref={bind.shutter} style={INIT.shutter} className={cn(C, "grid size-[62px] place-items-center rounded-full border-4 border-white p-1")}>
                            <span className="size-full rounded-full bg-brand-coral" />
                          </span>
                          <span ref={bind.flash} style={{ opacity: 0 }} className="absolute inset-0 bg-white" />
                        </div>
                      </div>
                      <span ref={bind.island} style={INIT.island} className="absolute left-1/2 top-[15px] h-[26px] w-[84px] -translate-x-1/2 rounded-full bg-black" />
                    </div>

                    {/* the prompt (shrinks from the card into the phone screen) */}
                    <div ref={bind.prompt} style={INIT.prompt} className={cn(C, "w-[310px] text-center")}>
                      <div key={item.key} className="relative animate-pop-in">
                        <PromptText item={item} />
                        <span ref={bind.promptLight} style={INIT.promptLight} className="absolute inset-0"><PromptText item={item} light /></span>
                      </div>
                    </div>

                    {/* Snappy: beside the card, then the phone's lens */}
                    <div ref={bind.snappy} style={INIT.snappy} className={cn(C, "w-[120px]")}>
                      <Mascot mood="happy" className="block w-full" />
                      <span ref={bind.cheer} style={INIT.cheer} className="absolute inset-0"><Mascot mood="cheer" className="block w-full" /></span>
                    </div>
                  </div>
                </div>

                {/* locked in */}
                <div ref={bind.polaroid} style={INIT.polaroid} className={C}>
                  <Polaroid item={item} />
                </div>
                <div ref={bind.locked} style={INIT.locked} className={C}><LockedBadge /></div>
                <div ref={bind.crown} style={INIT.crown} className={C}><CrownBadge /></div>
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

        <span ref={bind.roomFlash} aria-hidden="true" style={{ opacity: 0 }} className="pointer-events-none absolute inset-0 bg-white motion-reduce:hidden" />
        {burst > 0 ? <Confetti key={burst} once pieces={36} /> : null}
      </div>
    </section>
  );
}
