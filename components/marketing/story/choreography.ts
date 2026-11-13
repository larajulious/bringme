import { POSES, REF_H, cycleLength, mix, runPose, withFace, type Face, type Kind, type Placement, type Pose, type PoseName } from "./rig";

/* ------------------------------------------------------------------------------------------------
 * The story, as four self-contained beats (tablet and desktop). Each belongs to one section and is drawn on that
 * section's own layer, so it scrolls with the page on the compositor and can never lag behind it. Scroll only
 * *triggers* a beat; the beat itself plays on the clock (seconds), so Snappy runs at the same natural speed however
 * fast the visitor scrolls. A beat plays 0 → `hold` when its section comes into view, waits there (breathing,
 * waving) while it stays in view, and plays `hold` → `end` (his exit) when it goes. He never crosses from one
 * section into another, and never passes over a heading. This file is only *where* Snappy is and what he's doing;
 * *how* his body runs, blinks or squashes lives in rig.ts.
 *
 *  hero      He peeks in from the right on the hero's bottom edge, crouches, loaded, and when the visitor
 *            starts scrolling, launches and sprints out the left.
 *  audience  He runs in from the left, brakes beside "Who is it for?", puts his stapler hand up ("me!") and
 *            waves, and runs back out the left.
 *  extra     Same for "Extra Fun", from the right: he waves hi.
 *  pricing   On the footer's edge at the end of the page: he runs in from the left, frames the shot, fires his
 *            flash (a held beat) and throws both arms up.
 *
 * Positions are viewport fractions (x of width, h = height of height); y is the section's ground line in px
 * (set by the engine). Phones don't get these beats (no lane on a phone stays clear of the content). Instead, once
 * the visitor reaches the end, Snappy sneaks up from behind the footer's torn edge: see `sneak`.
 * ---------------------------------------------------------------------------------------------- */

/** A section's heading + intro text: left and right edges (fractions of width), and the room above its ground line
 * (px) for his head and raised hand. */
export type Spot = { l: number; r: number; head: number };

export type Layout = {
  vw: number; vh: number; mobile: boolean;
  /** Where Snappy greets "Who is it for?" and "Extra Fun" from (measured from their heading + intro). */
  spots: Record<"audience" | "extra", Spot>;
};

type Ease = "linear" | "in" | "out" | "inout";
type Range = [number, number];
type Seg = {
  t: Range; x: Range; g: Range; h: Range; z: Range; f: Range; ease?: Ease;
  /** Running: body lean from → to. Otherwise a pose blend. */
  run?: { lean: Range; phase0?: number };
  pose?: [PoseName, PoseName];
  /** Blend in from the previous segment's last pose over this fraction of the segment. */
  blend?: number;
  /** Blend out into a pose from this fraction on (braking, settling). */
  settle?: { pose: PoseName; from: number };
  /** An expression played over the segment (eased in and out), e.g. a glance or the flash. */
  face?: Face;
  /** Waves the raised (stapler) hand on the clock, easing in over the segment ("in", then held) or out ("out"). */
  wave?: "in" | "out";
};
export type Track = { kind: Kind; segs: Seg[]; phase0: number[]; cycle: number };
export type BeatName = "hero" | "audience" | "extra" | "pricing";
export type Beat = { track: Track; /** where it waits while its section is in view (s) */ hold: number; /** fully exited (s) */ end: number };

const ease = {
  linear: { f: (p: number) => p, d: () => 1 },
  in: { f: (p: number) => p * p, d: (p: number) => 2 * p },
  out: { f: (p: number) => 1 - (1 - p) * (1 - p), d: (p: number) => 2 * (1 - p) },
  inout: { f: (p: number) => p * p * (3 - 2 * p), d: (p: number) => 6 * p * (1 - p) },
};
const smooth = (p: number) => p * p * (3 - 2 * p);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const lerp = (r: Range, e: number) => r[0] + (r[1] - r[0]) * e;
const hold = (v: number): Range => [v, v];

/* ------------------------------------------- the beats ------------------------------------------- */

