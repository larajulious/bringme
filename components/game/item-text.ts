/**
 * Typography for a round's item ("Bring me…"), shared by every screen that shows it.
 *
 * Items are up to 200 characters (DB check), so one fixed size can't fit them all: a short item stays big, a long one
 * steps down a size tier. Each tier is a clamp() of the viewport (and, where the screen must fit its height, of dvh),
 * so it also adapts from a 320 px iPhone to a TV. The text always wraps and is never truncated:
 *  - `overflow-wrap: anywhere` breaks long words/URLs AND lowers the min-content width, so a long word can't
 *    widen a grid/flex track past the screen (with `break-words` alone it can, and the parent then clips it);
 *  - `text-wrap: balance` evens out the lines (ignored where unsupported).
 * Class strings are literal so Tailwind generates them.
 */
export type ItemTier = "s" | "m" | "l" | "xl";

/** Size tier by length in code points (an emoji counts about like a letter). */
export function itemTier(text: string | null | undefined): ItemTier {
  const n = text ? Array.from(text.trim()).length : 0;
  return n <= 16 ? "s" : n <= 40 ? "m" : n <= 90 ? "l" : "xl";
}

export const ITEM_WRAP = "min-w-0 max-w-full break-words [overflow-wrap:anywhere] hyphens-auto text-balance";

const SIZES = {
  /** Player's round screen (phone, must fit the visible height). */
  phone: {
    s: "text-[clamp(1.75rem,min(10vw,6dvh),2.5rem)] leading-[1.05]",
    m: "text-[clamp(1.5rem,min(7.5vw,4.6dvh),2.25rem)] leading-[1.1]",
    l: "text-[clamp(1.25rem,min(5.8vw,3.6dvh),1.75rem)] leading-tight",
    xl: "text-[clamp(1.0625rem,min(4.8vw,3dvh),1.375rem)] leading-snug",
  },
  /** Host console item card (beside the clock). Short items keep the previous sizes. */
  console: {
    s: "text-2xl leading-tight min-[400px]:text-3xl sm:text-4xl",
    m: "text-xl leading-tight min-[400px]:text-2xl sm:text-3xl",
    l: "text-lg leading-snug min-[400px]:text-xl sm:text-2xl",
    xl: "text-base leading-snug min-[400px]:text-lg sm:text-xl",
  },
  /** Projector stage inline in the console (short items keep text-5xl on wide screens). */
  stage: {
    s: "text-[clamp(2.25rem,9vw,3rem)] leading-tight",
    m: "text-[clamp(1.75rem,6.5vw,2.5rem)] leading-tight",
    l: "text-[clamp(1.375rem,4.8vw,2rem)] leading-snug",
    xl: "text-[clamp(1.125rem,3.8vw,1.625rem)] leading-snug",
  },
  /** Presenter / TV / fullscreen (fits the height; short items keep the previous size). */
  stageBig: {
    s: "text-[clamp(2.5rem,min(9dvh,6.5vw),6rem)] leading-tight",
    m: "text-[clamp(2rem,min(7dvh,5vw),4.5rem)] leading-tight",
    l: "text-[clamp(1.625rem,min(5.5dvh,3.8vw),3.5rem)] leading-snug",
    xl: "text-[clamp(1.375rem,min(4.4dvh,3vw),2.75rem)] leading-snug",
  },
} as const;

export type ItemView = keyof typeof SIZES;

export const itemSize = (view: ItemView, text: string | null | undefined) => SIZES[view][itemTier(text)];

/** Long items in a sentence ("Does it show …?", "for bringing …"): one step smaller. */
export const isLongItem = (text: string | null | undefined) => {
  const t = itemTier(text);
  return t === "l" || t === "xl";
};
