import { buildTracks, place, stillTau, type Layout, type Track } from "./choreography";
import { apply, buildRig, extent, type Placement, type Rig } from "./rig";

/* ------------------------------------------------------------------------------------------------
 * Runs the homepage scroll story (loaded lazily by StoryDriver; nothing here runs on the server).
 *
 * Every section owns a `[data-story-stage]`: a clipped layer behind its content with a viewport-sized
 * "window" that a native scroll-driven animation (globals.css) keeps pinned to the viewport on the
 * compositor. Each window draws the same cast at the same screen position, so as a section edge scrolls
 * past it wipes one section's rendering into the next: one continuous scene, never a reset.
 *
 * Scroll maps to story time τ (one unit per section) and is smoothed slightly, like a scrubbed timeline.
 * Only stages on screen are drawn, and the loop stops when none are. Reduced motion: one still,
 * composed frame per section, no loop.
 * ---------------------------------------------------------------------------------------------- */

const ORDER = ["hero", "how", "audience", "extra", "pricing"] as const;
/** Half-width of each open window around a section edge: in viewport heights, and in story time. */
const WINDOW = 0.32;
const WINDOW_TAU = 0.3;
/** Opacity of a character while it passes behind a heading. */
const GHOST = 0.14;
const NS = "http://www.w3.org/2000/svg";

type Stage = { name: string; el: HTMLElement; win: HTMLElement; svg: SVGSVGElement; rigs: Rig[]; top: number; on: boolean };

