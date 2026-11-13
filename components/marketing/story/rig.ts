/* ------------------------------------------------------------------------------------------------
 * Snappy runner rig for the homepage scroll story, drawn to the approved running-Snappy reference:
 * the brand mascot's camera body (components/brand/mascot.tsx: same colours, lens, eyelid) seen in a
 * slight 3/4 view, with the darker side face showing on the leading side and the face set toward
 * travel; chunky deep-purple limbs with round mitts and feet; a big open grin; the red stapler held out
 * in the front hand. While running, speed lines trail the body and dust kicks up behind the back foot.
 *
 * Conventions (travel direction +x, y down, ground y = 0, units = mascot viewBox units):
 *  hip / shoulder / elbow  positive = forward     knee  positive = flex     ankle  positive = toes down
 *  lean positive = tips forward. Limbs, side face and face offset follow facing; the front face never flips.
 * Ground contact is solved with forward kinematics (lowest foot point touches the ground), and the run
 * cycle advances with distance travelled, so feet plant instead of sliding.
 * ---------------------------------------------------------------------------------------------- */

/** One runner today; the type stays so another family member can be added without reworking the rig. */
export type Kind = "a";

export type Pose = {
  lean: number;
  hipF: number; kneeF: number; ankleF: number; hipB: number; kneeB: number; ankleB: number;
  shF: number; elF: number; shB: number; elB: number;
  lift: number; // flight above the solved contact height
  sq: number; // squash (+1) ↔ stretch (−1)
  sec: number; // lag of the camera-top elements (secondary motion)
  speed: number; // 0 standing → 1 full sprint: drives speed lines, dust, the stapler's action marks
  phase: number; // run-cycle phase (for the dust and line timing)
  // face
  look: number; lookY: number; pupil: number; lid: number; smile: number; open: number; smirk: number; flash: number;
};

const FACE0 = { look: 0.3, lookY: 0, pupil: 1, lid: 0, smile: 0.7, open: 0.15, smirk: 0, flash: 0 };
const pose = (p: Partial<Pose>): Pose => ({
  lean: 0, hipF: 4, kneeF: 6, ankleF: 0, hipB: -4, kneeB: 6, ankleB: 0, shF: 20, elF: 40, shB: -8, elB: 20,
  lift: 0, sq: 0, sec: 0, speed: 0, phase: 0, ...FACE0, ...p,
});

export const POSES = {
  stand: pose({}),
  /** Standing start: weight forward, stapler tucked, eye locked on the route. */
  ready: pose({ lean: 8, hipF: 26, kneeF: 32, ankleF: -6, hipB: -24, kneeB: 24, ankleB: 16, shF: 30, elF: 70, shB: 40, elB: 80, sq: 0.3, look: 0.9, lid: 0.12, smile: 0.45, open: 0.1, smirk: 0.3 }),
  /** Loaded: body squashes down, back heel up, arms cocked, determined squint. */
  set: pose({ lean: 20, hipF: 46, kneeF: 72, ankleF: -10, hipB: -30, kneeB: 52, ankleB: 40, shF: 20, elF: 95, shB: 60, elB: 100, sq: 0.85, look: 1, lid: 0.26, pupil: 0.9, smile: 0.3, open: 0, smirk: 0.6 }),
  /** Braking: thrown back, front heel digs in, arms out, eye wide. */
  skid: pose({ lean: -16, hipF: 48, kneeF: 4, ankleF: -26, hipB: -4, kneeB: 62, ankleB: 18, shF: 100, elF: 20, shB: -60, elB: 30, sq: -0.3, look: 0.9, pupil: 1.25, smile: 0, open: 0.75 }),
  /** Framing the shot: arms up around the body, looking straight at us. */
  snap: pose({ lean: 2, hipF: 10, kneeF: 8, hipB: -10, kneeB: 8, shF: 150, elF: 60, shB: 150, elB: 60, sq: 0.2, look: 0, lid: 0.22, smile: 0.8, open: 0.2 }),
  /** Saying hi: stapler hand raised clear of the body (it waves on the clock, see choreography), big grin. */
  hi: pose({ lean: -5, shF: 150, elF: 25, sq: -0.25, look: 1, lookY: 0.3, pupil: 1.15, smile: 1, open: 0.75 }),
  /** Brought it: stapler held high. */
  victory: pose({ lean: -4, shF: 172, elF: 10, shB: 160, elB: 20, sq: -0.3, look: 0, pupil: 1.1, smile: 1, open: 0.8 }),
} satisfies Record<string, Pose>;
export type PoseName = keyof typeof POSES;
export type Face = Partial<Pick<Pose, "look" | "lookY" | "pupil" | "lid" | "smile" | "open" | "smirk" | "flash">>;

