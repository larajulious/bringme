"use client";

import { useLayoutEffect } from "react";

/**
 * Document scroll lock for screens that must fit the viewport (dashboard, player, auth, 404).
 *
 * Why not just CSS `html:has(.fit-viewport)`: with Cache Components, Next.js keeps recently visited routes mounted
 * but hidden (React <Activity>, `display: none`). A hidden dashboard still matched `:has()`, so the homepage
 * couldn't scroll after navigating to it. Instead React owns a `data-fit-viewport` attribute on <html>: set while a
 * fit screen is visible, removed in the effect cleanup (which also runs when Activity hides the route).
 * Layout effects run before paint, so there's no flash. A counter handles overlapping mounts during transitions.
 */
let active = 0;

export function FitViewport() {
  useLayoutEffect(() => {
    active += 1;
    document.documentElement.setAttribute("data-fit-viewport", "");
    return () => {
      active = Math.max(0, active - 1);
      if (active === 0) document.documentElement.removeAttribute("data-fit-viewport");
    };
  }, []);
  return null;
}

/**
 * Marks <html> once React has hydrated. Before that, the CSS falls back to `:has(.fit-viewport)` so the very first
 * paint of a fit screen is already locked (no address-bar jump on phones); afterwards only the attribute counts.
 */
export function HydrationMark() {
  useLayoutEffect(() => {
    document.documentElement.setAttribute("data-hydrated", "");
  }, []);
  return null;
}
