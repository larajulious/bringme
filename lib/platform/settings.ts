import "server-only";

import { createClient } from "@/lib/supabase/server";

/** Non-sensitive settings any signed-in user may read (RLS: authenticated). */
export async function getSupportEmail(): Promise<string | null> {
  const { data } = await (await createClient()).from("platform_settings").select("support_email").eq("id", true).maybeSingle();
  return data?.support_email ?? null;
}
