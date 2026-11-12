import { POSES, REF_H, cycleLength, mix, runPose, withFace, type Face, type Kind, type Placement, type Pose, type PoseName } from "./rig";

/* ------------------------------------------------------------------------------------------------
 * The story, as one timeline for the whole page. Positions are viewport fractions (x of width, ground g
 * and height h of height): Snappy lives in screen space and the sections slide over him like windows.
 * This file is only *where* Snappy is and what he's doing; *how* his body runs, blinks or
 * squashes lives in rig.ts. Both are pure functions of scroll, so scrubbing backwards replays exactly.
 *
 * Story time τ is pinned to the layout, not to raw scroll: τ = k when section k's top edge (1 how it
 * works, 2 who it's for, 3 extra fun, 4 pricing) crosses his eye line. Section edges are where
 * the page has negative space (padding, centred headings), so every visible beat sits in the window
 * τ = k ± 0.3; between windows (behind cards) time compresses. See engine.ts `measure()`.
 *
 *  0.0–0.6  Anticipation  Snappy peeks in from the hero edge, eyes the route and crouches, loaded.
 *  0.6–2.3  The run       He launches, accelerates away into depth and sprints out of frame.
 *  2.7–3.1  The return    He's back, far off, running the other way; he flashes us a happy glance,
 *                         then narrows his eye and digs in.
 *  3.1–4.4  The moment    He brakes hard, turns and charges toward us, growing to full size, frames the
 *                         shot and fires his flash: a held beat.
 *  4.4–5.0  The finish    He throws both arms up and holds, breathing, above the footer.
 *                         (Phones: no clear space above the footer, so he celebrates and runs off.)
 * ---------------------------------------------------------------------------------------------- */

export type Layout = { vw: number; vh: number; mobile: boolean; /** ground line that clears the footer at the end */ gEnd: number };

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
};
export type Track = { kind: Kind; segs: Seg[]; phase0: number[]; cycle: number };

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

/** Splits one constant-speed run into consecutive parts (same path, unbroken stride) so each can carry a face. */
function parts(base: Seg, cuts: { to: number; face?: Face }[]): Seg[] {
  let t0 = base.t[0];
  const at = (t: number, r: Range) => lerp(r, (t - base.t[0]) / (base.t[1] - base.t[0]));
  return cuts.map(({ to, face }, i) => {
    const seg: Seg = {
      ...base, t: [t0, to], face,
      x: [at(t0, base.x), at(to, base.x)], g: [at(t0, base.g), at(to, base.g)], h: [at(t0, base.h), at(to, base.h)], z: [at(t0, base.z), at(to, base.z)],
      run: i > 0 ? { lean: base.run!.lean } : base.run,
    };
    t0 = to;
    return seg;
  });
}

/* ------------------------------------------- the script ------------------------------------------- */

