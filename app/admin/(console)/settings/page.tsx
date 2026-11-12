import type { Metadata } from "next";

import { SettingsForm } from "@/components/admin/settings-form";
import { PageHeading } from "@/components/layout/dashboard-shell";
import { getSettings } from "@/lib/admin/queries";
import { requireAdminPage } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  await requireAdminPage();
  const settings = await getSettings();
  return (
    <>
      <PageHeading title="Platform settings" description="Defaults and limits that apply across BringMe!." />
      <SettingsForm settings={settings} />
    </>
  );
}
