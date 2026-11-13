/* ------------------------------------------------------------------------------------------------
 * Scene geometry and the resting pose, shared by the server render (inline styles, so the first paint is
 * already the resting frame) and the GSAP engine (which `gsap.set`s the same values before animating).
 * Units are design px inside the 440 × 600 stage, which is scaled to fit its area. Origin = stage centre.
 * ---------------------------------------------------------------------------------------------- */

export const W = 440;
export const H = 600;
export const CARD = { w: 352, h: 216 };
export const PHONE = { w: 250, h: 510 };
export const LENS_Y = -PHONE.h / 2 + 27;
export const ITEM_Y = 14;
/** Bracket offsets from the item: wide open, and closed on the item. */
export const BRACKETS = { open: { x: 98, y: 196 }, closed: { x: 80, y: 58 } };

export const LAYOUTS = {
  desktop: { phoneX: -80, polaroid: { x: 120, y: 30, rot: 7, s: 1 } },
  mobile: { phoneX: -60, polaroid: { x: 92, y: 64, rot: 7, s: 0.9 } },
};
export type LayoutName = keyof typeof LAYOUTS;

/** A point on the polaroid (its own coordinates) once it has landed. */
export function polaroidCorner(layout: LayoutName, dx: number, dy: number) {
  const p = LAYOUTS[layout].polaroid;
  const a = (p.rot * Math.PI) / 180;
  return { x: p.x + (dx * Math.cos(a) - dy * Math.sin(a)) * p.s, y: p.y + (dx * Math.sin(a) + dy * Math.cos(a)) * p.s };
}
export const LOCKED_AT = { dx: 58, dy: 124 };
export const CROWN_AT = { dx: -84, dy: -126 };

export const PARTS = [
  "group", "rigMorph", "rigSlide", "kick", "shout", "card", "phone", "camera", "scene", "item",
  "bTL", "bTR", "bBL", "bBR", "shutter", "d3", "d2", "d1", "flash", "promptOuter", "promptInner", "promptLight",
  "snappyOuter", "snappyInner", "cheer", "polaroid", "polaroidInner", "locked", "crown", "cta", "roomFlash", "timer",
] as const;
export type Part = (typeof PARTS)[number];
export type Styled = HTMLElement | SVGElement;

/** x, y (px), r (deg), s / sx / sy (scale), o (opacity). */
export type Pose = { x?: number; y?: number; r?: number; s?: number; sx?: number; sy?: number; o?: number };

/** Parts positioned by their centre (`left/top: 50%` + translate −50 %). The rest are `inset-0` wrappers or blocks. */
export const CENTERED = new Set<Part>([
  "card", "phone", "scene", "item", "bTL", "bTR", "bBL", "bBR", "shutter", "d3", "d2", "d1",
  "promptOuter", "snappyOuter", "polaroid", "locked", "crown",
]);

/** The card's resting tilt (deg). */
export const REST_TILT = -3;

const lockedRest = polaroidCorner("desktop", LOCKED_AT.dx, LOCKED_AT.dy);
const crownRest = polaroidCorner("desktop", CROWN_AT.dx, CROWN_AT.dy);
const { open } = BRACKETS;

/** The resting frame: the "Bring me…" card with Snappy beside it. */
export const REST: Partial<Record<Part, Pose>> = {
  // the card rests tilted; the tilt lives on the morphing layers themselves (an animated non-composited ancestor
  // would make them repaint every frame)
  card: { r: REST_TILT, o: 1 },
  shout: { r: -6 },
  // the phone waits turned sideways and squashed to the card's footprint; the morph turns it upright
  phone: { r: REST_TILT - 90, sx: CARD.h / PHONE.w, sy: CARD.w / PHONE.h, o: 0 },
  camera: { o: 0 },
  scene: { x: 70 },
  item: { x: 190, y: ITEM_Y, r: 22 },
  bTL: { x: -open.x, y: ITEM_Y - open.y },
  bTR: { x: open.x, y: ITEM_Y - open.y },
  bBL: { x: -open.x, y: ITEM_Y + open.y },
  bBR: { x: open.x, y: ITEM_Y + open.y },
  shutter: { y: 196 },
  d3: { y: ITEM_Y, s: 1.9, o: 0 },
  d2: { y: ITEM_Y, s: 1.9, o: 0 },
  d1: { y: ITEM_Y, s: 1.9, o: 0 },
  flash: { o: 0 },
  promptOuter: { y: -4, r: REST_TILT },
  promptLight: { o: 0 },
  snappyOuter: { x: 150, y: 98, r: 7 },
  cheer: { o: 0 },
  polaroid: { y: ITEM_Y, s: 0.74, o: 0 },
  locked: { x: lockedRest.x, y: lockedRest.y, r: LAYOUTS.desktop.polaroid.rot - 10, s: 0, o: 0 },
  crown: { x: crownRest.x, y: crownRest.y, r: LAYOUTS.desktop.polaroid.rot - 62, s: 0, o: 0 },
  cta: { y: 16, o: 0 },
  roomFlash: { o: 0 },
};

const n = (v: number) => Math.round(v * 1000) / 1000;

/** Inline style for the server render (the same transform GSAP will take over). */
export function restStyle(k: Part): React.CSSProperties | undefined {
  const p = REST[k];
  if (!p) return CENTERED.has(k) ? { transform: "translate(-50%,-50%)" } : undefined;
  const sx = p.sx ?? p.s ?? 1, sy = p.sy ?? p.s ?? 1;
  const moved = p.x || p.y || p.r || sx !== 1 || sy !== 1;
  const parts = [
    CENTERED.has(k) ? "translate(-50%,-50%)" : "",
    moved ? `translate(${n(p.x ?? 0)}px,${n(p.y ?? 0)}px) rotate(${n(p.r ?? 0)}deg) scale(${n(sx)},${n(sy)})` : "",
  ].filter(Boolean);
  return { transform: parts.join(" ") || undefined, opacity: p.o };
}

/** The same pose as GSAP vars. */
export function restVars(k: Part) {
  const p = REST[k] ?? {};
  return {
    xPercent: CENTERED.has(k) ? -50 : 0, yPercent: CENTERED.has(k) ? -50 : 0,
    x: p.x ?? 0, y: p.y ?? 0, rotation: p.r ?? 0, skewX: 0, skewY: 0, scaleX: p.sx ?? p.s ?? 1, scaleY: p.sy ?? p.s ?? 1,
    ...(p.o !== undefined ? { opacity: p.o } : null),
  };
}

export const fmtTime = (s: number) => `${s.toFixed(3).padStart(6, "0")}s`;