/** Half his width (fraction of vw) at height h (fraction of vh). */
const halfW = (l: Layout, h: number) => (66 * h * l.vh) / REF_H / l.vw;
/** Just past the screen edge on a side (−1 left, 1 right). */
const offEdge = (l: Layout, h: number, side: number) => (side > 0 ? 1 + halfW(l, h) + 0.03 : -halfW(l, h) - 0.03);
const at = (x: number, h: number, f: number) => ({ x: hold(x), g: hold(0), h: hold(h), z: hold(1), f: hold(f) });
const glance: Face = { look: 0, lookY: 0.15, pupil: 1.12, smile: 1, open: 0.45 }; // a happy glance at us

/**
 * A greeting beside a section's heading + intro (side 1 = right of it, −1 = left; he faces the text), so he never
 * passes behind it: in from the screen edge on that side, the greeting, and back out the same way. On narrow
 * screens, or with little room above the line for his head and raised hand, he's drawn smaller.
 */
function greet(l: Layout, spot: Spot, side: 1 | -1): Beat {
  const room = Math.max(0, side > 0 ? 1 - 0.02 - (spot.r + 0.03) : spot.l - 0.03 - 0.02) / 2; // half-width, fraction of vw
  const fitHead = (spot.head / 165) * REF_H / l.vh; // raised hand ~165 figure units above his feet
  const h = Math.min(0.24, fitHead, Math.max(0.08, (room * l.vw * REF_H) / (66 * l.vh)));
  const half = halfW(l, h);
  const x = side > 0 ? Math.min(1 - half - 0.02, Math.max(0.62, spot.r + 0.03 + half)) : Math.max(half + 0.02, Math.min(0.38, spot.l - 0.03 - half));
  const f = -side;
  const off = offEdge(l, h, side);
  const mid = x - 0.07 * f; // braking starts here
  const segs: Seg[] = [
    { t: [0, 0.42], run: { lean: [16, 14] }, ...at(0, h, f), x: [off, mid] },
    { t: [0.42, 0.62], run: { lean: [12, -4] }, settle: { pose: "skid", from: 0.3 }, ...at(0, h, f), x: [mid, x], ease: "out" },
    { t: [0.62, 0.82], pose: ["skid", "hi"], ...at(x, h, f), wave: "in" },
    { t: [0.82, 0.98], pose: ["hi", "stand"], ...at(x, h, f), f: [f, -f], wave: "out" },
    { t: [0.98, 1.45], run: { lean: [18, 16] }, blend: 0.3, ...at(0, h, -f), x: [x, off], ease: "in", face: glance },
  ];
  return { track: buildTrack(segs, l), hold: 0.82, end: 1.45 };
}

export function buildBeats(l: Layout): Record<BeatName, Beat> {
  const heroH = 0.44;
  const heroOff = offEdge(l, heroH * 0.8, -1);
  const hero: Seg[] = [
    // peeks in from the right, eyes the route and crouches, loaded
    { t: [0, 0.7], pose: ["ready", "set"], ...at(0, heroH, -1), x: [1.04, 0.965], ease: "inout" },
    // ...and launches, sprinting out the left
    { t: [0.7, 1.9], run: { lean: [24, 16], phase0: 0.8 }, blend: 0.22, ...at(0, 0, -1), x: [0.965, heroOff], h: [heroH, heroH * 0.8], ease: "in" },
  ];
  const aH = 0.31, aEnd = 0.115;
  const finOff = offEdge(l, aH, -1);
  const fin: Seg[] = [
    { t: [0, 0.5], run: { lean: [16, 14] }, ...at(0, aH, 1), x: [finOff, aEnd - 0.07] },
    { t: [0.5, 0.7], run: { lean: [12, -4] }, settle: { pose: "stand", from: 0.3 }, ...at(0, aH, 1), x: [aEnd - 0.07, aEnd], ease: "out" },
    { t: [0.7, 0.9], pose: ["stand", "snap"], ...at(aEnd, aH, 1), ease: "inout" },
    { t: [0.9, 1.15], pose: ["snap", "snap"], ...at(aEnd, aH, 1), face: { flash: 1, lid: 0.55, smile: 0.9 } }, // click
    { t: [1.15, 1.35], pose: ["snap", "snap"], ...at(aEnd, aH, 1) }, // the held beat
    { t: [1.35, 1.6], pose: ["snap", "victory"], ...at(aEnd, aH, 1), ease: "inout" },
    { t: [1.6, 1.8], pose: ["victory", "stand"], ...at(aEnd, aH, 1), f: [1, -1], ease: "inout" },
    { t: [1.8, 2.3], run: { lean: [18, 16] }, blend: 0.3, ...at(0, aH, -1), x: [aEnd, finOff], ease: "in" },
  ];
  return {
    hero: { track: buildTrack(hero, l), hold: 0.7, end: 1.9 },
    audience: greet(l, l.spots.audience, -1),
    extra: greet(l, l.spots.extra, 1),
    pricing: { track: buildTrack(fin, l), hold: 1.6, end: 2.3 },
  };
}