const KEYS = Object.keys(POSES.stand) as (keyof Pose)[];
export function mix(a: Pose, b: Pose, w: number): Pose {
  if (w <= 0) return a;
  if (w >= 1) return b;
  const o = {} as Pose;
  for (const k of KEYS) o[k] = a[k] + (b[k] - a[k]) * w;
  o.phase = w < 0.5 ? a.phase : b.phase; // a phase isn't meaningful halfway between
  return o;
}
export function withFace(p: Pose, f: Face, w: number): Pose {
  if (w <= 0) return p;
  const o = { ...p };
  for (const k in f) {
    const key = k as keyof Face;
    o[key] = p[key] + ((f[key] as number) - p[key]) * Math.min(1, w);
  }
  return o;
}

/* ---------------------------------------------- run cycle ---------------------------------------------- */

// One leg, phase 0 = this foot strikes: contact, loading, mid-stance, toe-off, heel kick, mid-swing, knee drive, reach.
const HIP = [34, 18, -8, -36, -30, 10, 52, 48];
const KNEE = [12, 38, 22, 30, 100, 128, 88, 28];
const ANKLE = [-8, 2, 10, 36, 38, 8, -6, -14];

function curve(keys: number[], phase: number) {
  const n = keys.length;
  const t = (((phase % 1) + 1) % 1) * n;
  const i = Math.floor(t);
  const u = t - i;
  const p0 = keys[(i - 1 + n) % n], p1 = keys[i], p2 = keys[(i + 1) % n], p3 = keys[(i + 2) % n];
  return 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u);
}

const RUN_FACE: Face = { look: 0.8, lookY: -0.1, pupil: 1, lid: 0, smile: 1, open: 0.6, smirk: 0 };

/** Full-speed run pose at `phase` (cycles). The front hand holds the stapler out ahead; the back arm pumps. */
export function runPose(_kind: Kind, phase: number, lean: number): Pose {
  const leg = (ph: number) => [curve(HIP, ph), curve(KNEE, ph), curve(ANKLE, ph)];
  const [hipF, kneeF, ankleF] = leg(phase);
  const [hipB, kneeB, ankleB] = leg(phase + 0.5);
  const c = Math.cos(2 * Math.PI * phase);
  const w = Math.cos(4 * Math.PI * (phase - 0.44));
  return {
    ...POSES.stand,
    ...RUN_FACE,
    lean: lean + 1.5 * Math.cos(4 * Math.PI * (phase - 0.1)),
    hipF, kneeF, ankleF, hipB, kneeB, ankleB,
    shF: 62 - 22 * c, elF: 40 - 12 * c, // reaching forward with the stapler, small pump
    shB: 4 + 62 * c, elB: 80 + 25 * c, // full swing
    lift: 5 * Math.max(0, (w - 0.7) / 0.3),
    // squash as the leg loads, stretch in flight; the camera top lags the bounce
    sq: 0.85 * Math.cos(4 * Math.PI * (phase - 0.125)),
    sec: 2.5 * Math.sin(4 * Math.PI * (phase - 0.22)),
    speed: 1,
    phase,
  };
}

