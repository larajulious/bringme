import { cn } from "@/lib/utils";

/**
 * The 3-2-1-GO! display. Each second remounts (key) so its CSS animation plays
 * again: the number pops in over a soft disc while a ring expands outwards. At
 * zero a starburst and a full-area flash give an unmistakable "GO!".
 * Purely presentational: callers compute `left` from server timestamps.
 */
export function Countdown({ left, large = false, flash = "fixed", holdAtZero = false }: { left: number; large?: boolean; flash?: "fixed" | "absolute"; holdAtZero?: boolean }) {
  const go = left <= 0;
  // BringMe!: the host still has to press "Start round" before the item is revealed, so a red GO! would be misleading.
  // At zero we show a calm "Get set…" disc instead; the round itself starts (and the item appears) when the host starts it.
  if (go && holdAtZero) {
    return (
      <div className={cn("pointer-events-none relative grid place-items-center", large ? "size-[min(34rem,58dvh)]" : "size-64 short:size-52 tiny:size-40")}>
        <span aria-hidden="true" className="absolute size-full animate-tick-ring rounded-full border-4 border-white/40 motion-reduce:hidden" />
        <span aria-hidden="true" className={cn("absolute rounded-full bg-white/10 ring-4 ring-white/15", large ? "size-[min(30rem,51dvh)]" : "size-56 short:size-44 tiny:size-32")} />
        <p aria-live="polite" className={cn("relative px-6 text-center font-display font-bold leading-tight text-brand-yellow", large ? "text-[min(5rem,9dvh)]" : "text-4xl short:text-3xl tiny:text-2xl")}>Get set…</p>
      </div>
    );
  }
  return (
    // pointer-events-none: the GO! starburst (150% wide) overflows onto the host's "Start round" button below.
    <div className={cn("pointer-events-none relative grid place-items-center", large ? "size-[min(34rem,58dvh)]" : "size-64 short:size-52 tiny:size-40")}>
      {go ? (
        <>
          <span aria-hidden="true" className={cn("pointer-events-none inset-0 z-20 animate-go-flash bg-brand-yellow motion-reduce:hidden", flash === "fixed" ? "fixed" : "absolute")} />
          <span aria-hidden="true" className="absolute size-[150%] animate-tick-ring rounded-full [background:repeating-conic-gradient(from_0deg,hsl(var(--brand-yellow)/0.4)_0_8deg,transparent_8deg_22deg)] motion-reduce:hidden" />
          <span aria-hidden="true" className={cn("absolute rounded-full bg-brand-coral", large ? "size-[min(30rem,51dvh)]" : "size-60 short:size-48 tiny:size-36")} />
          <p key="go" aria-live="assertive" className={cn("relative animate-tick-pop font-display font-bold leading-none text-white [text-shadow:0_6px_0_hsl(var(--brand-coral-deep))] motion-reduce:animate-none", large ? "text-[min(12rem,20dvh)]" : "text-7xl short:text-6xl tiny:text-5xl")}>GO!</p>
        </>
      ) : (
        <div key={left} className="relative grid size-full place-items-center">
          <span aria-hidden="true" className="absolute size-full animate-tick-ring rounded-full border-4 border-brand-yellow/70 motion-reduce:hidden" />
          <span aria-hidden="true" className={cn("absolute rounded-full bg-white/10 ring-4 ring-white/15", large ? "size-[min(30rem,51dvh)]" : "size-56 short:size-44 tiny:size-32")} />
          <p aria-live="assertive" className={cn("relative animate-tick-pop font-display font-bold leading-none text-brand-yellow [text-shadow:0_8px_0_hsl(var(--brand-yellow-deep))] motion-reduce:animate-none", large ? "text-[min(20rem,34dvh)]" : "text-[9rem] short:text-[7rem] tiny:text-[5.5rem]")}>{left}</p>
        </div>
      )}
    </div>
  );
}
