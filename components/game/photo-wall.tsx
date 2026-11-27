"use client";

import { ChevronLeft, ChevronRight, StickyNote, Trophy } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { ITEM_WRAP, isLongItem } from "@/components/game/item-text";
import { WaitingDots } from "@/components/game/waiting-dots";
import { cn } from "@/lib/utils";

export type WallPhoto = {
  submissionId: string;
  playerId: string;
  nickname: string;
  photoUrl: string | null;
  photoKey: string | null;
};

/** Pastel sticky-note paper colors (high contrast with deep purple ink). */
const NOTE_STYLES = [
  { paper: "bg-[#FFF3B0]", tape: "bg-brand-coral/55 -rotate-2" },
  { paper: "bg-[#D8F8E1]", tape: "bg-brand-yellow/75 rotate-2" },
  { paper: "bg-[#D9EEFF]", tape: "bg-primary/40 -rotate-1" },
  { paper: "bg-[#FFE0EB]", tape: "bg-brand-yellow/75 rotate-1" },
  { paper: "bg-[#EDE2FF]", tape: "bg-brand-coral/50 -rotate-2" },
  { paper: "bg-[#FFE6CC]", tape: "bg-primary/40 rotate-2" },
] as const;

const TILTS = [
  "-rotate-[2deg]",
  "rotate-[1.75deg]",
  "-rotate-[1.25deg]",
  "rotate-[2deg]",
  "-rotate-[1.75deg]",
  "rotate-[1.25deg]",
] as const;

const PAGE_MS = 8_000;

