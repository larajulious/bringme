import type { ReactNode } from "react";

import { Confetti } from "@/components/game/confetti";
import { ITEM_WRAP, isLongItem } from "@/components/game/item-text";
import { TrophyIllustration } from "@/components/game/trophy";
import { formatElapsed } from "@/lib/game/timing";
import { cn } from "@/lib/utils";

/**
 * The winner announcement: a slowly turning sunburst, a trophy that drops in,
 * confetti, the winner's name, time and a polaroid of the winning photo. One
 * component for the host screen, the projector and players' phones, so they
 * always look like the same moment. All motion is transform/opacity only.
 */
export function WinnerStage({
  roundLabel, prompt, winnerName, timeMs, photoUrl, headline, subline, celebrate = true, size = "normal", heading: Heading = "h2", sublineShortHidden = false, children,
}: {
  roundLabel: string;
  prompt?: string | null;
  winnerName: string | null;
  timeMs: number | null;
  photoUrl: string | null;
  /** Overrides the big line (e.g. "You won!"). */
  headline?: string;
  subline?: ReactNode;
  celebrate?: boolean;
  size?: "normal" | "large";
  /** Heading level for the big line (players' screens have no other h1). */
  heading?: "h1" | "h2";
  /** Hide the subline on short screens (only when it repeats the heading, e.g. on players' phones). */
  sublineShortHidden?: boolean;
  children?: ReactNode;
}) {
  const large = size === "large";
  const has = winnerName !== null;
  return (
    <div className="relative isolate flex min-h-0 w-full flex-col overflow-hidden rounded-4xl bg-white/[0.07] px-5 py-8 text-center short:py-4 tiny:py-3 text-white ring-1 ring-white/15" role="status" aria-live="polite">
      {has ? (
        <div
          aria-hidden="true"
          className={cn(
            "absolute left-1/2 -z-10 -translate-x-1/2 animate-rays-spin rounded-full motion-reduce:animate-none",
            "[background:repeating-conic-gradient(from_0deg,hsl(var(--brand-yellow)/0.16)_0_9deg,transparent_9deg_24deg)] [mask-image:radial-gradient(closest-side,#000_35%,transparent)]",
            large ? "-top-40 size-[60rem]" : "-top-24 size-[34rem]",
          )}
        />
      ) : null}
      {has && celebrate ? <Confetti /> : null}
      {/* The card clips (for the sunburst); its content scrolls as a last resort instead of being cut off. The photo
          still shrinks first (flex), so this only kicks in for an extreme item on a very short screen. */}
      <div className={cn("relative z-10 mx-auto flex min-h-0 w-full max-w-3xl flex-col items-center gap-3 overflow-y-auto overscroll-contain [&>*]:shrink-0", !large && "short:gap-2 tiny:gap-1.5")}>
        <p className={cn("rounded-full bg-white/12 px-4 py-1 font-bold uppercase tracking-widest text-white/90", large ? "text-2xl" : "text-sm")}>{roundLabel}</p>
        <div className="animate-drop-in motion-reduce:animate-none">
          <TrophyIllustration dim={!has} className={large ? "w-[min(14rem,20dvh)]" : "w-32 short:w-20 tiny:w-14"} />
        </div>
        <Heading
          className={cn(
            "max-w-full break-words font-display font-bold leading-tight text-brand-yellow [text-shadow:0_4px_0_hsl(var(--brand-yellow-deep))] animate-bounce-in [animation-delay:0.3s] motion-reduce:animate-none",
            large ? "text-[clamp(3rem,10dvh,6rem)]" : "text-4xl sm:text-5xl short:text-3xl",
          )}
        >
          {headline ?? (has ? winnerName : "No winner this round")}
        </Heading>
        {has && timeMs !== null ? (
          <p className={cn("animate-rise rounded-2xl bg-white font-mono font-bold tabular-nums text-primary [animation-delay:0.5s]", large ? "px-8 py-2 text-[clamp(2rem,6dvh,3.75rem)]" : "px-5 py-1 text-3xl short:text-2xl")} aria-label="Winning time">
            {formatElapsed(timeMs)}
          </p>
        ) : null}
        {has && photoUrl ? (
          <figure className={cn("flex min-h-0 animate-rise -rotate-2 flex-col rounded-xl bg-white p-2 pb-3 text-primary shadow-pop [animation-delay:0.7s] !shrink", large ? "max-w-xl p-3 pb-4" : "w-full max-w-xs")}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={photoUrl} alt={`Winning photo from ${winnerName}`} referrerPolicy="no-referrer" className={cn("w-full shrink rounded-md bg-black object-cover", large ? "max-h-[30dvh] min-h-0" : "max-h-56 min-h-20 tiny:min-h-16")} />
            <figcaption className={cn("mt-2 shrink-0 font-display font-semibold", large ? "text-2xl" : "text-sm")}>{winnerName}&apos;s photo</figcaption>
          </figure>
        ) : null}
        {prompt ? (
          <p className={cn("px-1 text-white/90", ITEM_WRAP, isLongItem(prompt)
            ? (large ? "text-[clamp(1.125rem,2.8dvh,1.5rem)]" : "text-base short:text-sm")
            : (large ? "text-[clamp(1.25rem,3.4dvh,1.875rem)]" : "text-lg short:text-base"))}>
            {has ? "for bringing" : "Item"} <strong>{prompt}</strong>
          </p>
        ) : null}
        {subline ? <div className={cn("text-white/85", large ? "text-[clamp(1.125rem,3dvh,1.5rem)]" : "text-base", sublineShortHidden && "short:hidden")}>{subline}</div> : null}
        {children ? <div className="mt-2 flex flex-wrap justify-center gap-3">{children}</div> : null}
      </div>
    </div>
  );
}