/* -------------------------------------------- kinematics -------------------------------------------- */

const T = 22, S = 21, U = 17, F = 16; // thigh, shin, upper arm, forearm
const HIPX = 9, SHX = 55, SHY = -25; // hip half-spacing; shoulders at the body's lower side corners (clear of the face)
const FOOT: [number, number][] = [[-8, 9], [16, 9]]; // heel / toe on the sole, ankle space
/** Standing height (ground → top of the camera bump), used to size the character from one number. */
export const REF_H = 140;

const RAD = Math.PI / 180;
type V = [number, number];
const add = (a: V, len: number, deg: number): V => [a[0] + len * Math.sin(deg * RAD), a[1] + len * Math.cos(deg * RAD)];

function legPoints(hipX: number, h: number, k: number, a: number) {
  const hip: V = [hipX, 0];
  const knee = add(hip, T, h);
  const ankle = add(knee, S, h - k);
  const foot = -(h - k) + a; // foot angle, clockwise from +x
  let low = -Infinity;
  for (const [px, py] of FOOT) {
    const c = Math.cos(foot * RAD), s = Math.sin(foot * RAD);
    low = Math.max(low, ankle[1] + px * s + py * c);
  }
  return { hip, knee, ankle, foot, low };
}

/** Pelvis height above the ground (lowest foot point on the ground) plus flight. */
export function pelvisHeight(p: Pose) {
  return Math.max(legPoints(HIPX, p.hipF, p.kneeF, p.ankleF).low, legPoints(-HIPX, p.hipB, p.kneeB, p.ankleB).low) + p.lift;
}

/** Body travel per run cycle (figure units) that keeps the planted foot still. */
export function cycleLength(kind: Kind) {
  const x = (ph: number) => { const p = runPose(kind, ph, 0); return legPoints(0, p.hipF, p.kneeF, p.ankleF).ankle[0]; };
  return (x(0) - x(0.375)) / 0.375;
}

/* ---------------------------------------------- drawing ---------------------------------------------- */

const C = {
  body: "#ffc83d", band: "#f5b21f", side: "#e8a317", sideBand: "#d9930f", bump: "#e8a317", flash: "#e11d48",
  ring: "#5b21b6", ink: "#2a0f5c", tongue: "#fb7185", limb: "#3b1782", limbFar: "#2a0f5c",
  stapler: "#e11d48", staplerDark: "#9f1239", mark: "#ffc83d",
};
const NS = "http://www.w3.org/2000/svg";
function node<K extends keyof SVGElementTagNameMap>(tag: K, parent: Element, attrs: Record<string, string | number> = {}) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  parent.appendChild(e);
  return e;
}
/** Chunky rounded foot (ankle at 0,0, toe toward +x, sole at y 9). */
const FOOT_D = "M-7-4C0-8 13-7 18-1C20.5 2 19.5 9 13 9L-6 9C-10 9-11.5 4-10-0.5C-9.5-2-8.5-3.2-7-4Z";
/** The 3/4 side face, right side (mascot coords): drawn behind the front face, peeking out past it. */
const SIDE_R = "M96 20C112 20 124 26 125 40L126 82C126 93 119 99 108 99L96 96Z";
const SIDE_R_BAND = "M100 79L126 79L126 82C126 93 119 99 108 99L100 97Z";
const mirror = (d: string) => d.replace(/(-?\d+(?:\.\d+)?)(\s|,)(-?\d+(?:\.\d+)?)/g, (_, x: string, sep: string, y: string) => `${120 - Number(x)}${sep}${y}`);