/* ------------------------------------------- evaluation ------------------------------------------- */

/** Distance run (in figure units, so strides match the body's size) from the start of a segment to progress p. */
function distance(s: Seg, l: Layout, p: number) {
  const e = ease[s.ease ?? "linear"];
  const dx = Math.abs(s.x[1] - s.x[0]) * l.vw;
  const n = 16; // Simpson's rule
  let sum = 0;
  for (let i = 0; i <= n; i++) {
    const q = (p * i) / n;
    const scale = (lerp(s.h, e.f(q)) * l.vh) / REF_H;
    const v = (dx * e.d(q)) / scale;
    sum += v * (i === 0 || i === n ? 1 : i % 2 ? 4 : 2);
  }
  return (sum * p) / (3 * n);
}

function buildTrack(segs: Seg[], l: Layout, kind: Kind = "a"): Track {
  const cycle = cycleLength(kind);
  const phase0: number[] = [];
  segs.forEach((g, i) => {
    const prev = segs[i - 1];
    phase0[i] = g.run?.phase0 ?? (prev?.run ? phase0[i - 1] + distance(prev, l, 1) / cycle : 0);
  });
  return { kind, segs, phase0, cycle };
}

/** Blinks (time-based, so they happen while the page is still too), with an occasional double. */
function blink(time: number) {
  const period = 3.7;
  const u = time % period;
  const pulse = (c: number) => Math.max(0, 1 - Math.abs(u - c) / 0.08);
  return Math.max(pulse(0.1), Math.floor(time / period) % 3 === 2 ? pulse(0.36) : 0);
}

function poseIn(tr: Track, i: number, tau: number, l: Layout, time: number, still: boolean): Pose {
  const s = tr.segs[i];
  const p = clamp01((tau - s.t[0]) / (s.t[1] - s.t[0]));
  let pose: Pose;
  if (s.run) {
    pose = runPose(tr.kind, tr.phase0[i] + distance(s, l, p) / tr.cycle, lerp(s.run.lean, p));
    // effects follow actual speed: they build while accelerating and die away while braking
    pose.speed = Math.min(1, ease[s.ease ?? "linear"].d(p));
  } else {
    const [from, to] = s.pose!;
    pose = mix(POSES[from], POSES[to], smooth(p));
    if (!still) {
      // breathing while standing: a slow, small squash
      const b = Math.sin(time * 1.9);
      pose = { ...pose, sq: pose.sq + 0.25 * b, shF: pose.shF + 1.5 * b, shB: pose.shB - 1.5 * b };
      if (s.wave) {
        const w = Math.sin(time * 10) * (s.wave === "in" ? smooth(clamp01(p / 0.3)) : 1 - smooth(p));
        pose = { ...pose, elF: pose.elF + 32 * w, shF: pose.shF + 8 * w, lean: pose.lean + 2 * w };
      }
    }
  }
  if (s.blend && i > 0 && p < s.blend) pose = mix(poseIn(tr, i - 1, s.t[0], l, time, still), pose, smooth(p / s.blend));
  if (s.settle && p > s.settle.from) pose = mix(pose, POSES[s.settle.pose], smooth((p - s.settle.from) / (1 - s.settle.from)));
  if (s.face) pose = withFace(pose, s.face, smooth(Math.min(1, p / 0.25, (1 - p) / 0.25)));
  return pose;
}

/** Where Snappy is at time τ along a track (x in viewport px, y from the ground line). `still` = reduced motion /
 * static frame: no breathing or blinks. */
