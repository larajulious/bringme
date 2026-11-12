"use client";

import { useEffect, useRef } from "react";

/**
 * Scroll reveal without a library. The server renders content fully visible; after hydration the wrapper is
 * marked `data-reveal="armed"` (hidden start state, CSS in globals.css) and flips to `"in"` once it scrolls
 * into view. No JS, no IntersectionObserver or reduced motion = content simply stays visible.
 * Children opt in with `.reveal-item` (+ `.reveal-left` / `.reveal-right`, stagger via `--i`), `.reveal-line`,
 * and `.reveal-loop` (looping animations that wait until the section is on screen).
 */
export function Reveal({ className, children, onEnter, as: Tag = "div", ...rest }: {
  className?: string; children: React.ReactNode; onEnter?: () => void; as?: "div" | "section";
} & React.HTMLAttributes<HTMLElement>) {
  const ref = useRef<HTMLElement>(null);
  const enter = useRef(onEnter);
  useEffect(() => { enter.current = onEnter; }, [onEnter]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") { el.dataset.reveal = "in"; enter.current?.(); return; }
    el.dataset.reveal = "armed";
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      el.dataset.reveal = "in";
      enter.current?.();
      io.disconnect();
    }, { threshold: 0.2, rootMargin: "0px 0px -8% 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return <Tag ref={ref as React.Ref<HTMLDivElement>} className={className} {...rest}>{children}</Tag>;
}