function script(l: Layout): Record<Kind, Seg[]> {
  const m = l.mobile;
  const near = m ? 0.9 : l.gEnd; // the stage floor for the moment and the finish
  const far = near - (m ? 0.08 : 0.12); // a plane further back (higher on screen, smaller)
  const H = { hero: m ? 0.2 : 0.44, run: m ? 0.17 : 0.26, far: m ? 0.13 : 0.19, a: m ? 0.2 : 0.31 };
  const X = m
    ? { edge: [1.02, 0.9], launch: 0.6, out: -0.35, aIn: -0.25, aRun: 0.42, aBrake: 0.5, aEnd: 0.26 }
    : { edge: [1.04, 0.965], launch: 0.42, out: -0.2, aIn: -0.14, aRun: 0.5, aBrake: 0.565, aEnd: 0.115 };
  const at = (x: number, g: number, h: number, z: number, f: number) => ({ x: hold(x), g: hold(g), h: hold(h), z: hold(z), f: hold(f) });
  const A = at(X.aEnd, near, H.a, 1, 1);

  const raceA: Seg = { t: [2.7, 3.12], run: { lean: [15, 15] }, ...at(0, far, H.far, 0.15, 1), x: [X.aIn, X.aRun] };

  const a: Seg[] = [
    { t: [0, 0.6], pose: ["ready", "set"], ...at(0, 1, H.hero, 1, -1), x: [X.edge[0], X.edge[1]], ease: "inout" },
    { t: [0.6, 1.3], run: { lean: [24, 16], phase0: 0.8 }, blend: 0.22, x: [X.edge[1], X.launch], g: [1, 0.9], h: [H.hero, H.run], z: [1, 0.7], f: hold(-1), ease: "in" },
    { t: [1.3, 2.3], run: { lean: [16, 16] }, ...at(0, 0.9, H.run, 0.7, -1), x: [X.launch, X.out] },
    // offscreen: turn round and step back into the distance
    { t: [2.3, 2.7], pose: ["stand", "stand"], ...at(X.aIn - 0.12, far, H.far, 0.15, 1) },
    ...parts(raceA, [
      { to: 2.84 },
      { to: 2.98, face: { look: 0, lookY: 0.15, pupil: 1.12, smile: 1, open: 0.45 } }, // a happy glance at us
      { to: 3.12, face: { lid: 0.32, smirk: 0.8, smile: 0.5, open: 0, look: 1, pupil: 0.9 } }, // eyes front, digs in
    ]),
    { t: [3.12, 3.32], run: { lean: [12, -4] }, settle: { pose: "skid", from: 0.3 }, ...at(0, far, H.far, 0.15, 1), x: [X.aRun, X.aBrake], ease: "out" },
    { t: [3.32, 3.55], pose: ["skid", "stand"], ...at(X.aBrake, far, H.far, 0.15, 1), f: [1, -1], ease: "inout", face: { look: -1, pupil: 1.15 } },
    { t: [3.55, 4.05], run: { lean: [20, 8] }, blend: 0.25, settle: { pose: "stand", from: 0.78 }, x: [X.aBrake, X.aEnd], g: [far, near], h: [H.far, H.a], z: [0.15, 1], f: hold(-1), ease: "inout" },
    { t: [4.05, 4.15], pose: ["stand", "snap"], ...A, f: [-1, 1], ease: "inout" },
    { t: [4.15, 4.3], pose: ["snap", "snap"], ...A, face: { flash: 1, lid: 0.55, smile: 0.9 } }, // click
    { t: [4.3, 4.4], pose: ["snap", "snap"], ...A }, // the held beat
    { t: [4.4, 4.6], pose: ["snap", "victory"], ...A, ease: "inout" },
    ...(m
      ? ([
          { t: [4.6, 4.72], pose: ["victory", "victory"], ...A },
          { t: [4.72, 5], run: { lean: [22, 16], phase0: 0.8 }, blend: 0.3, ...A, x: [X.aEnd, 1.4], ease: "in" },
        ] satisfies Seg[])
      : ([{ t: [4.6, 5], pose: ["victory", "victory"], ...A }] satisfies Seg[])),
  ];

  return { a };
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

export function buildTracks(l: Layout): Track[] {
  const s = script(l);
  return (["a"] as const).map((kind) => {
    const segs = s[kind];
    const cycle = cycleLength(kind);
    const phase0: number[] = [];
    segs.forEach((g, i) => {
      const prev = segs[i - 1];
      phase0[i] = g.run?.phase0 ?? (prev?.run ? phase0[i - 1] + distance(prev, l, 1) / cycle : 0);
    });
    return { kind, segs, phase0, cycle };
  });
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
    }
  }
  if (s.blend && i > 0 && p < s.blend) pose = mix(poseIn(tr, i - 1, s.t[0], l, time, still), pose, smooth(p / s.blend));
  if (s.settle && p > s.settle.from) pose = mix(pose, POSES[s.settle.pose], smooth((p - s.settle.from) / (1 - s.settle.from)));
  if (s.face) pose = withFace(pose, s.face, smooth(Math.min(1, p / 0.25, (1 - p) / 0.25)));
  return pose;
}

/** Where Snappy is at story time τ (viewport px). `still` = reduced motion / static frame: no breathing or blinks. */
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

/** The frame each section shows when nothing moves (reduced motion): one telling moment per section, or none where a
 * frozen character would sit behind body text (how it works). */
export function stillTau(stage: string, l: Layout) {
  return ({ hero: 0.35, how: 2.5, audience: 2.98, extra: 4.35, pricing: l.mobile ? 4.55 : 5 } as Record<string, number>)[stage] ?? 0;
}