export function place(tr: Track, tau: number, l: Layout, time: number, still = false): Placement {
  const segs = tr.segs;
  let i = segs.findIndex((s) => tau < s.t[1]);
  if (i < 0) i = segs.length - 1;
  const s = segs[i];
  const t = Math.min(Math.max(tau, s.t[0]), s.t[1]);
  const p = (t - s.t[0]) / (s.t[1] - s.t[0]);
  const e = ease[s.ease ?? "linear"].f(p);
  let pose = poseIn(tr, i, t, l, time, still);
  if (!still) pose = { ...pose, lid: Math.max(pose.lid, blink(time)) };
  if (l.mobile) pose = { ...pose, sq: pose.sq * 0.5, sec: pose.sec * 0.5, flash: pose.flash * 0.6 }; // calmer secondary motion
  return {
    kind: tr.kind,
    x: lerp(s.x, e) * l.vw,
    y: lerp(s.g, e) * l.vh,
    scale: (lerp(s.h, e) * l.vh) / REF_H,
    facing: lerp(s.f, smooth(p)),
    depth: lerp(s.z, e),
    pose,
  };
}

/* ---------------------------------------------- phones: the sneak ---------------------------------------------- */

/** Eased keyframes: value at time t through [time, value] pairs (smoothstep between, held outside). */
function keys(t: number, k: [number, number][]) {
  if (t <= k[0][0]) return k[0][1];
  for (let i = 1; i < k.length; i++) {
    if (t <= k[i][0]) return k[i - 1][1] + (k[i][1] - k[i - 1][1]) * smooth((t - k[i - 1][0]) / (k[i][0] - k[i - 1][0]));
  }
  return k[k.length - 1][1];
}
/** When the sneak is fully played (seconds); the reduced-motion still uses this frame. */
export const SNEAK_END = 2.6;

/**
 * Phones, end of the page: Snappy peeks over the footer's torn edge. `t` = seconds since the visitor reached the
 * end (played backwards, faster, when they scroll away), `edge` = the footer's top in viewport px; the footer
 * itself hides everything below the edge. Beats: the camera bump rises, then a sly eye that darts left and right;
 * he rises a little more and grins at us; the stapler pops up over the edge with a wink; then he idles, glancing
 * about.
 */
export function sneak(t: number, l: Layout, edge: number, time: number, still = false): Placement {
  const scale = Math.min(0.19 * l.vh, 170) / REF_H; // fits the room left for him above the footer
  const peek = keys(t, [[0, 0], [0.45, 0.3], [1.05, 0.3], [1.45, 0.64]]); // share of his height above the edge
  const idle = still || t < SNEAK_END ? 0 : time - SNEAK_END;
  const glance = idle ? 0.55 * Math.sin(idle * 0.8) + 0.25 * Math.sin(idle * 2.1) : 0;
  let pose: Pose = {
    ...POSES.stand,
    look: keys(t, [[0, -1], [0.55, -1], [0.7, 1], [0.95, 1], [1.05, -0.4], [1.4, 0]]) + glance,
    lookY: keys(t, [[0, -0.3], [1.3, -0.3], [1.5, 0.1]]),
    lid: Math.max(keys(t, [[0, 0.3], [1.2, 0.3], [1.45, 0]]), keys(t, [[1.95, 0], [2.05, 1], [2.3, 1], [2.45, 0]])), // sly squint, then a wink
    smile: keys(t, [[0, 0.35], [1.3, 0.35], [1.5, 1]]),
    open: keys(t, [[1.3, 0], [1.55, 0.55]]),
    smirk: keys(t, [[0, 0.7], [1.3, 0.7], [1.5, 0]]),
    // stapler arm pops up over the edge; the other arm stays down behind the footer
    shF: keys(t, [[1.5, 10], [1.85, 155]]), elF: keys(t, [[1.5, 30], [1.85, 18]]),
    sq: keys(t, [[1.45, 0], [1.6, -0.5], [1.8, 0]]), // a little stretch as he pops up
  };
  if (!still) {
    const b = Math.sin(time * 1.9);
    pose = { ...pose, sq: pose.sq + 0.25 * b, lid: Math.max(pose.lid, blink(time)) };
  }
  const height = REF_H * scale;
  return { kind: "a", x: 0.8 * l.vw, y: edge + (1 - peek) * height + 0.04 * height, scale, facing: -1, depth: 1, pose };
}
