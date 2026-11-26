import type { Metadata } from "next";

import { HealthView } from "@/components/admin/health-view";
import { getUtilization } from "@/lib/admin/queries";
import { supabaseDashboardUrl } from "@/lib/admin/utilization";
import { requireAdminPage } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Capacity & health" };

export default async function HealthPage() {
  await requireAdminPage();
  const { utilization, limits } = await getUtilization();
  return <HealthView u={utilization} limits={limits} dashboard={supabaseDashboardUrl(process.env.NEXT_PUBLIC_SUPABASE_URL)} />;
}
