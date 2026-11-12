import type { ReactNode } from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";

import { Logo } from "@/components/brand/logo";
import { Badge } from "@/components/ui/badge";
import { LogoutButton } from "@/components/logout-button";
import { cn } from "@/lib/utils";
import { DashboardNav } from "@/components/layout/dashboard-nav";
import { FitViewport } from "@/components/layout/fit-viewport";

export type NavIcon = "home" | "create" | "fun" | "pass" | "users" | "plans" | "revenue" | "settings";

export type NavItem = {
  label: string;
  /** Omit for sections that are not built yet (rendered as "Soon"). */
  href?: string;
  icon?: NavIcon;
  /** Shorter label for the phone tab bar (defaults to `label`). */
  short?: string;
};

type DashboardShellProps = {
  role: string;
  tone?: "admin" | "host";
  nav: NavItem[];
  /** Shown above the log-out button. */
  userLabel?: string;
  children: ReactNode;
};

/**
 * Shell for Super Admin and Game Master screens.
 * lg+: sidebar (logo, nav, account). Phones/tablets: slim top bar (logo + log out), content, bottom tab bar.
 */
export function DashboardShell({
  role,
  tone = "host",
  nav,
  userLabel,
  children,
}: DashboardShellProps) {
  const logoutTo = tone === "admin" ? "/admin/login" : "/auth/login";
  const bg = tone === "admin" ? "bg-brand-night" : "bg-primary";
  const label = `${role} sections`;
  // Exactly the viewport: the bars stay put and only <main> scrolls (no page scroll, no address-bar shift).
  return (
    <div className="fit-viewport h-viewport grid grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden lg:grid-cols-[17rem_minmax(0,1fr)] lg:grid-rows-1">
      <FitViewport />
      <aside className={cn("flex flex-col text-white lg:h-full lg:gap-8 lg:overflow-y-auto lg:px-5 lg:py-8 lg:short:gap-5 lg:short:py-6", bg)}>
        {/* Phones: one slim bar. lg: logo + role at the top of the sidebar. */}
        <div className="flex items-center justify-between gap-3 px-4 pb-2.5 pt-[max(0.625rem,env(safe-area-inset-top))] sm:px-6 lg:flex-col lg:items-start lg:p-0">
          <Logo href="/" size="md" tone="light" />
          <div className="flex items-center gap-2 lg:hidden">
            <Badge variant="yellow" className="hidden min-[420px]:inline-flex">{role}</Badge>
            <LogoutButton redirectTo={logoutTo} />
          </div>
          <Badge variant="yellow" className="hidden lg:inline-flex">{role}</Badge>
        </div>

        <div className="hidden lg:flex lg:flex-1 lg:flex-col">
          <DashboardNav nav={nav} label={label} variant="sidebar" />
        </div>

        <div className="hidden flex-col items-start gap-3 lg:flex">
          {userLabel ? <p className="max-w-full truncate text-sm text-white/80">{userLabel}</p> : null}
          <LogoutButton redirectTo={logoutTo} />
        </div>
      </aside>

      <main className="min-h-0 min-w-0 overflow-y-auto overscroll-contain px-4 pb-10 pt-5 sm:p-8 lg:p-12 lg:short:p-8">
        <div className="mx-auto w-full max-w-6xl">{children}</div>
      </main>

      <div className={cn("text-white lg:hidden", bg)}>
        <DashboardNav nav={nav} label={label} variant="tabs" />
      </div>
    </div>
  );
}

/** "Back to …" button for deeper dashboard screens, with optional actions on the right (e.g. presenter screen). */
export function BackBar({ href, label, children }: { href: string; label: string; children?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <Link
        href={href}
        className="-ml-2 inline-flex min-h-11 items-center gap-1.5 rounded-2xl px-2 font-display font-semibold text-primary transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/40"
      >
        <ChevronLeft aria-hidden="true" className="size-5" /> {label}
      </Link>
      {children ? <div className="flex flex-wrap items-center gap-3">{children}</div> : null}
    </div>
  );
}

/** Standard page heading for dashboard screens. */
export function PageHeading({
  title,
  description,
  className,
}: {
  title: string;
  description?: string;
  className?: string;
}) {
  return (
    <header className={cn("mb-6 space-y-1.5 sm:mb-8 sm:space-y-2", className)}>
      <h1 className="break-words text-2xl font-bold text-primary sm:text-4xl">{title}</h1>
      {description ? (
        <p className="max-w-2xl text-base text-muted-foreground sm:text-lg">{description}</p>
      ) : null}
    </header>
  );
}
