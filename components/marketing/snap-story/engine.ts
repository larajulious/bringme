import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";

import {
  BRACKETS, CARD, CROWN_AT, H, ITEM_Y, LAYOUTS, LENS_Y, LOCKED_AT, PARTS, PHONE, fmtTime, polaroidCorner, restVars,
  type LayoutName, type Part, type Styled,
} from "./scene";

/* ------------------------------------------------------------------------------------------------
 * The snap story's engine (loaded lazily by SnapStory; never on the server, never with reduced motion).
 *
 * Stage-based playback: one paused master timeline holds every stage (labels "prompt" … "win"), each at its own
 * designed duration and easing. Scroll only picks the TARGET stage; the timeline then plays (or reverses) to that
 * label. Skipping stages with a fast scroll plays through them faster (up to `maxCatchUp`×), never jumps; the
 * "snap" stage always plays at 1× going forward. The one exception is the card → phone morph, which stays scrubbed
 * (its own timeline on a ScrollTrigger with a short scrub) so it feels directly controlled.
 *
 * Lenis smooths wheel scrolling (touch stays native) and drives ScrollTrigger from gsap.ticker; ScrollTrigger snaps
 * to the stage boundaries in the scroll direction once scrolling stops, so it never rests half-way through a motion.
 * Transforms and opacity only: the morph is a crossfade of two pre-rendered layers (card, phone) turning and
 * scaling, no width/height/radius/shadow animation.
 * ---------------------------------------------------------------------------------------------- */

export const STAGES = ["prompt", "morph", "viewfinder", "snap", "lockedIn", "win"] as const;
export type Stage = (typeof STAGES)[number];

export type StoryConfig = {
  pin: { mobile: number; desktop: number };
  desktopFrom: number;
  stageStart: Record<Stage, number>;
  durations: { prompt: number; viewfinder: number; snap: number; lockedIn: number; win: number };
  morph: { scrub: number };
  scrollSnap: { duration: { min: number; max: number }; delay: number; ease: string };
  maxCatchUp: number;
  shutterAt: number;
  winTime: number;
  flashMs: number;
  punchMs: number;
  shakeMs: number;
  lenis: { lerp: number };
};

type Options = {
  config: StoryConfig;
  section: HTMLElement;
  pin: HTMLElement;
  area: HTMLElement;
  stage: HTMLElement;
  els: Partial<Record<Part, Styled | null>>;
  /** The shutter fired (forward only). */
  onSnap: () => void;
  /** Confetti on (win reached) / off (reversed out of it). */
  onConfetti: (on: boolean) => void;
  /** Back above the section after playing it: the host calls the next item. */
  onNextItem: () => void;
};

gsap.registerPlugin(ScrollTrigger);

