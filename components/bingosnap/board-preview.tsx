import { Star } from "lucide-react";

import { cn } from "@/lib/utils";

export type PreviewCell = { challenge: string | null; isFree: boolean; /** Shown in an empty square. */ placeholder?: string };

/**
 * The host's board as a grid (row-major). Players get the same challenges in
 * their own order; this shows the host's layout. Purely presentational.
 */
export function BoardPreview({
  size,
  cells,
  highlight,
  className,
  label = "Board preview",
  large = false,
  compact = false,
}: {
  size: number;
  cells: PreviewCell[];
  /** Board position to emphasise (e.g. the field being edited). */
  highlight?: number | null;
  className?: string;
  label?: string;
  /** Bigger text (a player's own card on a phone). */
  large?: boolean;
  /** Tiny thumbnail: the free square shows only its star. */
  compact?: boolean;
}) {
  const dense = size >= 5;
  return (
    <div
      role="img"
      aria-label={`${label}: ${size} by ${size} board, ${cells.filter((c) => !c.isFree && c.challenge).length} of ${cells.filter((c) => !c.isFree).length} challenges filled${cells.some((c) => c.isFree) ? ", free centre" : ""}`}
      className={cn("grid gap-1.5 rounded-3xl bg-primary p-2.5 shadow-card sm:gap-2 sm:p-3", className)}
      style={{ gridTemplateColumns: `repeat(${size}, minmax(0, 1fr))` }}
    >
      {cells.map((c, i) => (
        <div
          key={i}
          className={cn(
            "flex aspect-square min-w-0 items-center justify-center overflow-hidden rounded-xl p-1 text-center leading-tight transition-colors",
            large ? (dense ? "text-[11px] sm:text-xs" : "text-sm") : dense ? "text-[9px] sm:text-[10px]" : "text-[11px] sm:text-xs",
            c.isFree
              ? "bg-brand-yellow text-brand-night"
              : c.challenge
                ? "bg-card font-semibold text-foreground"
                : "border-2 border-dashed border-white/30 text-white/50",
            highlight === i && "ring-4 ring-brand-coral",
          )}
        >
          {c.isFree ? (
            compact ? <Star aria-hidden="true" className="size-3.5 fill-current" /> : (
              <span className="flex flex-col items-center gap-0.5 font-display font-bold uppercase">
                <Star className="size-4 fill-current" />
                Free
              </span>
            )
          ) : (
            <span className="line-clamp-4 break-words hyphens-auto">{c.challenge || c.placeholder || i + 1}</span>
          )}
        </div>
      ))}
    </div>
  );
}