export function startStory(): () => void {
  const els = [...document.querySelectorAll<HTMLElement>("[data-story-stage]")];
  const win0 = els[0]?.querySelector<HTMLElement>(".story-window");
  if (!els.length || !win0) return () => {};

  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const pinned = CSS.supports("animation-timeline: view()"); // else: pin the windows from JS
  let uid = 0;

  const stages: Stage[] = els.map((el) => {
    const win = el.querySelector<HTMLElement>(".story-window")!;
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "story-svg");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const id = `story-shadow-${uid++}`;
    svg.innerHTML = `<defs><radialGradient id="${id}"><stop offset="0" class="story-shadow-stop"/><stop offset="1" class="story-shadow-stop" stop-opacity="0"/></radialGradient></defs>`;
    win.appendChild(svg);
    const rigs = [buildRig("a", svg)];
    for (const r of rigs) r.shadow.setAttribute("fill", `url(#${id})`);
    return { name: el.dataset.storyStage ?? "", el, win, svg, rigs, top: 0, on: false };
  });

  let layout: Layout = { vw: 1, vh: 1, mobile: false, gEnd: 0.8 };
  let tracks: Track[] = [];
  let anchors: [number, number][] = [[0, 0], [1, 5]];
  /** Section headings + their intro line (document px): the cast ghosts while it passes behind them. */
  let avoid: { l: number; t: number; r: number; b: number }[] = [];
  const fade = [1];

  function measure() {
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const y = window.scrollY;
    for (const s of stages) {
      s.top = s.el.getBoundingClientRect().top + y;
      s.el.style.setProperty("--vh", `${vh}px`);
      s.svg.setAttribute("viewBox", `0 0 ${vw} ${vh}`);
    }
    const footer = document.querySelector("footer")?.getBoundingClientRect().height ?? 0;
    const mobile = vw < 768;
    layout = { vw, vh, mobile, gEnd: Math.min(0.97, Math.max(0.6, 1 - (footer + (mobile ? 10 : 18)) / vh)) };
    tracks = buildTracks(layout);
    avoid = [...document.querySelectorAll("main h2")].flatMap((h) => [h, h.nextElementSibling?.tagName === "P" ? h.nextElementSibling : null])
      .filter((e): e is Element => !!e)
      .map((e) => {
        // the text's own extent (block boxes span the whole column even when the text is centred)
        const range = document.createRange();
        range.selectNodeContents(e);
        const b = range.getBoundingClientRect();
        return { l: b.left - 12, r: b.right + 12, t: b.top + y - 10, b: b.bottom + y + 10 };
      });
    // Story time is pinned to the layout: τ = k when section k's top crosses the cast's eye line (60% down
    // the viewport), linear within ±WINDOW of each crossing (where the page is open), compressed between.
    const max = Math.max(1, document.documentElement.scrollHeight - vh);
    const eye = 0.6 * vh;
    const r = WINDOW * vh;
    const pts: [number, number][] = [[0, 0]];
    ORDER.slice(1).forEach((n, i) => {
      const k = i + 1;
      const cross = (stages.find((s) => s.name === n)?.top ?? (max * k) / 5) - eye;
      if (k > 1) pts.push([cross - r, k - WINDOW_TAU]);
      pts.push([cross, k], [cross + r, k + WINDOW_TAU]);
    });
    pts.push([max, 5]);
    for (let i = 1; i < pts.length; i++) pts[i][0] = Math.min(Math.max(pts[i][0], pts[i - 1][0] + 1), Math.max(max, pts[i - 1][0] + 1));
    anchors = pts;
  }

  /** Scroll position → story time (piecewise linear through `anchors`). */
  function tauAt(scroll: number) {
    if (scroll <= 0) return 0;
    for (let i = 1; i < anchors.length; i++) {
      const [s1, t1] = anchors[i];
      if (scroll <= s1) {
        const [s0, t0] = anchors[i - 1];
        return t0 + ((t1 - t0) * (scroll - s0)) / (s1 - s0);
      }
    }
    return 5;
  }

  /** How visible each character should be at this scroll position: ghosted while it overlaps a heading. */
  function clearOfText(places: Placement[], y: number, dt: number | null) {
    places.forEach((pl, i) => {
      const e = extent(pl);
      const hit = avoid.some((a) => e.r > a.l && e.l < a.r && e.b > a.t - y && e.t < a.b - y);
      const target = hit ? GHOST : 1;
      fade[i] = dt === null ? target : fade[i] + (target - fade[i]) * (1 - Math.exp(-dt / 0.12));
      pl.fade = fade[i];
    });
  }

  function draw(stage: Stage, places: Placement[]) {
    stage.rigs.forEach((r, i) => apply(r, places[i]));
  }

  /* --------------------------------------- still (reduced motion) --------------------------------------- */

  function renderStill() {
    for (const s of stages) {
      const tau = stillTau(s.name, layout);
      const places = tracks.map((t) => place(t, tau, layout, 0, true));
      // a still frame sits at the top of its section (bottom for pricing): test against that position
      const winTop = s.name === "pricing" ? s.top + s.el.offsetHeight - layout.vh : s.top;
      clearOfText(places, winTop, null);
      draw(s, places);
    }
  }

  /* -------------------------------------------------- live -------------------------------------------------- */

  let raf = 0;
  let last = 0;
  let cur = window.scrollY;

  function frame(now: number) {
    raf = 0;
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / 60;
    last = now;
    const y = window.scrollY;
    cur += (y - cur) * (1 - Math.exp(-dt / 0.09));
    if (Math.abs(y - cur) < 0.3) cur = y;
    const tau = tauAt(cur);
    const time = now / 1000;
    const places = tracks.map((t) => place(t, tau, layout, time));
    clearOfText(places, y, dt);
    let any = false;
    for (const s of stages) {
      if (!s.on) continue;
      any = true;
      if (!pinned) s.win.style.transform = `translateY(${y - s.top}px)`;
      draw(s, places);
    }
    if (any) raf = requestAnimationFrame(frame);
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
  else {
    const tau = tauAt(cur);
    const places = tracks.map((t) => place(t, tau, layout, performance.now() / 1000));
    clearOfText(places, window.scrollY, null);
    for (const s of stages) draw(s, places);
    for (const s of stages) io.observe(s.el);
  }
  ro.observe(document.body);
  window.addEventListener("resize", onResize);
  requestAnimationFrame(() => { for (const s of stages) s.el.dataset.ready = ""; });

  return () => {
    cancelAnimationFrame(raf);
    cancelAnimationFrame(resizeQueued);
    io.disconnect();
    ro.disconnect();
    window.removeEventListener("resize", onResize);
    for (const s of stages) {
      s.svg.remove();
      s.win.style.transform = "";
      delete s.el.dataset.mode;
      delete s.el.dataset.ready;
    }
  };
}
