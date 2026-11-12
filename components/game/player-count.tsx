"use client";

import { Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * "N players here" with feedback when the number changes: the digit pops, a
 * soft ring pulses, and a floating "+1" shows who just arrived.
 */
export function PlayerCount({ count, light = true }: { count: number; light?: boolean }) {
  const prev = useRef(count);
  const [delta, setDelta] = useState<{ n: number; key: number } | null>(null);

  useEffect(() => {
    const d = count - prev.current;
    prev.current = count;
    if (d > 0) {
      setDelta({ n: d, key: Date.now() });
      const t = setTimeout(() => setDelta(null), 1700);
      return () => clearTimeout(t);
    }
  }, [count]);

  return (
    <div className="relative inline-flex items-center gap-3 rounded-full bg-white/12 py-2 pl-3 pr-5" role="status" aria-live="polite">
      <span className="relative grid size-10 place-items-center rounded-full bg-brand-yellow text-brand-night">
        {delta ? <span key={delta.key} aria-hidden="true" className="absolute inset-0 animate-ping-soft rounded-full bg-brand-yellow motion-reduce:hidden" /> : null}
        <Users aria-hidden="true" className="relative size-5" />
      </span>
      <span className={`font-display text-xl font-semibold ${light ? "text-white" : ""}`}>
        <span key={count} className="inline-block animate-pop-in text-brand-yellow">{count}</span> {count === 1 ? "player" : "players"} here
      </span>
      {delta ? (
        <span key={`d${delta.key}`} aria-hidden="true" className="absolute -top-3 right-2 animate-plus-float font-display text-lg font-bold text-brand-yellow motion-reduce:hidden">
          +{delta.n}
        </span>
      ) : null}
    </div>
  );
}
