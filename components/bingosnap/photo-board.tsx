"use client";

import { Camera, Check, ChevronRight, Lock, RotateCcw, Star, TriangleAlert } from "lucide-react";
import { memo } from "react";

import type { CellPhoto } from "@/components/bingosnap/use-cell-photos";
import type { BingoLayoutCell } from "@/lib/bingosnap/types";
import { cn } from "@/lib/utils";

/**
 * The player's own card. Each square is a button: empty → opens the camera, snapped → shows
 * the local photo (thumbnail) with a check and opens it for review / retake. The free centre
 * is always complete; squares of a completed winning pattern get a yellow ring. Thumbnails come
 * from this device only.
 */
export type BoardProps = {
  size: number;
  layout: BingoLayoutCell[];
  photos: Record<string, CellPhoto>;
  locked: Set<string>;
  readOnly: boolean;
  /** Positions in a completed winning line (or the whole card): highlighted. */
  winning?: ReadonlySet<number>;
  /** Squares of the last rejected claim that haven't been retaken since: worth another look. */
  flagged?: ReadonlySet<string>;
  /** Bumps when a winning pattern completes: the winning squares pop in sequence (once). */
  celebrate?: number;
  onOpen: (cell: BingoLayoutCell) => void;
  onBroken: (cellId: string) => void;
};

const statusLabel = (c: BingoLayoutCell, p: CellPhoto | undefined, isLocked: boolean, readOnly: boolean, flagged: boolean) =>
  p && !p.broken
    ? isLocked ? "Snapped and claimed." : `Snapped.${flagged ? " Part of your rejected claim: check it." : ""} ${readOnly ? "Open to view." : "Open to view or retake."}`
    : p?.broken ? "Photo missing on this phone." + (readOnly ? "" : " Open to take it again.")
      : readOnly ? "Not snapped." : "Not snapped yet. Open the camera.";

