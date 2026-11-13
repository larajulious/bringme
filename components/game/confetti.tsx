const COLORS = ["bg-brand-yellow", "bg-brand-coral", "bg-white", "bg-primary", "bg-emerald-400"];

/**
 * CSS-only confetti (`once` = a single burst instead of a loop): ~44 absolutely positioned pieces falling with GPU
 * transforms (no canvas, no library, no JS timers). Deterministic layout, so it
 * renders identically on server and client. Hidden for reduced-motion users.
 */
export function Confetti({ pieces = 44, className = "", once = false }: { pieces?: number; className?: string; once?: boolean }) {
  return (
    <div aria-hidden="true" className={`pointer-events-none absolute inset-0 overflow-hidden motion-reduce:hidden ${className}`}>
      {Array.from({ length: pieces }, (_, i) => {
        const left = (i * 37 + 11) % 100;
        const size = 6 + ((i * 7) % 9);
        const style = {
          left: `${left}%`,
          width: size,
          height: i % 3 === 0 ? size : size * 1.8,
          "--dur": `${3.2 + ((i * 13) % 20) / 10}s`,
          "--delay": once ? `${((i * 29) % 30) / 100}s` : `${-((i * 29) % 40) / 10}s`,
          // "both": during its start delay a piece already holds the first keyframe (invisible, above the frame)
          // instead of sitting fully visible at the top edge and then blinking out as it starts.
          ...(once ? { animationIterationCount: 1, animationFillMode: "both" } : null),
          "--drift": `${((i * 17) % 120) - 60}px`,
          "--spin": `${360 + ((i * 53) % 540)}deg`,
        } as React.CSSProperties;
        return (
          <span
            key={i}
            style={style}
            className={`absolute top-0 animate-confetti-fall rounded-[2px] ${COLORS[i % COLORS.length]} ${i % 4 === 0 ? "rounded-full" : ""}`}
          />
        );
      })}
    </div>
  );
}
