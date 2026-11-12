import type { Metadata } from "next";

import { DashboardShell, type NavItem } from "@/components/layout/dashboard-shell";
import { requireSubscriberPage } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Dashboard", robots: { index: false } };

const nav: NavItem[] = [
  { label: "Dashboard", href: "/dashboard" },
  { label: "Create game", href: "/dashboard/games/new" },
  { label: "Extra Fun", href: "/dashboard/extra-fun" },
  { label: "Game Pass", href: "/dashboard/subscription" },
];

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { email, profile } = await requireSubscriberPage();
  return (
    <DashboardShell role="Game Master" tone="host" nav={nav} userLabel={profile.display_name ?? email ?? undefined}>
      {children}
    </DashboardShell>
  );
}
