import type { ReactNode } from "react";
import Link from "next/link";

import { Logo } from "@/components/brand/logo";
import { Badge } from "@/components/ui/badge";
import { LogoutButton } from "@/components/logout-button";
import { cn } from "@/lib/utils";
import { FitViewport } from "@/components/layout/fit-viewport";

export type NavItem = {
  label: string;
  /** Omit for sections that are not built yet (rendered as "Soon"). */
  href?: string;
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
 * Desktop-first shell for Super Admin and Game Master screens:
 * sidebar on lg+, stacked header + horizontal nav below.
 */
export function DashboardShell({
  role,
  tone = "host",
  nav,
  userLabel,
  children,
}: DashboardShellProps) {
  const logoutTo = tone === "admin" ? "/admin/login" : "/auth/login";
  // Exactly the viewport: the sidebar/top bar stays put and only <main> scrolls (no page scroll, no address-bar shift).
  return (
    <div className="fit-viewport h-viewport grid grid-rows-[auto_minmax(0,1fr)] overflow-hidden lg:grid-cols-[17rem_minmax(0,1fr)] lg:grid-rows-1">
      <FitViewport />
      <aside
        className={cn(
          "flex flex-col gap-4 px-5 py-4 text-white short:gap-3 short:py-3 lg:h-full lg:gap-8 lg:overflow-y-auto lg:py-8 lg:short:gap-5 lg:short:py-6",
          tone === "admin" ? "bg-brand-night" : "bg-primary",
        )}
      >
        <div className="flex items-center justify-between gap-3 lg:flex-col lg:items-start">
          <Logo href="/" size="md" tone="light" />
          <Badge variant="yellow">{role}</Badge>
        </div>

        <nav aria-label={`${role} sections`} className="lg:flex-1">
          <ul className="flex gap-2 overflow-x-auto lg:flex-col">
            {nav.map((item) => (
              <li key={item.label} className="shrink-0">
                {item.href ? (
                  <Link
                    href={item.href}
                    className="flex min-h-11 items-center rounded-2xl bg-white/15 px-4 font-display font-semibold hover:bg-white/25"
                  >
                    {item.label}
                  </Link>
                ) : (
                  <span className="flex min-h-11 items-center justify-between gap-3 rounded-2xl px-4 font-display font-semibold text-white/70">
                    {item.label}
                    <span className="rounded-full bg-white/15 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide">
                      Soon
                    </span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </nav>

        <div className="hidden flex-col items-start gap-3 lg:flex">
          {userLabel ? <p className="max-w-full truncate text-sm text-white/80">{userLabel}</p> : null}
          <LogoutButton redirectTo={logoutTo} />
        </div>
      </aside>

      <main className="min-h-0 min-w-0 overflow-y-auto overscroll-contain p-5 sm:p-8 lg:p-12 lg:short:p-8">
        <div className="mx-auto w-full max-w-6xl">{children}</div>
        <div className="-mx-5 mt-8 flex items-center justify-between gap-3 bg-primary/90 px-5 py-3 sm:-mx-8 sm:px-8 lg:hidden">
          {userLabel ? <p className="truncate text-sm text-white/80">{userLabel}</p> : <span />}
          <LogoutButton redirectTo={logoutTo} />
        </div>
      </main>
    </div>
  );
}

/** Standard page heading for dashboard screens. */
export function PageHeading({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <header className="mb-8 space-y-2">
      <h1 className="text-3xl font-bold text-primary sm:text-4xl">{title}</h1>
      {description ? (
        <p className="max-w-2xl text-lg text-muted-foreground">{description}</p>
      ) : null}
    </header>
  );
}