export type Rig = {
  kind: Kind; root: SVGGElement; shadow: SVGEllipseElement; pelvis: SVGGElement; lean: SVGGElement; squash: SVGGElement; top: SVGGElement;
  sideR: SVGGElement; sideL: SVGGElement; face: SVGGElement;
  legF: SVGPathElement; legB: SVGPathElement; footF: SVGPathElement; footB: SVGPathElement;
  armF: SVGPathElement; armB: SVGPathElement; handF: SVGGElement; handB: SVGGElement; marks: SVGGElement;
  pupil: SVGGElement; lid: SVGGElement; lidEdge: SVGPathElement; lash: SVGPathElement; mouth: SVGPathElement; mouthClip: SVGPathElement; tongue: SVGEllipseElement;
  flash: SVGRectElement; glow: SVGCircleElement; lines: SVGPathElement[]; dust: SVGGElement[];
  last: Map<Element, Record<string, string>>; lastZ: string;
};

let uid = 0;
/** Builds the character into `parent`. Far limbs sit behind the body in a deeper purple. */
export function buildRig(kind: Kind, parent: Element): Rig {
  const id = `snappy-${kind}-${uid++}`;
  const root = node("g", parent, { class: `rig rig-${kind}` });
  const shadow = node("ellipse", root, { cx: 0, cy: 0, rx: 56, ry: 6.5, class: "rig-shadow" });
  // dust puffs (ground space, behind everything)
  const dust = [0, 1, 2].map(() => {
    const g = node("g", root, { class: "rig-dust", opacity: 0 });
    node("circle", g, { cx: 0, cy: -6, r: 7 });
    node("circle", g, { cx: 8, cy: -9, r: 9 });
    node("circle", g, { cx: 17, cy: -5, r: 6 });
    return g;
  });
  const pelvis = node("g", root);

  const limb = (color: string, width: number, parentEl: Element = pelvis) =>
    node("path", parentEl, { fill: "none", stroke: color, "stroke-width": width, "stroke-linecap": "round", "stroke-linejoin": "round" });
  // both legs come out from under the body (so a knee drive never covers the face); the front foot stays in front
  const legB = limb(C.limbFar, 15);
  const footB = node("path", pelvis, { d: FOOT_D, fill: C.limbFar });
  const legF = limb(C.limb, 15);
  const lean = node("g", pelvis);
  // speed lines trail the body (lean space, behind it)
  const lines = [0, 1, 2].map(() => node("path", lean, { class: "rig-speed", fill: "none", "stroke-width": 4, "stroke-linecap": "round", opacity: 0 }));
  const armB = limb(C.limbFar, 13, lean);
  const handB = node("g", lean);
  node("circle", handB, { r: 9.5, fill: C.limbFar });

  // the mascot, bottom-centre on the hips (mascot viewBox: body bottom at y 96)
  const squash = node("g", lean);
  const body = node("g", squash, { transform: "translate(-60 -92)" });
  const defs = node("defs", body);
  defs.innerHTML = `<radialGradient id="${id}-glow"><stop offset="0" stop-color="#fff" stop-opacity=".95"/><stop offset=".35" stop-color="#fff7d6" stop-opacity=".5"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient><clipPath id="${id}-lens"><circle cx="60" cy="47" r="20.5"/></clipPath><clipPath id="${id}-mouth"><path/></clipPath>`;
  const mouthClip = defs.querySelector(`#${id}-mouth path`) as SVGPathElement;
  const side = (d: string, band: string) => { const g = node("g", body); node("path", g, { d, fill: C.side }); node("path", g, { d: band, fill: C.sideBand }); return g; };
  const sideR = side(SIDE_R, SIDE_R_BAND);
  const sideL = side(mirror(SIDE_R), mirror(SIDE_R_BAND));
  const top = node("g", body);
  node("rect", top, { x: 36, y: 8, width: 40, height: 20, rx: 8, fill: C.bump });
  node("rect", top, { x: 86, y: 12, width: 18, height: 11, rx: 4, fill: C.flash });
  const flash = node("rect", top, { x: 86, y: 12, width: 18, height: 11, rx: 4, fill: "#fff", opacity: 0 });
  const glow = node("circle", top, { cx: 95, cy: 17.5, r: 26, fill: `url(#${id}-glow)`, opacity: 0 });
  node("rect", body, { x: 6, y: 20, width: 108, height: 76, rx: 22, fill: C.body });
  node("rect", body, { x: 6, y: 76, width: 108, height: 20, rx: 14, fill: C.band });
  const face = node("g", body);
  // face tuned to the running reference: lens a touch smaller and higher, leaving room for a big open grin
  node("ellipse", face, { cx: 24, cy: 74, rx: 8, ry: 5, fill: C.flash, opacity: 0.35 });
  node("ellipse", face, { cx: 96, cy: 74, rx: 8, ry: 5, fill: C.flash, opacity: 0.35 });
  node("circle", face, { cx: 60, cy: 47, r: 23.5, fill: "#fff", stroke: C.ring, "stroke-width": 6.5 });
  const pupil = node("g", face);
  node("circle", pupil, { cx: 60, cy: 48, r: 12.5, fill: C.ink });
  node("circle", pupil, { cx: 55.5, cy: 43.5, r: 4, fill: "#fff" });
  const lens = node("g", face, { "clip-path": `url(#${id}-lens)` });
  const lid = node("g", lens);
  node("path", lid, { d: "M14 7H106V71Q60 83 14 71Z", fill: C.body });
  const lidEdge = node("path", lid, { d: "M14 71Q60 83 106 71", fill: "none", stroke: C.ink, "stroke-width": 3.5, "stroke-linecap": "round" });
  const lash = node("path", lid, { d: "M45 56Q60 65 75 56", fill: "none", stroke: C.ink, "stroke-width": 4, "stroke-linecap": "round", opacity: 0 });
  const mouth = node("path", face, { fill: C.ink, stroke: C.ink, "stroke-width": 4, "stroke-linejoin": "round", "stroke-linecap": "round" });
  const mouthIn = node("g", face, { "clip-path": `url(#${id}-mouth)` });
  const tongue = node("ellipse", mouthIn, { cx: 63, cy: 93, rx: 10, ry: 6.5, fill: C.tongue });

  const armF = limb(C.limb, 13, lean);
  const handF = node("g", lean);
  // the red stapler, gripped by its back half (hand space: forward = +x)
  const stapler = node("g", handF, { transform: "translate(-4 0)" });
  node("rect", stapler, { x: -6, y: 1, width: 34, height: 8, rx: 3.5, fill: C.staplerDark });
  node("path", stapler, { d: "M-9-1C-9-7-4-10 3-10L27-8C32-7.5 33.5-3 30-0.5L-6 3Z", fill: C.stapler });
  node("path", stapler, { d: "M2-7L24-6", stroke: "#fff", "stroke-width": 2, "stroke-linecap": "round", opacity: 0.45 });
  const marks = node("g", handF, { opacity: 0 });
  for (const d of ["M34-14L40-21", "M38-4L47-5", "M26-19L28-28"]) node("path", marks, { d, stroke: C.mark, "stroke-width": 3.5, "stroke-linecap": "round" });
  node("circle", handF, { r: 9.5, fill: C.limb });
  const footF = node("path", pelvis, { d: FOOT_D, fill: C.limb });


  return {
    kind, root, shadow, pelvis, lean, squash, top, sideR, sideL, face, legF, legB, footF, footB, armF, armB, handF, handB, marks,
    pupil, lid, lidEdge, lash, mouth, mouthClip, tongue, flash, glow, lines, dust, last: new Map(), lastZ: "",
  };
}

