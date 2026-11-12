"use client";

import { useEffect } from "react";

/** Starts the homepage scroll story after hydration. The engine is code-split and loaded on demand. */
export function StoryDriver() {
  useEffect(() => {
    let stop: (() => void) | undefined;
    let gone = false;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const start = () => {
      stop?.();
      stop = undefined;
      void import("./engine").then(({ startStory }) => { if (!gone) stop = startStory(); });
    };
    start();
    reduced.addEventListener("change", start);
    return () => { gone = true; reduced.removeEventListener("change", start); stop?.(); };
  }, []);
  return null;
}
