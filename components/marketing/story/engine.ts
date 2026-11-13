import { SNEAK_END, buildBeats, place, sneak, type Beat, type BeatName, type Layout } from "./choreography";
import { apply, buildRig, extent, type Placement, type Rig } from "./rig";

/* ------------------------------------------------------------------------------------------------
 * Runs the homepage story (loaded lazily by StoryDriver; nothing here runs on the server).
 *
 * Tablet and desktop: four beats (choreography.ts), each drawn on its own layer inside its section, behind the
 * content. The layer is part of the page, so the compositor scrolls Snappy with his section: he can't lag, slip or
 * judder however fast the visitor scrolls. Scroll only triggers a beat (its section comes into view, or goes);
 * the beat itself plays on the clock.
 *
 * Phones: every section owns a `[data-story-stage]` with a viewport-sized "window" that a native scroll-driven
 * animation (globals.css) pins to the viewport; the pricing window draws the footer sneak (time-based too).
 *
 * Phones, at the very end: once Snappy has popped up and grinned, scrolling on (a further drag, wheel or key down
 * while already at the bottom) springs a real "Play now" button out beside him (`[data-sneak-cta]`, app/page.tsx).
 *
 * The loop only runs while a section with a stage is on screen. Reduced motion: each beat's resting frame, no loop.
 * ---------------------------------------------------------------------------------------------- */

/** Opacity of a character while it overlaps a heading (a safety net: no beat is meant to). */
const GHOST = 0.14;
const NS = "http://www.w3.org/2000/svg";
const BEATS: BeatName[] = ["hero", "audience", "extra", "pricing"];
/** Room his head and raised hand may take above a greeting section's top edge (over the previous section's padding). */
const HEADROOM = 20;
/** Phones: the sneak must have played this far (s: he's up and grinning) before scrolling on reveals "Play now". */
const CTA_AFTER = 1.5;
/** Reduced motion (no sneak clock): how long the visitor must already have been at the end (ms). */
const CTA_STILL_AFTER = 600;

type Stage = { name: string; el: HTMLElement; win: HTMLElement; svg: SVGSVGElement; rig: Rig; on: boolean };
type Layer = {
  name: BeatName; el: HTMLDivElement; rig: Rig; top: number;
  /** ground line (layer px) */ ground: number;
  /** clock (s), whether he's on his way out, and the ghost fade */ t: number; leaving: boolean; fade: number;
};

let uid = 0;
function makeSvg(parent: Element) {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "story-svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const id = `story-shadow-${uid++}`;
  svg.innerHTML = `<defs><radialGradient id="${id}"><stop offset="0" class="story-shadow-stop"/><stop offset="1" class="story-shadow-stop" stop-opacity="0"/></radialGradient></defs>`;
  parent.appendChild(svg);
  const rig = buildRig("a", svg);
  rig.shadow.setAttribute("fill", `url(#${id})`);
  return { svg, rig };
}

