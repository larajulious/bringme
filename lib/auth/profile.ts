import "server-only";

import type { createClient } from "@/lib/supabase/server";
import type { Profile } from "@/lib/supabase/database.types";

type Client = Awaited<ReturnType<typeof createClient>>;
export type ProfileRow = Pick<Profile, "id" | "email" | "display_name" | "role" | "deactivated_at">;

/**
 * Read the signed-in user's own profile under their session (RLS applies).
 * Distinguishes "no row visible" from "the query failed", which used to be
 * reported the same way (profile_missing).
 *
 * TEMPORARY diagnostics (Phase 11 auth investigation): logs only the user id,
 * the Postgres/PostgREST error code + message, and whether a row came back.
 * Never logs cookies, tokens, passwords or keys. Remove once login is verified.
 */
export async function lookupOwnProfile(
  supabase: Client,
  userId: string,
  where: string,
): Promise<{ profile: ProfileRow | null; failed: boolean }> {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, email, display_name, role, deactivated_at")
    .eq("id", userId)
    .maybeSingle();

  if (error || !data) {
    console.warn("[auth:profile]", JSON.stringify({
      where,
      userId,
      found: Boolean(data),
      errorCode: error?.code ?? null,
      errorMessage: error?.message ?? null,
      hint: error ? null : "0 rows visible: row absent OR RLS select policy missing (is migration 2 applied?)",
    }));
  }
  return { profile: data ?? null, failed: Boolean(error) };
}