/** Where and how big a character is on screen (viewport px), plus its pose. */
export type Placement = {
  x: number; y: number; scale: number; facing: number; depth: number; pose: Pose; kind: Kind;
  /** 1 = shown, lower = ghosted behind text */ fade?: number;
};

/** Screen-space box the character occupies (viewport px), for keeping it clear of headings. */
export function extent(pl: Placement) {
  const s = pl.scale;
  return { l: pl.x - 66 * s, r: pl.x + 66 * s, t: pl.y - REF_H * s, b: pl.y };
}

const n2 = (n: number) => Math.round(n * 100) / 100;
/** setAttribute, skipped when the value hasn't changed since the last frame. */
function set(r: Rig, e: Element, attr: string, v: string) {
  let store = r.last.get(e);
  if (!store) r.last.set(e, (store = {}));
  if (store[attr] === v) return;
  store[attr] = v;
  e.setAttribute(attr, v);
}

/** Smooth tapered-looking limb through the middle joint: a quadratic whose curve passes through `mid`. */
function noodle(a: V, mid: V, b: V, f: number) {
  const c: V = [2 * mid[0] - (a[0] + b[0]) / 2, 2 * mid[1] - (a[1] + b[1]) / 2];
  return `M${n2(a[0] * f)} ${n2(a[1])}Q${n2(c[0] * f)} ${n2(c[1])} ${n2(b[0] * f)} ${n2(b[1])}`;
}