export function startStory(): () => void {
  const els = [...document.querySelectorAll<HTMLElement>("[data-story-stage]")];
  if (!els.length || !els[0].querySelector(".story-window")) return () => {};

  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const pinned = CSS.supports("animation-timeline: view()"); // else: pin the windows from JS

  // phones: the pinned windows (only pricing's draws anything: the sneak)
  const stages: Stage[] = els.map((el) => {
    const win = el.querySelector<HTMLElement>(".story-window")!;
    const { svg, rig } = makeSvg(win);
    return { name: el.dataset.storyStage ?? "", el, win, svg, rig, on: false };
  });
  // tablet and desktop: one layer per beat, beside its section's stage (same stacking, but not clipped)
  const layers: Layer[] = BEATS.flatMap((name) => {
    const stage = stages.find((s) => s.name === name);
    const parent = stage?.el.parentElement;
    if (!stage || !parent) return [];
    const el = document.createElement("div");
    el.className = "story-beat";
    el.dataset.tone = stage.el.dataset.tone;
    el.setAttribute("aria-hidden", "true");
    el.style.zIndex = getComputedStyle(stage.el).zIndex;
    stage.el.after(el);
    const { rig } = makeSvg(el);
    rig.root.style.display = "none";
    return [{ name, el, rig, top: 0, ground: 0, t: 0, leaving: false, fade: 1 }];
  });

  let layout: Layout = { vw: 1, vh: 1, mobile: false, spots: { audience: { l: 0.3, r: 0.7, head: 200 }, extra: { l: 0.3, r: 0.7, head: 200 } } };
  let beats = buildBeats(layout);
  /** Section headings + their intro line (document px): the cast ghosts if it ever overlaps them. */
  let avoid: { l: number; t: number; r: number; b: number }[] = [];
  /** Greeting triggers: heading top and intro bottom (document px). */
  const cue: Partial<Record<BeatName, { t: number; b: number }>> = {};
  /** The footer's top (document px), the last scroll position, and the phone sneak clock (seconds). */
  let footerTop = 0;
  let maxScroll = 1;
  let sneakT = 0;
  /** Phones: the "Play now" beside the sneak, whether the visitor has scrolled on past the end, and since when they're there. */
  const cta = document.querySelector<HTMLElement>("[data-sneak-cta]");
  let pushed = false;
  let endSince = 0;
  let touchY: number | null = null;

  /** Text's own extent (block boxes span the whole column even when the text is centred). */
  function textBox(e: Element) {
    const range = document.createRange();
    range.selectNodeContents(e);
    return range.getBoundingClientRect();
  }
  const intro = (h: Element) => (h.nextElementSibling?.tagName === "P" ? h.nextElementSibling : null);

  function measure() {
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const y = window.scrollY;
    for (const s of stages) {
      s.el.style.setProperty("--vh", `${vh}px`);
      s.svg.setAttribute("viewBox", `0 0 ${vw} ${vh}`);
    }
    const footerBox = document.querySelector("footer")?.getBoundingClientRect();
    footerTop = (footerBox?.top ?? 0) + y;
    maxScroll = Math.max(1, document.documentElement.scrollHeight - vh);
    const mobile = vw < 768;

    const spots = {} as Layout["spots"];
    for (const L of layers) {
      L.top = L.el.getBoundingClientRect().top + y;
      L.el.style.display = mobile ? "none" : "";
      if (L.name === "hero") L.ground = Math.min(L.el.offsetHeight, vh) - 2; // on the hero's bottom edge, as the page opens
      else if (L.name === "pricing") L.ground = footerTop - L.top - 18; // just above the footer's torn edge
      else {
        const h = document.querySelector(L.name === "audience" ? "#roles-heading" : "#extra-fun-heading");
        const p = h && intro(h);
        if (!h) continue;
        const hb = textBox(h), pb = p ? textBox(p) : hb;
        L.ground = pb.bottom + y - L.top; // feet on the intro's last line
        cue[L.name] = { t: hb.top + y, b: pb.bottom + y };
        spots[L.name] = { l: Math.min(hb.left, pb.left) / vw, r: Math.max(hb.right, pb.right) / vw, head: L.ground + HEADROOM };
      }
    }
    layout = { vw, vh, mobile, spots: { audience: spots.audience ?? layout.spots.audience, extra: spots.extra ?? layout.spots.extra } };
    if (cta) cta.style.right = `${Math.round(vw - extent(sneak(SNEAK_END, layout, 0, 0, true)).l + 16)}px`; // just left of Snappy (clear of his raised arm)
    beats = buildBeats(layout);
    // phones: Snappy only appears at the end, peeking over the footer (pricing window)
    for (const s of stages) s.rig.root.style.display = mobile && s.name === "pricing" ? "" : "none";
    avoid = [...document.querySelectorAll("main h2")].flatMap((h) => [h, intro(h)])
      .filter((e): e is Element => !!e)
      .map((e) => {
        const b = textBox(e);
        return { l: b.left - 12, r: b.right + 12, t: b.top + y - 10, b: b.bottom + y + 10 };
      });
  }

  /** Whether a beat's section is in view (its cue), given the scroll position. */
  function active(name: BeatName, y: number) {
    const vh = layout.vh;
    if (name === "hero") return y < 0.15 * vh; // the page is still at the top
    if (name === "pricing") return footerTop - y < vh - 40; // the footer's edge is on screen
    const c = cue[name];
    return !!c && c.t - y < 0.85 * vh && c.b - y > 0.12 * vh; // heading coming up, intro not yet gone
  }

  /** Advances a beat's clock: into its hold while active; out (faster if he hadn't arrived yet) once it isn't. */
  function step(L: Layer, beat: Beat, on: boolean, dt: number) {
    if (on && !L.leaving) L.t = Math.min(beat.hold, L.t + dt);
    else if (L.t > 0) {
      L.leaving = true;
      L.t += (L.t < beat.hold ? 2 : 1) * dt;
      if (L.t >= beat.end) { L.t = 0; L.leaving = false; }
    }
  }

  /** Draws a beat at its clock (layer px), ghosted if it overlaps a heading. */
  function drawBeat(L: Layer, beat: Beat, time: number, dt: number | null, frozen = false) {
    if (L.t <= 0) {
      if (L.rig.root.style.display !== "none") L.rig.root.style.display = "none";
      return;
    }
    if (L.rig.root.style.display === "none") L.rig.root.style.display = "";
    const t = !L.leaving && L.t >= beat.hold ? beat.hold - 1e-4 : L.t;
    const pl: Placement = place(beat.track, t, layout, time, frozen);
    pl.y += L.ground;
    const e = extent(pl);
    const hit = avoid.some((a) => e.r > a.l && e.l < a.r && e.b + L.top > a.t && e.t + L.top < a.b);
    const target = hit ? GHOST : 1;
    L.fade = dt === null ? target : L.fade + (target - L.fade) * (1 - Math.exp(-dt / 0.12));
    pl.fade = L.fade;
    apply(L.rig, pl);
  }

  /* ------------------------------------------- phones: "Play now" ------------------------------------------- */

  const atEnd = () => window.scrollY >= maxScroll - 40;
  /** He's up (or, without motion, they've been at the end a moment): only then does scrolling on count. */
  const ready = () => atEnd() && (still ? endSince > 0 && performance.now() - endSince > CTA_STILL_AFTER : sneakT >= CTA_AFTER);
  function updateCta() {
    if (!cta) return;
    if (!atEnd()) endSince = 0;
    else if (!endSince) endSince = performance.now();
    if (window.scrollY < maxScroll - 120 || !layout.mobile) pushed = false; // scrolled away: hide, and ask again next time
    const show = pushed && layout.mobile && window.scrollY >= maxScroll - 120 && (still || sneakT >= CTA_AFTER);
    if (show !== ("show" in cta.dataset)) {
      if (show) cta.dataset.show = "";
      else delete cta.dataset.show;
    }
  }
  /** The visitor tried to scroll further down. */
  function push() {
    updateCta();
    if (!layout.mobile || pushed || !ready()) return;
    pushed = true;
    updateCta();
  }
  const onWheel = (e: WheelEvent) => { if (e.deltaY > 0) push(); };
  const onTouchStart = (e: TouchEvent) => { touchY = e.touches[0]?.clientY ?? null; };
  const onTouchMove = (e: TouchEvent) => {
    const y = e.touches[0]?.clientY;
    if (touchY === null || y === undefined) return;
    if (!atEnd()) touchY = y; // only the drag made *after* reaching the end counts
    else if (touchY - y > 24) push(); // finger moving up = scrolling down
  };
  const onKey = (e: KeyboardEvent) => { if (["ArrowDown", "PageDown", "End", " "].includes(e.key)) push(); };
  const onScroll = () => updateCta();

  /* --------------------------------------- still (reduced motion) --------------------------------------- */

  function renderStill() {
    if (layout.mobile) {
      // the pricing window sits at the bottom of its section, i.e. on the footer's edge
      const pricing = stages.find((st) => st.name === "pricing");
      if (pricing) apply(pricing.rig, sneak(SNEAK_END, layout, layout.vh, 0, true));
      return;
    }
    for (const L of layers) {
      const beat = beats[L.name];
      L.t = beat.hold; // each beat's resting frame
      drawBeat(L, beat, 0, null, true);
    }
  }

  /* -------------------------------------------------- live -------------------------------------------------- */

  let raf = 0;
  let last = 0;

  function frame(now: number) {
    raf = 0;
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / 60;
    last = now;
    const y = window.scrollY;
    const time = now / 1000;
    if (layout.mobile) {
      // the sneak plays forward while the visitor is at the end, and rewinds (faster) when they scroll away
      sneakT = y >= maxScroll - 40 ? Math.min(sneakT + dt, 600) : Math.max(0, sneakT - dt * 3);
      const pricing = stages.find((s) => s.name === "pricing");
      if (pricing?.on) {
        if (!pinned) pricing.win.style.transform = `translateY(${y - (pricing.el.getBoundingClientRect().top + y)}px)`;
        apply(pricing.rig, sneak(sneakT, layout, footerTop - y, time));
      }
      updateCta();
    } else {
      for (const L of layers) {
        const beat = beats[L.name];
        step(L, beat, active(L.name, y), dt);
        drawBeat(L, beat, time, dt);
      }
    }
    if (stages.some((s) => s.on)) raf = requestAnimationFrame(frame);
    else last = 0;
  }
  const wake = () => { if (!raf && !still) raf = requestAnimationFrame(frame); };

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const s = stages.find((x) => x.el === e.target);
      if (s) s.on = e.isIntersecting;
    }
    wake();
  });

  let resizeQueued = 0;
  const onResize = () => {
    cancelAnimationFrame(resizeQueued);
    resizeQueued = requestAnimationFrame(() => {
      measure();
      if (still) renderStill();
      else wake();
    });
  };
  const ro = new ResizeObserver(onResize);

  measure();
  for (const s of stages) s.el.dataset.mode = still ? "still" : "live";
  if (still) renderStill();
  else for (const s of stages) io.observe(s.el);
  ro.observe(document.body);
  window.addEventListener("resize", onResize);
  if (cta) {
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, { passive: true });
  }
  requestAnimationFrame(() => { for (const s of stages) s.el.dataset.ready = ""; });

  return () => {
    cancelAnimationFrame(raf);
    cancelAnimationFrame(resizeQueued);
    io.disconnect();
    ro.disconnect();
    window.removeEventListener("resize", onResize);
    window.removeEventListener("wheel", onWheel);
    window.removeEventListener("touchstart", onTouchStart);
    window.removeEventListener("touchmove", onTouchMove);
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("scroll", onScroll);
    if (cta) { delete cta.dataset.show; cta.style.right = ""; }
    for (const L of layers) L.el.remove();
    for (const s of stages) {
      s.svg.remove();
      s.win.style.transform = "";
      delete s.el.dataset.mode;
      delete s.el.dataset.ready;
    }
  };
}
