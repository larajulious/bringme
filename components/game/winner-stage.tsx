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
  size?: "compact" | "normal" | "large";
  /** Heading level for the big line (players' screens have no other h1). */
  heading?: "h1" | "h2";
  /** Hide the subline on short screens (only when it repeats the heading, e.g. on players' phones). */
  sublineShortHidden?: boolean;
  children?: ReactNode;
}) {
  const large = size === "large";
  const compact = size === "compact";
  const has = winnerName !== null;
  const splitLarge = large && has && Boolean(photoUrl);

  const info = (
    <>
      <p
        className={cn(
          "rounded-full bg-white/12 font-bold uppercase tracking-widest text-white/90",
          large ? "px-5 py-1 text-[clamp(0.875rem,2.2dvh,1.35rem)]" : compact ? "px-3 py-0.5 text-[11px]" : "px-4 py-1 text-sm",
        )}
      >
        {roundLabel}
      </p>
      <div className="animate-drop-in motion-reduce:animate-none">
        <TrophyIllustration
          dim={!has}
          className={
            splitLarge
              ? "w-[min(10rem,16dvh)]"
              : large
                ? "w-[min(13rem,20dvh)]"
                : compact
                  ? "w-14 sm:w-16 short:w-11 tiny:w-9"
                  : "w-28 short:w-20 tiny:w-14"
          }
        />
      </div>
      <Heading
        className={cn(
          "max-w-full break-words font-display font-bold leading-tight text-brand-yellow animate-bounce-in [animation-delay:0.3s] motion-reduce:animate-none",
          splitLarge
            ? "text-[clamp(2.25rem,7.5dvh,5rem)] leading-[1.08] [text-shadow:0_4px_0_hsl(var(--brand-yellow-deep))]"
            : large
              ? "text-[clamp(2.75rem,9.5dvh,5.75rem)] [text-shadow:0_4px_0_hsl(var(--brand-yellow-deep))]"
              : compact
                ? "text-2xl sm:text-3xl short:text-2xl tiny:text-xl [text-shadow:0_3px_0_hsl(var(--brand-yellow-deep))]"
                : "text-4xl sm:text-5xl short:text-3xl [text-shadow:0_4px_0_hsl(var(--brand-yellow-deep))]",
        )}
      >
        {headline ?? (has ? winnerName : "No winner this round")}
      </Heading>
      {has && timeMs !== null ? (
        <p
          className={cn(
            "animate-rise bg-white font-mono font-bold tabular-nums text-primary [animation-delay:0.45s]",
            splitLarge
              ? "rounded-2xl px-7 py-1.5 text-[clamp(1.5rem,5dvh,3rem)]"
              : large
                ? "rounded-2xl px-8 py-2 text-[clamp(2rem,6dvh,3.75rem)]"
                : compact
                  ? "rounded-full px-3.5 py-0.5 text-lg sm:text-xl short:text-base"
                  : "rounded-2xl px-5 py-1 text-3xl short:text-2xl",
          )}
          aria-label="Winning time"
        >
          {formatElapsed(timeMs)}
        </p>
      ) : null}
    </>
  );

  const photo = has && photoUrl ? (
    <figure
      className={cn(
        "inline-flex max-h-full max-w-full flex-col items-center overflow-hidden bg-white text-primary shadow-pop animate-rise [animation-delay:0.55s] motion-reduce:animate-none",
        splitLarge ? "rounded-3xl p-3 pb-4" : large ? "rounded-2xl p-3 pb-4" : compact ? "mt-0.5 rounded-2xl p-1.5 pb-2" : "rounded-2xl p-2 pb-3",
      )}
    >
      {/* Whole photo at its natural aspect ratio (never cropped or overlapping); the polaroid hugs it. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={photoUrl}
        alt={`Winning photo from ${winnerName}`}
        referrerPolicy="no-referrer"
        className={cn(
          "block h-auto min-h-0 w-auto max-w-full object-contain",
          splitLarge
            ? "max-h-[58dvh] rounded-2xl portrait:max-h-[34dvh]"
            : large
              ? "max-h-[38dvh] max-w-[min(36rem,100%)] rounded-xl"
              : compact
                ? "max-h-[min(14rem,27dvh)] max-w-[min(18rem,100%)] rounded-xl short:max-h-[min(11rem,23dvh)] tiny:max-h-[min(8.5rem,19dvh)]"
                : "max-h-[min(18rem,36dvh)] max-w-[min(20rem,100%)] rounded-xl",
        )}
      />
      <figcaption
        className={cn(
          "max-w-full shrink-0 truncate px-2 font-display font-semibold leading-tight",
          splitLarge ? "mt-2.5 text-[clamp(1rem,2.6dvh,1.625rem)]" : large ? "mt-2 text-2xl" : compact ? "mt-1.5 text-xs" : "mt-2 text-sm",
        )}
      >
        {winnerName}&apos;s photo
      </figcaption>
    </figure>
  ) : null;

  const details = (
    <>
      {prompt ? (
        <p
          className={cn(
            "px-1 text-white/90",
            ITEM_WRAP,
            compact
              ? isLongItem(prompt) ? "text-xs leading-snug" : "text-sm leading-snug short:text-xs"
              : splitLarge
                ? isLongItem(prompt) ? "text-[clamp(1rem,2.4dvh,1.4rem)] leading-snug" : "text-[clamp(1.125rem,3dvh,1.75rem)] leading-snug"
                : isLongItem(prompt)
                  ? (large ? "text-[clamp(1.125rem,2.8dvh,1.5rem)]" : "text-base short:text-sm")
                  : (large ? "text-[clamp(1.25rem,3.4dvh,1.875rem)]" : "text-lg short:text-base"),
          )}
        >
          {has ? "for bringing" : "Item"} <strong className="font-semibold text-white">{prompt}</strong>
        </p>
      ) : null}
      {subline ? (
        <div
          className={cn(
            "text-white/80",
            splitLarge ? "text-[clamp(1rem,2.4dvh,1.35rem)]" : large ? "text-[clamp(1.125rem,3dvh,1.5rem)]" : compact ? "text-xs" : "text-base",
            sublineShortHidden && "short:hidden",
          )}
        >
          {subline}
        </div>
      ) : null}
      {children ? <div className="mt-2 flex flex-wrap justify-center gap-3">{children}</div> : null}
    </>
  );

  return (
    <div
      className={cn(
        "relative isolate flex min-h-0 w-full flex-col overflow-hidden bg-white/[0.08] text-center text-white ring-1 ring-white/15",
        large
          ? "h-full justify-center rounded-4xl px-[4vw] py-[3.5dvh]"
          : compact
            ? "rounded-3xl px-4 py-4 short:px-3.5 short:py-3 tiny:py-2.5"
            : "rounded-4xl px-5 py-8 short:py-4 tiny:py-3",
      )}
      role="status"
      aria-live="polite"
    >
      {has ? (
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 -z-10 flex justify-center">
          <div
            className={cn(
              "shrink-0 animate-rays-spin rounded-full motion-reduce:animate-none",
              "[background:repeating-conic-gradient(from_0deg,hsl(var(--brand-yellow)/0.16)_0_9deg,transparent_9deg_24deg)] [mask-image:radial-gradient(closest-side,#000_35%,transparent)]",
              large ? "-mt-40 size-[60rem]" : compact ? "-mt-20 size-[24rem]" : "-mt-24 size-[34rem]",
            )}
          />
        </div>
      ) : null}
      {has && celebrate ? <Confetti /> : null}
      {splitLarge ? (
        <div className="relative z-10 mx-auto grid h-full min-h-0 w-full max-w-7xl grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] items-center gap-[4vw] portrait:grid-cols-1 portrait:grid-rows-[auto_minmax(0,1fr)] portrait:gap-[2.5dvh]">
          <div className="flex max-h-full min-h-0 flex-col items-center justify-center gap-[1.8dvh] overflow-y-auto overscroll-contain text-center [&>*]:shrink-0">
            {info}
            {details}
          </div>
          <div className="flex h-full min-h-0 w-full items-center justify-center overflow-hidden p-1">
            {photo}
          </div>
        </div>
      ) : (
        <div
          className={cn(
            "relative z-10 mx-auto flex min-h-0 w-full max-w-3xl flex-col items-center overflow-y-auto overscroll-contain [&>*]:shrink-0",
            compact ? "gap-2 short:gap-1.5 tiny:gap-1" : large ? "gap-[2dvh]" : "gap-3 short:gap-2 tiny:gap-1.5",
          )}
        >
          {info}
          {photo}
          {details}
        </div>
      )}
    </div>
  );
}