/** Re-rendered only when the card, the photos or the highlights change (not on every timer tick). */
export const PhotoBoard = memo(function PhotoBoard({
  size, layout, photos, locked, readOnly, winning, flagged, celebrate = 0, onOpen, onBroken,
}: BoardProps) {
  const dense = size >= 5;
  return (
    <ul
      aria-label={`Your card, ${size} by ${size}`}
      className="grid gap-1.5 rounded-3xl bg-primary p-2 shadow-card ring-4 ring-white/15 sm:gap-2 sm:p-3"
      style={{ gridTemplateColumns: `repeat(${size}, minmax(0, 1fr))` }}
    >
      {layout.map((c) => {
        const win = winning?.has(c.pos) ?? false;
        const winRing = win && "ring-4 ring-brand-yellow ring-offset-2 ring-offset-primary shadow-pop";
        const order = win && winning ? [...winning].sort((a, b) => a - b).indexOf(c.pos) : 0;
        const pop = win && celebrate > 0 ? "animate-pop-in motion-reduce:animate-none" : "";
        const popStyle = pop ? { animationDelay: `${order * 70}ms` } : undefined;
        if (c.isFree) {
          return (
            <li key={`${c.pos}:${win ? celebrate : 0}`} style={popStyle} className={cn("flex aspect-square flex-col items-center justify-center gap-0.5 rounded-xl bg-brand-yellow font-display font-bold uppercase text-brand-night", winRing, pop)}>
              <Star aria-hidden="true" className={cn("fill-current", dense ? "size-4" : "size-6")} />
              <span className={dense ? "text-[10px]" : "text-sm"}>Free</span>
              <span className="sr-only"> square, already complete{win ? ", part of your winning pattern" : ""}</span>
            </li>
          );
        }
        const p = photos[c.cellId];
        const ok = p && !p.broken;
        const isLocked = locked.has(c.cellId);
        const flag = !!ok && !isLocked && (flagged?.has(c.cellId) ?? false);
        const label = `${c.challenge ?? "Square"}. ${statusLabel(c, p, isLocked, readOnly, flag)}${win ? " Part of your winning pattern." : ""}`;
        return (
          <li key={`${c.pos}:${win ? celebrate : 0}`} style={popStyle} className={cn("min-w-0 rounded-xl", winRing, pop, flag && !win && "outline-dashed outline-2 outline-offset-2 outline-brand-coral")}>
            <button
              type="button"
              onClick={() => onOpen(c)}
              disabled={readOnly && !p}
              aria-label={label}
              className={cn(
                "group relative flex aspect-square w-full min-w-0 touch-manipulation items-center justify-center overflow-hidden rounded-xl p-1 text-center leading-tight transition-transform focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-yellow motion-safe:active:scale-95 disabled:cursor-default",
                dense ? "p-0.5 text-[10px] sm:p-1 sm:text-xs" : "text-sm",
                ok ? "bg-brand-night text-white" : "bg-card font-semibold text-foreground",
              )}
            >
              {ok ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    key={p.savedAt}
                    src={p.thumbUrl}
                    alt=""
                    decoding="async"
                    onError={() => onBroken(c.cellId)}
                    className="absolute inset-0 size-full animate-pop-in object-cover motion-reduce:animate-none"
                  />
                  <span aria-hidden="true" className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/55 to-transparent px-1 pb-0.5 pt-3">
                    <span className={cn("line-clamp-2 break-words hyphens-auto font-semibold", dense && "text-[9px] sm:text-[11px]")}>{c.challenge}</span>
                  </span>
                  <span key={`b${p.savedAt}`} aria-hidden="true" className={cn("absolute right-1 top-1 grid place-items-center rounded-full shadow animate-bounce-in motion-reduce:animate-none", flag ? "bg-brand-coral text-white" : isLocked ? "bg-white text-primary" : "bg-emerald-500 text-white", dense ? "size-4" : "size-6")}>
                    {isLocked ? <Lock className={dense ? "size-2.5" : "size-3.5"} /> : flag ? <RotateCcw className={dense ? "size-2.5" : "size-3.5"} strokeWidth={3} /> : <Check className={dense ? "size-3" : "size-4"} strokeWidth={3} />}
                  </span>
                </>
              ) : (
                <>
                  <span aria-hidden="true" className="line-clamp-4 break-words hyphens-auto">{c.challenge}</span>
                  {!readOnly ? (
                    <span aria-hidden="true" className={cn("absolute bottom-1 right-1 text-primary/45 group-hover:text-primary", dense && "hidden sm:block")}>
                      {p?.broken ? <TriangleAlert className="size-4 text-brand-coral" /> : <Camera className="size-4" />}
                    </span>
                  ) : null}
                </>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
});

/**
 * The same card as a list: every instruction at full size (no truncation), in card order, each
 * row a large touch target. For long instructions, small phones and screen-reader users.
 */
export const PhotoList = memo(function PhotoList({
  layout, photos, locked, readOnly, winning, flagged, onOpen, onBroken,
}: BoardProps) {
  return (
    <ol aria-label={`Your card as a list, ${layout.filter((c) => !c.isFree).length} squares`} className="grid gap-2">
      {layout.map((c) => {
        const where = `Row ${c.row + 1}, column ${c.col + 1}`;
        const win = winning?.has(c.pos) ?? false;
        if (c.isFree) {
          return (
            <li key={c.pos} className={cn("flex items-center gap-3 rounded-2xl bg-brand-yellow/90 px-3 py-2 text-brand-night", win && "ring-4 ring-brand-yellow")}>
              <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-white/60"><Star aria-hidden="true" className="size-6 fill-current" /></span>
              <span className="font-display font-bold">Free square <span className="sr-only">({where}), already complete</span></span>
            </li>
          );
        }
        const p = photos[c.cellId];
        const ok = !!p && !p.broken;
        const isLocked = locked.has(c.cellId);
        const flag = ok && !isLocked && (flagged?.has(c.cellId) ?? false);
        return (
          <li key={c.pos}>
            <button
              type="button"
              onClick={() => onOpen(c)}
              disabled={readOnly && !p}
              className={cn(
                "flex min-h-16 w-full touch-manipulation items-center gap-3 rounded-2xl bg-card px-3 py-2 text-left text-foreground transition-transform focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-yellow motion-safe:active:scale-[0.98] disabled:cursor-default",
                win && "ring-4 ring-brand-yellow", flag && !win && "ring-2 ring-brand-coral",
              )}
            >
              <span className="relative grid size-12 shrink-0 place-items-center overflow-hidden rounded-xl bg-secondary text-primary">
                {ok ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.thumbUrl} alt="" decoding="async" onError={() => onBroken(c.cellId)} className="size-full object-cover" />
                ) : p?.broken ? <TriangleAlert aria-hidden="true" className="size-5 text-brand-coral" /> : <Camera aria-hidden="true" className="size-5" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block break-words font-semibold leading-snug">{c.challenge}</span>
                <span className="sr-only">. {where}. </span>
                <span className={cn("text-xs font-semibold", ok ? (flag ? "text-brand-coral" : "text-brand-success") : "text-muted-foreground")}>
                  {ok ? (isLocked ? "Snapped · in your claim" : flag ? "Snapped · check this one" : "Snapped") : p?.broken ? "Photo missing" : readOnly ? "Not snapped" : "Tap to snap"}
                </span>
                {win ? <span className="sr-only">. Part of your winning pattern.</span> : null}
              </span>
              {ok ? (
                <span aria-hidden="true" className={cn("grid size-7 shrink-0 place-items-center rounded-full text-white", isLocked ? "bg-primary" : flag ? "bg-brand-coral" : "bg-brand-success")}>
                  {isLocked ? <Lock className="size-4" /> : flag ? <RotateCcw className="size-4" /> : <Check className="size-4" strokeWidth={3} />}
                </span>
              ) : !readOnly ? <ChevronRight aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" /> : null}
            </button>
          </li>
        );
      })}
    </ol>
  );
});
