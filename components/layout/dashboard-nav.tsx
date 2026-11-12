"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

import type { NavItem } from "@/components/layout/dashboard-shell";
import { cn } from "@/lib/utils";

/** The nav item whose href is the longest prefix of the current path ("/dashboard" only matches itself or deeper). */
function activeHref(nav: NavItem[], path: string): string | undefined {
  return nav
    .map((n) => n.href)
    .filter((h): h is string => !!h && (path === h || path.startsWith(`${h}/`)))
    .sort((a, b) => b.length - a.length)[0];
}

/**
 * Phones/tablets: one horizontally scrolling row (the current item is scrolled into view).
 * lg+: vertical sidebar list.
 */
export function DashboardNav({ nav, label, tone }: { nav: NavItem[]; label: string; tone: "admin" | "host" }) {
  const path = usePathname();
  const current = activeHref(nav, path);
  const activeRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [current]);

  return (
    <nav aria-label={label} className="relative -mx-4 sm:-mx-5 lg:mx-0 lg:flex-1">
      <ul className="no-scrollbar flex snap-x gap-2 overflow-x-auto px-4 sm:px-5 lg:flex-col lg:overflow-visible lg:px-0">
        {nav.map((item) => {
          const on = !!item.href && item.href === current;
          return (
            <li key={item.label} className="shrink-0 snap-start">
              {item.href ? (
                <Link
                  ref={on ? activeRef : undefined}
                  href={item.href}
                  aria-current={on ? "page" : undefined}
                  className={cn(
                    "flex min-h-10 items-center whitespace-nowrap rounded-2xl px-3.5 font-display text-sm font-semibold transition-colors lg:min-h-11 lg:px-4 lg:text-base",
                    on ? "bg-white text-primary" : "bg-white/15 hover:bg-white/25",
                  )}
                >
                  {item.label}
                </Link>
              ) : (
                <span className="flex min-h-10 items-center justify-between gap-3 whitespace-nowrap rounded-2xl px-3.5 font-display text-sm font-semibold text-white/70 lg:min-h-11 lg:px-4 lg:text-base">
                  {item.label}
                  <span className="rounded-full bg-white/15 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide">Soon</span>
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {/* Edge fade: hints that the row scrolls sideways on narrow screens. */}
      <span aria-hidden="true" className={cn("pointer-events-none absolute inset-y-0 right-0w-6 bg-gradient-to-l lg:hidden", tone === "admin" ? "from-brand-night" : "from-primary")} />
    </nav>
  );
}
