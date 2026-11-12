import "server-only";

import { createClient } from "@supabase/supabase-js";

import type { Database } from "./database.types";

/**
 * PRIVILEGED Supabase client (bypasses RLS).
 *
 * SECURITY RULES
 * - `server-only` makes the build fail if this module is imported from a client component.
 * - The key comes from a non-`NEXT_PUBLIC_` env var, so it is never bundled for the browser.
 * - Importing this module is NOT authorization. Every caller must first authenticate
 *   and authorize the request (requireSuperAdmin / getGuestPlayer / ownership check),
 *   and must scope every query itself (e.g. `.eq("game_id", player.game_id)`).
 * - Create it per call; never keep it in a module-level variable or log its config.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Server is missing SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY).");
  }
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
