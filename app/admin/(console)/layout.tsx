import type { Metadata } from "next";

import { DashboardShell, type NavItem } from "@/components/layout/dashboard-shell";
import { requireAdminPage } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Super Admin", robots: { index: false } };

const nav: NavItem[] = [
  { label: "Dashboard", href: "/admin/dashboard" },
  { label: "Subscribers", href: "/admin/subscribers" },
  { label: "Plans", href: "/admin/plans" },
  { label: "Revenue", href: "/admin/revenue" },
  { label: "Settings", href: "/admin/settings" },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { email, profile } = await requireAdminPage(); // server-verified super_admin
  return (
    <DashboardShell role="Super Admin" tone="admin" nav={nav} userLabel={profile.display_name ?? email ?? undefined}>
      {children}
    </DashboardShell>
  );
}