export function startSnapStory(o: Options): () => void {
  const { config: cfg, section, pin, area, stage } = o;
  const el = (k: Part) => o.els[k] as HTMLElement;
  const D = cfg.durations;

  /* ------------------------------------------- smooth scroll ------------------------------------------- */
  const lenis = new Lenis({ lerp: cfg.lenis.lerp, smoothWheel: true, syncTouch: false, autoRaf: false });
  lenis.on("scroll", ScrollTrigger.update);
  const raf = (time: number) => lenis.raf(time * 1000);
  gsap.ticker.add(raf);
  gsap.ticker.lagSmoothing(0);

  /** Scroll position (px) at a fraction of the pinned range. */
  const at = (f: number) => {
    const top = section.getBoundingClientRect().top + window.scrollY;
    return top + f * Math.max(1, section.offsetHeight - pin.offsetHeight);
  };
  const layoutName = (): LayoutName => (document.documentElement.clientWidth < cfg.desktopFrom ? "mobile" : "desktop");
  /** Room the phone CTA needs at the bottom of the stage (design px). It's laid over the stage area on phones. */
  const ctaRoom = () => {
    const cta = el("cta");
    if (layoutName() !== "mobile" || !cta) return 0;
    const s = parseFloat(stage.style.getPropertyValue("--fit")) || 1;
    return Math.min(H * 0.4, Math.max(0, area.offsetTop + area.offsetHeight - cta.offsetTop + 12) / s);
  };

  let dir = 1; // direction the stage timeline is moving (callbacks fire both ways)
  let target = 0; // target stage index
  let played = false;
  let driver: gsap.core.Timeline | null = null;
  let stageTl: gsap.core.Timeline;
  let labels: number[] = [];
  let snapSpan: [number, number] = [0, 0];
  let built = { layout: "" as LayoutName | "", room: -1 };
  const snapPoints = [0, ...STAGES.slice(2).map((s) => cfg.stageStart[s] + 0.004), 1];

  const ctx = gsap.context(() => {
    // resting pose (identical to the server render), then hand every part to GSAP
    for (const k of PARTS) if (k !== "timer" && o.els[k]) gsap.set(o.els[k]!, restVars(k));
    gsap.set(el("cta"), { pointerEvents: "none" });
  });

  /* ------------------------------------------ one-shot moments ------------------------------------------ */
  const kick = ctx.add(() => {
    const f = cfg.flashMs / 1000, p = cfg.punchMs / 1000, sh = cfg.shakeMs / 1000;
    return gsap.timeline({ paused: true })
      .to(el("flash"), { opacity: 1, duration: f * 0.3, ease: "power1.in" }, 0)
      .to(el("roomFlash"), { opacity: 0.35, duration: f * 0.3, ease: "power1.in" }, 0)
      .to([el("flash"), el("roomFlash")], { opacity: 0, duration: f * 0.7, ease: "power2.out" }, f * 0.3)
      .to(el("kick"), { scale: 1.03, duration: p / 2, ease: "power2.out", yoyo: true, repeat: 1 }, 0)
      .to(el("kick"), { keyframes: { x: [5, -4, 3, -2, 1, 0], y: [-3, 2, -2, 1, 0, 0], rotation: [0.8, -0.6, 0.4, -0.2, 0, 0] }, duration: sh, ease: "none" }, 0);
  }) as gsap.core.Timeline;

  // the shout: as the section comes in, the card pumps and Snappy jumps
  const shout = ctx.add(() => gsap.timeline({ paused: true, defaults: { yoyo: true, repeat: 1, duration: D.prompt / 2, ease: "power2.out" } })
    .to(el("rigMorph"), { scale: 1.045 }, 0)
    .to(el("snappyInner"), { y: -18 }, 0)
    .to(el("shout"), { scale: 1.35 }, 0)) as gsap.core.Timeline;

  /* ------------------------------------------- the stages ------------------------------------------- */
  function buildStages(layout: LayoutName, room: number) {
    const lay = LAYOUTS[layout];
    const pol = lay.polaroid;
    const tl = gsap.timeline({ paused: true });
    const { closed } = BRACKETS;

    // VIEWFINDER: camera UI on, prompt up into the HUD, 3-2-1, the item drifts into frame
    const VF = D.viewfinder;
    tl.to(el("camera"), { opacity: 1, duration: 0.3, ease: "power1.out" }, 0)
      .to(el("promptInner"), { y: (-180 + 150) / 0.66, scale: 0.5 / 0.66, duration: 0.35, ease: "power2.inOut" }, 0)
      .to(el("promptLight"), { opacity: 1, duration: 0.3, ease: "none" }, 0)
      .to(el("scene"), { x: 0, duration: VF, ease: "power2.out" }, 0);
    const c0 = 0.35, step = Math.min(0.42, (VF - c0 - 0.6) / 3);
    (["d3", "d2", "d1"] as const).forEach((k, i) => {
      const t = c0 + i * step;
      tl.to(el(k), { scale: 1, opacity: 1, duration: 0.2, ease: "back.out(2.2)" }, t)
        .to(el(k), { scale: 0.7, opacity: 0, duration: 0.12, ease: "power1.in" }, t + step * 0.72);
    });
    const timerStart = c0 + 3 * step;
    tl.to(el("item"), { x: 0, rotation: -4, duration: Math.min(0.9, VF - timerStart), ease: "back.out(1.4)" }, VF - Math.min(0.9, VF - timerStart));
    tl.addLabel("viewfinder", VF);

    // SNAP: brackets close on the item, shutter, the time freezes
    const S0 = VF, SHUT = S0 + Math.min(cfg.shutterAt, D.snap - 0.1);
    tl.to(el("bTL"), { x: -closed.x, y: ITEM_Y - closed.y, duration: 0.35, ease: "back.out(2.4)" }, S0)
      .to(el("bTR"), { x: closed.x, y: ITEM_Y - closed.y, duration: 0.35, ease: "back.out(2.4)" }, S0)
      .to(el("bBL"), { x: -closed.x, y: ITEM_Y + closed.y, duration: 0.35, ease: "back.out(2.4)" }, S0)
      .to(el("bBR"), { x: closed.x, y: ITEM_Y + closed.y, duration: 0.35, ease: "back.out(2.4)" }, S0)
      .to(el("shutter"), { scale: 0.84, duration: 0.06, ease: "power2.in" }, SHUT - 0.06)
      .to(el("shutter"), { scale: 1, duration: 0.25, ease: "back.out(3)" }, SHUT)
      .call(() => { if (dir > 0) { kick.restart(); o.onSnap(); } }, [], SHUT);
    const clock = { v: 0 };
    const timer = el("timer");
    tl.to(clock, { v: cfg.winTime, duration: SHUT - timerStart, ease: "none", onUpdate: () => { timer.textContent = fmtTime(clock.v); } }, timerStart);
    tl.addLabel("snap", S0 + D.snap);
    snapSpan = [S0, S0 + D.snap];

    // LOCKED IN: the phone slides aside, the frame lifts out as a polaroid, "Locked in!" springs
    const L0 = S0 + D.snap;
    const lk = polaroidCorner(layout, LOCKED_AT.dx, LOCKED_AT.dy);
    const cr = polaroidCorner(layout, CROWN_AT.dx, CROWN_AT.dy);
    gsap.set(el("locked"), { x: lk.x, y: lk.y, rotation: pol.rot - 10 });
    gsap.set(el("crown"), { x: cr.x, y: cr.y });
    const slide = Math.min(0.65, D.lockedIn * 0.6);
    tl.to(el("rigSlide"), { x: lay.phoneX, rotation: -4, duration: slide, ease: "power2.inOut" }, L0 + 0.05)
      .to(el("polaroid"), { opacity: 1, duration: 0.06, ease: "none" }, L0)
      .to(el("polaroid"), { x: pol.x, y: pol.y, duration: slide, ease: "back.out(1.25)" }, L0)
      .to(el("polaroid"), { rotation: pol.rot, scale: pol.s, duration: slide, ease: "power2.out" }, L0)
      .to(el("polaroidInner"), { y: -46, duration: slide / 2, ease: "power2.out", yoyo: true, repeat: 1 }, L0)
      .to(el("locked"), { opacity: 1, duration: 0.1, ease: "none" }, L0 + slide * 0.85)
      .to(el("locked"), { scale: pol.s, duration: 0.55, ease: "elastic.out(1, 0.5)" }, L0 + slide * 0.85);
    tl.addLabel("lockedIn", L0 + D.lockedIn);

    // WIN: crown, confetti, Snappy cheers, the phone settles, the CTA
    const W0 = L0 + D.lockedIn;
    const gk = (H - room) / H;
    tl.to(el("crown"), { opacity: 1, duration: 0.1, ease: "none" }, W0)
      .to(el("crown"), { scale: pol.s, duration: 0.6, ease: "elastic.out(1, 0.45)" }, W0)
      .to(el("crown"), { rotation: pol.rot - 22, duration: 0.5, ease: "power2.out" }, W0)
      .call(() => o.onConfetti(dir > 0), [], W0 + 0.05)
      .set(el("cheer"), { display: "block" }, W0) // mounted only now: its sparkles are SVG loops (not compositable)
      .to(el("cheer"), { opacity: 1, duration: 0.15, ease: "none" }, W0)
      .to(el("snappyInner"), { scale: 1.25, duration: 0.16, ease: "power2.out" }, W0)
      .to(el("snappyInner"), { scale: 1.18, duration: 0.45, ease: "elastic.out(1, 0.4)" }, W0 + 0.16)
      .to(el("polaroidInner"), { scale: 1.05, duration: 0.15, ease: "power2.out", yoyo: true, repeat: 1 }, W0)
      .to(el("rigSlide"), { rotation: -1.5, duration: 0.6, ease: "power2.out" }, W0 + 0.3)
      .to(el("group"), { y: -room / 2, scale: gk, duration: 0.6, ease: "power2.inOut" }, W0 + 0.25)
      .to(el("cta"), { opacity: 1, y: 0, duration: 0.45, ease: "power2.out" }, W0 + 0.45)
      .set(el("cta"), { pointerEvents: "auto" }, W0 + 0.6)
      .set({}, {}, W0 + D.win); // pad to the end of the stage
    tl.addLabel("win", W0 + D.win);

    labels = STAGES.map((s) => (s === "prompt" || s === "morph" ? 0 : tl.labels[s]));
    return tl;
  }

  /** Plays the stage timeline to a stage's label: through every stage in between, faster if several. */
  function goTo(idx: number, instant = false) {
    if (idx === target && !instant) return;
    target = idx;
    if (idx >= STAGES.indexOf("viewfinder")) played = true;
    const to = labels[idx];
    driver?.kill();
    driver = null;
    if (instant) { stageTl.seek(to, true); return; }
    const from = stageTl.time();
    if (Math.abs(to - from) < 1e-4) return;
    dir = to > from ? 1 : -1;
    const bounds = [...new Set(labels)].filter((t) => (dir > 0 ? t > from && t < to : t < from && t > to)).sort((a, b) => (a - b) * dir);
    const pts = [from, ...bounds, to];
    const speed = Math.min(cfg.maxCatchUp, 1 + (pts.length - 2) * 0.5);
    const d = gsap.timeline();
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const throughSnap = dir > 0 && Math.max(a, b) > snapSpan[0] && Math.min(a, b) < snapSpan[1];
      d.add(stageTl.tweenFromTo(a, b, { duration: Math.abs(b - a) / (throughSnap ? 1 : speed), ease: "none", immediateRender: false }));
    }
    driver = d;
  }

  const stageAt = (p: number) => {
    let i = 0;
    STAGES.forEach((s, k) => { if (p >= cfg.stageStart[s] - 1e-4) i = k; });
    return i;
  };

  /* --------------------------------------- the scroll triggers --------------------------------------- */
  const morphLayers = [el("card"), el("phone"), el("promptOuter"), el("snappyOuter")];
  const willChange = (on: boolean) => { for (const m of morphLayers) m.style.willChange = on ? "transform, opacity" : ""; };

  let main: ScrollTrigger;
  ctx.add(() => {
    // the morph: the only scrubbed part. The card turns upright into the phone (a crossfade of two pre-rendered
    // layers, transforms only), the prompt shrinks into the screen, Snappy hops on (with a flip) as the lens.
    gsap.timeline({
      defaults: { ease: "power2.inOut" },
      scrollTrigger: { trigger: section, start: () => at(cfg.stageStart.morph), end: () => at(cfg.stageStart.viewfinder), scrub: cfg.morph.scrub, invalidateOnRefresh: true },
    })
      .to(el("card"), { rotation: 90, scaleX: PHONE.h / CARD.w, scaleY: PHONE.w / CARD.h, duration: 1 }, 0)
      .to(el("card"), { opacity: 0, duration: 0.3, ease: "none" }, 0.32)
      .to(el("phone"), { rotation: 0, scaleX: 1, scaleY: 1, duration: 1 }, 0)
      .to(el("phone"), { opacity: 1, duration: 0.3, ease: "none" }, 0.2)
      .to(el("promptOuter"), { y: -150, scale: 0.66, rotation: 0, duration: 0.75 }, 0.1)
      .to(el("snappyOuter"), { x: 0, rotation: -350, scale: 0.36, duration: 0.65 }, 0.3)
      .to(el("snappyOuter"), { y: -300, duration: 0.36, ease: "power2.out" }, 0.3)
      .to(el("snappyOuter"), { y: LENS_Y, duration: 0.29, ease: "power2.in" }, 0.66);

    ScrollTrigger.create({ trigger: section, start: "top 65%", onEnter: () => shout.restart() });

    // stage targets + settling on the stage boundaries (just inside each stage, so a snap lands *in* it).
    // ScrollTrigger's snap covers touch (native), keyboard and the scrollbar; wheel input settles earlier (below).
    main = ScrollTrigger.create({
      trigger: section,
      start: () => at(0),
      end: () => at(1),
      invalidateOnRefresh: true,
      snap: { snapTo: snapPoints, directional: true, inertia: false, duration: cfg.scrollSnap.duration, delay: cfg.scrollSnap.delay, ease: cfg.scrollSnap.ease },
      onUpdate: (self) => goTo(stageAt(self.progress)),
      onToggle: (self) => willChange(self.isActive),
      onLeaveBack: () => { if (played) { played = false; o.onNextItem(); } },
    });
  });

  // Wheel (smoothed by Lenis): ScrollTrigger would only snap once Lenis's sub-pixel tail has fully stopped (~0.8 s
  // at lerp 0.1), which reads as drift. Instead, `delay` after the last wheel event, pick the next boundary in the
  // scroll direction from where Lenis is already heading, and redirect the in-flight scroll there in one glide.
  let settleTimer = 0;
  const settleEase = gsap.parseEase(cfg.scrollSnap.ease);
  const settle = (d: number) => {
    const t = lenis.targetScroll, start = at(0), end = at(1);
    if (t <= start + 1 || t >= end - 1) return; // outside the pinned range (or on its edges)
    const pts = snapPoints.map(at);
    if (pts.some((p) => Math.abs(p - t) < 2)) return; // already heading to a boundary
    const next = d > 0 ? pts.find((p) => p > t) : [...pts].reverse().find((p) => p < t);
    if (next === undefined) return;
    const { min, max } = cfg.scrollSnap.duration;
    const duration = Math.min(max, Math.max(min, Math.abs(next - lenis.animatedScroll) / 1600));
    lenis.scrollTo(next, { duration, easing: settleEase });
  };
  const offWheel = lenis.on("virtual-scroll", ({ deltaY, event }) => {
    if (!(event instanceof WheelEvent) || !deltaY) return;
    window.clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => settle(Math.sign(deltaY)), cfg.scrollSnap.delay * 1000);
  });

  // build (and rebuild when the layout changes: phone ↔ desktop, or the CTA room on phones)
  const rebuild = () => {
    const layout = layoutName(), room = Math.round(ctaRoom());
    if (layout === built.layout && room === built.room) return;
    built = { layout, room };
    const keep = target;
    driver?.kill();
    if (stageTl) { stageTl.seek(0, true); stageTl.kill(); }
    ctx.add(() => { stageTl = buildStages(layout, room); });
    goTo(keep, true);
  };
  rebuild();
  goTo(stageAt(main!.progress), true);
  ScrollTrigger.addEventListener("refresh", rebuild);
  ScrollTrigger.refresh();

  return () => {
    ScrollTrigger.removeEventListener("refresh", rebuild);
    offWheel();
    window.clearTimeout(settleTimer);
    driver?.kill();
    willChange(false);
    ctx.revert(); // kills every tween/trigger and restores the server-rendered inline styles
    el("timer").textContent = fmtTime(0);
    gsap.ticker.remove(raf);
    gsap.ticker.lagSmoothing(500, 33);
    lenis.destroy();
  };
}
