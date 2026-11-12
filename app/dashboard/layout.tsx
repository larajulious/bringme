import type { Metadata } from "next";

import { DashboardShell, type NavItem } from "@/components/layout/dashboard-shell";
import { requireSubscriberPage } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Dashboard", robots: { index: false } };

const nav: NavItem[] = [
  { label: "Dashboard", short: "Home", href: "/dashboard", icon: "home" },
  { label: "Create game", short: "Create", href: "/dashboard/games/new", icon: "create" },
  { label: "Extra Fun", href: "/dashboard/extra-fun", icon: "fun" },
  { label: "Game Pass", href: "/dashboard/subscription", icon: "pass" },
];

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { email, profile } = await requireSubscriberPage();
  return (
    <DashboardShell role="Game Master" tone="host" nav={nav} userLabel={profile.display_name ?? email ?? undefined}>
      {children}
    </DashboardShell>
  );
}
