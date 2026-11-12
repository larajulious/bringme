import { Camera, Check } from "lucide-react";

import { cn } from "@/lib/utils";

const MARKED = new Set([2, 4, 6]); // a diagonal Bingo (clear of the camera badge in the corner)

/**
 * BingoSnap's visual identity: a tilted 3×3 card with a snapped diagonal and a
 * camera badge. Decorative; marks pop in once (resting state = all marked,
 * which is what reduced-motion users see).
 */
export function BingoMark({ className, animate = true }: { className?: string; animate?: boolean }) {
  return (
    <div aria-hidden="true" className={cn("relative inline-block", className)}>
      <div className="grid -rotate-3 grid-cols-3 gap-1.5 rounded-3xl bg-primary p-2.5 shadow-pop-purple">
        {Array.from({ length: 9 }, (_, i) => (
          <span
            key={i}
            className={cn(
              "grid aspect-square place-items-center rounded-xl",
              MARKED.has(i) ? "bg-brand-yellow text-brand-night" : "bg-white/15",
              MARKED.has(i) && animate && "animate-pop-in motion-reduce:animate-none",
            )}
            style={MARKED.has(i) && animate ? { animationDelay: `${150 + i * 60}ms` } : undefined}
          >
            {MARKED.has(i) ? <Check className="size-[55%]" strokeWidth={3.5} /> : null}
          </span>
        ))}
      </div>
      <span className="absolute -bottom-2 -right-2 grid size-[38%] rotate-6 place-items-center rounded-2xl bg-brand-coral text-white shadow-pop-coral">
        <Camera className="size-[55%]" />
      </span>
    </div>
  );
}
