import type { ReactNode } from "react";
import { Logo } from "@/components/brand/logo";
import { Badge } from "@/components/ui/badge";
import { LogoutButton } from "@/components/logout-button";
import { cn } from "@/lib/utils";
import { DashboardNav } from "@/components/layout/dashboard-nav";
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
          "flex flex-col gap-3 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] text-white sm:px-5 lg:h-full lg:gap-8 lg:overflow-y-auto lg:py-8 lg:short:gap-5 lg:short:py-6",
          tone === "admin" ? "bg-brand-night" : "bg-primary",
        )}
      >
        <div className="flex items-center justify-between gap-3 lg:flex-col lg:items-start">
          <Logo href="/" size="md" tone="light" />
          <Badge variant="yellow">{role}</Badge>
        </div>

        <DashboardNav nav={nav} label={`${role} sections`} tone={tone} />

        <div className="hidden flex-col items-start gap-3 lg:flex">
          {userLabel ? <p className="max-w-full truncate text-sm text-white/80">{userLabel}</p> : null}
          <LogoutButton redirectTo={logoutTo} />
        </div>
      </aside>

      <main className="min-h-0 min-w-0 overflow-y-auto overscroll-contain px-4 pt-5 sm:p-8 lg:p-12 lg:short:p-8">
        <div className="mx-auto w-full max-w-6xl">{children}</div>
        <div className="-mx-4 mt-8 flex items-center justify-between gap-3 bg-primary/90 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:-mx-8 sm:-mb-8 sm:px-8 lg:hidden">
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
