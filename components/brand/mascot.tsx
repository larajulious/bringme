import { useId } from "react";

import { cn } from "@/lib/utils";

type Mood = "happy" | "waiting" | "cheer" | "judging";

/**
 * "Snappy", the BringMe! camera mascot. Pure SVG + CSS (no assets, no JS): it
 * bobs, blinks and looks around. Decorative by default; pass `label` when it
 * carries meaning. Motion is switched off for reduced-motion users.
 */
export function Mascot({ mood = "happy", className, label }: { mood?: Mood; className?: string; label?: string }) {
  // Eyelid clipped to the inside of the lens. Resting state = OPEN (lid parked above the lens, invisible);
  // the blink drops it down and lifts it again quickly. Reduced motion keeps the resting state.
  const lensClip = `mascot-lens-${useId().replace(/:/g, "")}`;
  return (
    <svg
      viewBox="0 0 120 104"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("overflow-visible", mood !== "judging" && "animate-bob motion-reduce:animate-none", className)}
    >
      <ellipse cx="60" cy="100" rx="38" ry="4" fill="#000" opacity=".16" />
      {/* viewfinder bump + flash */}
      <rect x="40" y="8" width="40" height="20" rx="8" fill="#e8a317" />
      <rect x="88" y="12" width="16" height="11" rx="4" fill="#e11d48" />
      {/* body */}
      <rect x="6" y="20" width="108" height="76" rx="20" fill="#ffc83d" />
      <rect x="6" y="76" width="108" height="20" rx="14" fill="#f5b21f" />
      {/* cheeks */}
      <ellipse cx="22" cy="68" rx="8" ry="5" fill="#e11d48" opacity=".35" />
      <ellipse cx="98" cy="68" rx="8" ry="5" fill="#e11d48" opacity=".35" />
      {/* eye (lens) */}
      <circle cx="60" cy="54" r="26" fill="#fff" stroke="#5b21b6" strokeWidth="6" />
      <g className={cn(mood === "waiting" && "animate-look motion-reduce:animate-none")}>
        <circle cx="60" cy="55" r={mood === "judging" ? 9 : 14} fill="#2a0f5c" />
        <circle cx="55" cy="50" r="4" fill="#fff" />
      </g>
      <clipPath id={lensClip}>
        <circle cx="60" cy="54" r="23" />
      </clipPath>
      <g clipPath={`url(#${lensClip})`}>
        {/* closed = a soft curved lash, like a contented blink */}
        <g style={{ transform: "translateY(-62px)" }} className="animate-blink motion-reduce:animate-none">
          <path d="M20 20H100V78Q60 90 20 78Z" fill="#ffc83d" />
          <path d="M44 64Q60 74 76 64" fill="none" stroke="#2a0f5c" strokeWidth="4" strokeLinecap="round" />
        </g>
      </g>
      {mood === "judging" ? <path d="M38 36q22-12 44 0" fill="none" stroke="#2a0f5c" strokeWidth="5" strokeLinecap="round" /> : null}
      {/* smile */}
      <path d={mood === "cheer" ? "M48 84q12 11 24 0" : "M52 85q8 6 16 0"} fill="none" stroke="#2a0f5c" strokeWidth="4" strokeLinecap="round" />
      {mood === "cheer" ? (
        <>
          <path d="M14 14l3 7 7 3-7 3-3 7-3-7-7-3 7-3z" fill="#fff" className="animate-twinkle motion-reduce:animate-none" />
          <path d="M104 40l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" fill="#fff" className="animate-twinkle motion-reduce:animate-none" style={{ animationDelay: "1s" }} />
        </>
      ) : null}
    </svg>
  );
}
