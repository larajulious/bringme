"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3, CirclePlus, LayoutDashboard, ListChecks, Settings, Sparkles, Ticket, Users, type LucideIcon,
} from "lucide-react";

import type { NavIcon, NavItem } from "@/components/layout/dashboard-shell";
import { cn } from "@/lib/utils";

const ICONS: Record<NavIcon, LucideIcon> = {
  home: LayoutDashboard, create: CirclePlus, fun: Sparkles, pass: Ticket,
  users: Users, plans: ListChecks, revenue: BarChart3, settings: Settings,
};

/** The nav item whose href is the longest prefix of the current path ("/dashboard" only matches itself or deeper). */
function activeHref(nav: NavItem[], path: string): string | undefined {
  return nav
    .map((n) => n.href)
    .filter((h): h is string => !!h && (path === h || path.startsWith(`${h}/`)))
    .sort((a, b) => b.length - a.length)[0];
}

/**
 * `sidebar`: vertical list for lg+ screens.
 * `tabs`: bottom tab bar for phones/tablets (icons + short labels, thumb-reachable, safe-area aware).
 */
export function DashboardNav({ nav, label, variant }: { nav: NavItem[]; label: string; variant: "sidebar" | "tabs" }) {
  const current = activeHref(nav, usePathname());

  if (variant === "tabs") {
    return (
      <nav aria-label={label} className="border-t border-white/10 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1.5">
        <ul className="mx-auto flex max-w-lg">
          {nav.map((item) => {
            const Icon = item.icon ? ICONS[item.icon] : null;
            const on = !!item.href && item.href === current;
            const inner = (
              <>
                <span className={cn("grid h-8 w-14 place-items-center rounded-full transition-colors", on ? "bg-white/20" : "")}>
                  {Icon ? <Icon aria-hidden="true" className="size-5" /> : null}
                </span>
                <span className="max-w-full truncate">{item.short ?? item.label}</span>
              </>
            );
            return (
              <li key={item.label} className="min-w-0 flex-1">
                {item.href ? (
                  <Link
                    href={item.href}
                    aria-current={on ? "page" : undefined}
                    className={cn(
                      "flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-2xl px-1 font-display text-[11px] font-semibold transition-colors",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-yellow",
                      on ? "text-brand-yellow" : "text-white/80 hover:text-white",
                    )}
                  >
                    {inner}
                  </Link>
                ) : (
                  <span className="flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 font-display text-[11px] font-semibold text-white/50">
                    {inner}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </nav>
    );
  }

  return (
    <nav aria-label={label} className="flex-1">
      <ul className="flex flex-col gap-2">
        {nav.map((item) => {
          const Icon = item.icon ? ICONS[item.icon] : null;
          const on = !!item.href && item.href === current;
          return (
            <li key={item.label}>
              {item.href ? (
                <Link
                  href={item.href}
                  aria-current={on ? "page" : undefined}
                  className={cn(
                    "flex min-h-11 items-center gap-3 rounded-2xl px-4 font-display font-semibold transition-colors",
                    on ? "bg-white text-primary" : "bg-white/10 hover:bg-white/20",
                  )}
                >
                  {Icon ? <Icon aria-hidden="true" className="size-5 shrink-0" /> : null}
                  {item.label}
                </Link>
              ) : (
                <span className="flex min-h-11 items-center gap-3 rounded-2xl px-4 font-display font-semibold text-white/70">
                  {Icon ? <Icon aria-hidden="true" className="size-5 shrink-0" /> : null}
                  {item.label}
                  <span className="ml-auto rounded-full bg-white/15 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide">Soon</span>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