function mouthPath(smile: number, open: number, smirk: number, dx: number) {
  const w = 9 + 6 * Math.max(0, smile) + 4 * open;
  const y = 80 - open;
  const ly = y + smirk * 1.2, ry = y - smirk * 3; // a smirk lifts the right corner
  const top = y + smile * 4 - open * 2; // a wide, flat-topped D when open
  const bot = top + 0.01 + open * 19 + Math.max(0, smile) * 2 * open;
  const x = 60 + dx;
  return `M${n2(x - w)} ${n2(ly)}Q${n2(x)} ${n2(top)} ${n2(x + w)} ${n2(ry)}Q${n2(x)} ${n2(bot)} ${n2(x - w)} ${n2(ly)}Z`;
}

/** Writes a placement into the rig's DOM (only attributes that changed). */
export function apply(r: Rig, pl: Placement) {
  const p = pl.pose;
  const f = pl.facing;
  const s = pl.scale;
  set(r, r.root, "transform", `translate(${n2(pl.x)} ${n2(pl.y)}) scale(${Math.round(s * 1e4) / 1e4})`);
  const depth = `${n2(pl.depth)}|${n2(pl.fade ?? 1)}`;
  if (r.lastZ !== depth) {
    r.lastZ = depth;
    r.root.style.setProperty("--z", String(n2(pl.depth)));
    r.root.style.setProperty("--fade", String(n2(pl.fade ?? 1)));
  }

  // body: lean toward travel, squash/stretch about the feet (volume kept), camera top lags
  const sq = 0.05 * p.sq;
  const sx = 1 + sq, sy = 1 / (1 + sq);
  set(r, r.pelvis, "transform", `translate(0 ${n2(-pelvisHeight(p))})`);
  set(r, r.lean, "transform", `rotate(${n2(p.lean * f)})`);
  set(r, r.squash, "transform", `scale(${n2(sx * 1000) / 1000} ${n2(sy * 1000) / 1000})`);
  set(r, r.top, "transform", `translate(0 ${n2(p.sec)})`);
  // 3/4 view: the side face shows on the leading side and the face slides toward travel
  set(r, r.sideR, "opacity", String(n2(Math.max(0, f))));
  set(r, r.sideL, "opacity", String(n2(Math.max(0, -f))));
  set(r, r.face, "transform", `translate(${n2(7 * f)} 0)`);

  // legs (pelvis space)
  const lf = legPoints(HIPX, p.hipF, p.kneeF, p.ankleF);
  const lb = legPoints(-HIPX, p.hipB, p.kneeB, p.ankleB);
  set(r, r.legF, "d", noodle(lf.hip, lf.knee, lf.ankle, f));
  set(r, r.legB, "d", noodle(lb.hip, lb.knee, lb.ankle, f));
  set(r, r.footF, "transform", `translate(${n2(lf.ankle[0] * f)} ${n2(lf.ankle[1])}) scale(${n2(f)} 1) rotate(${n2(lf.foot)})`);
  set(r, r.footB, "transform", `translate(${n2(lb.ankle[0] * f)} ${n2(lb.ankle[1])}) scale(${n2(f)} 1) rotate(${n2(lb.foot)})`);

  // arms (lean space): shoulders ride the squashed body sides; the stapler hand leads
  const shF: V = [SHX * sx, SHY * sy], shB: V = [-SHX * sx, SHY * sy];
  const elF = add(shF, U, p.shF), hF = add(elF, F, p.shF + p.elF);
  const elB = add(shB, U, p.shB), hB = add(elB, F, p.shB + p.elB);
  set(r, r.armF, "d", noodle(shF, elF, hF, f));
  set(r, r.armB, "d", noodle(shB, elB, hB, f));
  const tilt = -(p.shF + p.elF - 90) * 0.45; // stapler stays roughly level, tipping with the arm
  set(r, r.handF, "transform", `translate(${n2(hF[0] * f)} ${n2(hF[1])}) scale(${n2(f)} 1) rotate(${n2(tilt)})`);
  set(r, r.handB, "transform", `translate(${n2(hB[0] * f)} ${n2(hB[1])})`);
  const flick = 0.75 + 0.25 * Math.sin(p.phase * 4 * Math.PI);
  set(r, r.marks, "opacity", String(n2(p.speed * flick)));

  // speed lines (lean space, trailing side) and dust (ground, behind the back foot)
  r.lines.forEach((line, i) => {
    const y = -76 + i * 17;
    const x0 = -66 - i * 5;
    const len = (26 + i * 9) * (0.8 + 0.2 * Math.sin((p.phase + i * 0.3) * 4 * Math.PI)) * p.speed;
    set(r, line, "d", `M${n2(x0 * f)} ${y}Q${n2((x0 - len / 2) * f)} ${y - 2.5} ${n2((x0 - len) * f)} ${y}`);
    set(r, line, "opacity", String(n2(p.speed * (0.9 - i * 0.18))));
  });
  r.dust.forEach((puff, i) => {
    const u = (((p.phase * 2 + i / 3) % 1) + 1) % 1; // each puff is born at a push-off and drifts back
    const k = 0.55 + 0.9 * u;
    set(r, puff, "transform", `translate(${n2((-34 - 52 * u) * f)} ${n2(-2 * u)}) scale(${n2(k * f)} ${n2(k)})`);
    set(r, puff, "opacity", String(n2(p.speed * (1 - u) * 0.75)));
  });

  // face: pupil looks (in screen space, so it follows facing), lid, mouth + tongue, flash
  const lx = 6.5 * p.look * f, ly = 5 * p.lookY;
  set(r, r.pupil, "transform", `translate(${n2(60 + lx * 0.85)} ${n2(48 + ly * 0.85)}) scale(${n2(p.pupil)}) translate(-60 -48)`);
  const lid = Math.min(1, Math.max(0, p.lid));
  set(r, r.lid, "transform", `translate(0 ${n2(-54 + 44.5 * lid)})`); // lid edge from just above the lens (open) to its bottom (closed)
  const closed = Math.max(0, (lid - 0.8) / 0.2);
  set(r, r.lash, "opacity", String(n2(closed)));
  set(r, r.lidEdge, "opacity", String(n2(1 - closed)));
  const md = mouthPath(p.smile, p.open, p.smirk, 3 * f); // the grin sits a little further toward travel
  set(r, r.mouth, "d", md);
  set(r, r.mouthClip, "d", md);
  set(r, r.tongue, "transform", `translate(${n2(3 * f)} ${n2(-6 * p.open)})`);
  set(r, r.tongue, "opacity", String(n2(Math.min(1, p.open * 3))));
  set(r, r.flash, "opacity", String(n2(p.flash)));
  set(r, r.glow, "opacity", String(n2(p.flash * 0.9)));


  set(r, r.shadow, "transform", `scale(${n2(1 - Math.min(0.3, p.lift / 25))} 1)`);
}
