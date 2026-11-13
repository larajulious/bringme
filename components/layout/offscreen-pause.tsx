"use client";

import { useEffect, useRef } from "react";

/**
 * Pauses every CSS animation inside its parent element while the parent is off screen (sets
 * `data-offscreen` on it; see globals.css). Decorative loops on SVG children (sparkles, blinks) can't run on
 * the compositor, so off screen they would still cost a style + layout + paint every frame. Renders nothing visible.
 */
export function OffscreenPause() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const host = ref.current?.parentElement;
    if (!host || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) delete host.dataset.offscreen;
      else host.dataset.offscreen = "";
    });
    io.observe(host);
    return () => { io.disconnect(); delete host.dataset.offscreen; };
  }, []);
  return <span ref={ref} hidden />;
}