/** Deterministic index from a submission id so a player's sticky note keeps its color and tilt across updates. */
function noteHash(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Responsive grid classes that keep every sticky note inside the viewport without scrolling or overlapping. */
function wallGrid(count: number, large: boolean): string {
  if (!large) {
    if (count <= 1) return "grid-cols-1 max-w-sm";
    if (count === 2) return "grid-cols-2 max-w-2xl";
    return "grid-cols-2 sm:grid-cols-3";
  }
  if (count <= 1) return "grid-cols-1 grid-rows-1 max-w-2xl";
  if (count === 2) return "grid-cols-2 grid-rows-1 max-w-5xl portrait:grid-cols-1 portrait:grid-rows-2";
  if (count === 3) return "grid-cols-3 grid-rows-1 portrait:grid-cols-1 portrait:grid-rows-3";
  if (count === 4) return "grid-cols-2 grid-rows-2 max-w-5xl";
  if (count <= 6) return "grid-cols-3 grid-rows-2 portrait:grid-cols-2 portrait:grid-rows-3";
  if (count <= 8) return "grid-cols-4 grid-rows-2 portrait:grid-cols-2 portrait:grid-rows-4";
  if (count === 9) return "grid-cols-3 grid-rows-3 max-w-6xl";
  return "grid-cols-4 grid-rows-3 portrait:grid-cols-3 portrait:grid-rows-4";
}

/**
 * Sticky-note photo wall for Bring Me presentation & TV screens.
 * Displays players' non-rejected photos pinned up like playful pastel sticky notes with their names,
 * either before the winner is announced (while judging) or afterwards (highlighting the winner).
 * Auto-paginates when >12 players submitted so every photo stays large and readable on a TV.
 */
export function PhotoWall({
  roundLabel,
  prompt,
  photos,
  winnerPlayerId = null,
  winnerName = null,
  phase,
  size = "large",
  onPhotoError,
  children,
}: {
  roundLabel: string;
  prompt?: string | null;
  photos: WallPhoto[];
  winnerPlayerId?: string | null;
  winnerName?: string | null;
  phase: "reviewing" | "winner_announced";
  size?: "normal" | "large";
  onPhotoError?: (row: WallPhoto) => void;
  children?: ReactNode;
}) {
  const large = size === "large";
  const pageSize = large ? 12 : 6;
  const pageCount = Math.max(1, Math.ceil(photos.length / pageSize));
  const [page, setPage] = useState(0);
  const [paused, setPaused] = useState(false);

  const safePage = page % pageCount;
  const slice = photos.slice(safePage * pageSize, (safePage + 1) * pageSize);

  // Rotate pages automatically on TV when there are more than 12 photos (respects reduced motion and hover).
  useEffect(() => {
    if (pageCount <= 1 || paused) return;
    const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return;
    const t = window.setInterval(() => setPage((p) => (p + 1) % pageCount), PAGE_MS);
    return () => window.clearInterval(t);
  }, [pageCount, paused]);

  const dense = slice.length >= 7;

  return (
    <div
      className={cn(
        "relative isolate flex min-h-0 w-full flex-col overflow-hidden bg-white/[0.07] text-white ring-1 ring-white/15",
        large ? "h-full rounded-4xl px-[3vw] py-[2.5dvh]" : "rounded-4xl px-4 py-5 sm:px-6",
      )}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      role="region"
      aria-label="Players' Bring Me photo wall"
    >
      {/* Subtle corkboard dot texture (pure CSS radial gradient, zero network assets). */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 opacity-20 [background-image:radial-gradient(hsl(var(--brand-yellow)/0.5)_1px,transparent_1px)] [background-size:24px_24px]"
      />

      <header className={cn("relative z-10 flex shrink-0 flex-wrap items-center justify-between gap-2 text-left", large ? "mb-[2dvh]" : "mb-4")}>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
          <span className={cn("shrink-0 rounded-full bg-white/15 font-bold uppercase tracking-widest text-white/90", large ? "px-4 py-1 text-[clamp(0.75rem,1.8dvh,1.1rem)]" : "px-3 py-0.5 text-xs")}>
            {roundLabel}
          </span>
          {prompt ? (
            <p className={cn("min-w-0 font-display font-bold text-brand-yellow", ITEM_WRAP, large
              ? (isLongItem(prompt) ? "text-[clamp(1rem,2.4dvh,1.5rem)] leading-tight" : "text-[clamp(1.25rem,3.4dvh,2.25rem)] leading-tight")
              : "text-lg sm:text-xl leading-tight")}>
              Bring me: {prompt}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {phase === "winner_announced" && winnerName ? (
            <span className={cn("inline-flex items-center gap-1.5 rounded-full bg-brand-yellow font-display font-bold text-brand-night shadow-pop", large ? "px-4 py-1 text-[clamp(0.85rem,2dvh,1.25rem)]" : "px-3 py-0.5 text-sm")}>
              <Trophy aria-hidden="true" className="size-4 shrink-0" />
              {winnerName} won!
            </span>
          ) : (
            <span className={cn("inline-flex items-center gap-1.5 rounded-full bg-white/15 font-semibold text-white/90", large ? "px-4 py-1 text-[clamp(0.8rem,1.9dvh,1.15rem)]" : "px-3 py-0.5 text-xs")}>
              <StickyNote aria-hidden="true" className="size-4 text-brand-yellow" />
              {photos.length} {photos.length === 1 ? "photo" : "photos"}
              {phase === "reviewing" ? " · Judging" : ""}
            </span>
          )}

          {pageCount > 1 ? (
            <div className="inline-flex items-center gap-1 rounded-full bg-black/30 px-2 py-1 text-xs font-semibold text-white/90">
              <button
                type="button"
                aria-label="Previous page of photos"
                onClick={() => setPage((p) => (p - 1 + pageCount) % pageCount)}
                className="grid size-6 place-items-center rounded-full hover:bg-white/15"
              >
                <ChevronLeft aria-hidden="true" className="size-4" />
              </button>
              <span className="px-1 tabular-nums">{safePage + 1} / {pageCount}</span>
              <button
                type="button"
                aria-label="Next page of photos"
                onClick={() => setPage((p) => (p + 1) % pageCount)}
                className="grid size-6 place-items-center rounded-full hover:bg-white/15"
              >
                <ChevronRight aria-hidden="true" className="size-4" />
              </button>
            </div>
          ) : null}
        </div>
      </header>

      {photos.length === 0 ? (
        <div className="relative z-10 grid flex-1 place-items-center p-6 text-center">
          <div className="grid justify-items-center gap-2">
            <StickyNote aria-hidden="true" className="size-12 text-brand-yellow/80" />
            <p className="font-display text-2xl font-bold text-white/90">No photos to display yet</p>
            <p className="text-sm text-white/70">Approved and pending player photos appear here like sticky notes.</p>
          </div>
        </div>
      ) : (
        <div
          key={safePage}
          className={cn(
            "relative z-10 mx-auto grid w-full min-h-0 flex-1 place-items-stretch",
            large ? "gap-[clamp(0.75rem,2dvh,1.75rem)] px-2 py-2" : "gap-4 py-2",
            wallGrid(slice.length, large),
          )}
        >
          {slice.map((item, i) => {
            const h = noteHash(item.submissionId);
            const style = NOTE_STYLES[h % NOTE_STYLES.length];
            const tilt = TILTS[(h + i) % TILTS.length];
            const isWinner = phase === "winner_announced" && Boolean(winnerPlayerId) && item.playerId === winnerPlayerId;

            return (
              <div
                key={item.submissionId}
                style={{ animationDelay: `${Math.min(i * 55, 440)}ms` }}
                className="min-h-0 min-w-0 animate-pop-in motion-reduce:animate-none"
              >
                <figure
                  className={cn(
                    "relative flex min-h-0 min-w-0 flex-col rounded-2xl text-brand-night shadow-card",
                    large ? "h-full" : "aspect-[4/4.6]",
                    dense ? "p-2 pb-2" : "p-2.5 pb-3",
                    style.paper,
                    tilt,
                    "motion-reduce:rotate-0",
                    isWinner && "z-10 ring-4 ring-brand-yellow shadow-pop",
                  )}
                >
                  {/* Translucent tape strip holding the sticky note up */}
                  <span
                    aria-hidden="true"
                    className={cn(
                      "pointer-events-none absolute left-1/2 -translate-x-1/2 rounded-sm shadow-sm",
                      dense ? "-top-1.5 h-3.5 w-11" : "-top-2 h-4 w-14",
                      style.tape,
                    )}
                  />

                  {isWinner ? (
                    <span className="absolute -right-2 -top-2.5 z-20 inline-flex items-center gap-1 rounded-full bg-brand-yellow px-2.5 py-0.5 font-display text-xs font-bold text-brand-night shadow-pop">
                      <Trophy aria-hidden="true" className="size-3.5" /> Winner
                    </span>
                  ) : null}

                  <div className="flex min-h-0 w-full flex-1 items-center justify-center overflow-hidden rounded-xl bg-brand-night/90">
                    {item.photoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={item.photoUrl}
                        alt={`Bring Me photo by ${item.nickname}`}
                        referrerPolicy="no-referrer"
                        onError={() => onPhotoError?.(item)}
                        className="block h-full w-full object-contain"
                      />
                    ) : (
                      <WaitingDots className="bg-white/75" />
                    )}
                  </div>

                  <figcaption
                    title={item.nickname}
                    className={cn(
                      "shrink-0 truncate px-1 pt-1.5 text-center font-display font-bold leading-tight text-brand-night",
                      large
                        ? (dense ? "text-[clamp(0.85rem,2dvh,1.2rem)]" : "text-[clamp(1rem,2.6dvh,1.6rem)]")
                        : "text-sm",
                    )}
                  >
                    {item.nickname}
                  </figcaption>
                </figure>
              </div>
            );
          })}
        </div>
      )}

      {children ? <div className="relative z-10 mt-3 flex shrink-0 flex-wrap justify-center gap-3">{children}</div> : null}
    </div>
  );
}
