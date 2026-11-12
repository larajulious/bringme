"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { formatRemaining } from "@/lib/game-pass/format";

/**
 * Remaining time, counted down from the SERVER's figure (not the device clock, which
 * may be wrong). Purely informative: the database decides when access ends. When it
 * reaches zero the page is refreshed once so the server can show the new state.
 */
export function RemainingTime({ seconds, className }: { seconds: number; className?: string }) {
  const router = useRouter();
  const started = useRef<number | null>(null);
  const refreshed = useRef(false);
  const [left, setLeft] = useState(seconds);

  useEffect(() => {
    started.current = performance.now();
    setLeft(seconds);
    const tick = () => {
      const s = seconds - (performance.now() - (started.current ?? 0)) / 1000;
      setLeft(s);
      if (s <= 0 && !refreshed.current) {
        refreshed.current = true;
        router.refresh();
      }
    };
    // Every 20 s is enough for minute precision; every second during the final minute.
    const id = window.setInterval(tick, seconds < 120 ? 1_000 : 20_000);
    return () => window.clearInterval(id);
  }, [seconds, router]);

  return <span className={className}>{formatRemaining(left)}</span>;
}

/** The end instant in the viewer's own time zone (rendered after mount; UTC on the server). */
export function LocalDateTime({ iso }: { iso: string }) {
  const utc = `${new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC`;
  const [text, setText] = useState(utc);
  useEffect(() => {
    setText(new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }));
  }, [iso]);
  return <time dateTime={iso}>{text}</time>;
}
