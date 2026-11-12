import { NextResponse, type NextRequest } from "next/server";

import { lookupOwnProfile } from "@/lib/auth/profile";
import { safeNext } from "@/lib/auth/redirect";
import { createClient } from "@/lib/supabase/server";

/**
 * Post-authentication router. The destination is decided on the SERVER from
 * profiles.role, so the client cannot pick its own area.
 *   ?area=admin  -> only super admins may continue; others are signed out.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const area = searchParams.get("area");
  const to = (path: string) => NextResponse.redirect(new URL(path, origin));

  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub;
  if (!userId) return to(area === "admin" ? "/admin/login?reason=expired" : "/auth/login?reason=expired");

  const { profile, failed } = await lookupOwnProfile(supabase, userId, "auth/continue");
  if (failed) return to("/auth/error?error=profile_lookup_failed");
  if (!profile) return to("/auth/error?error=profile_missing");

  if (area === "admin") {
    if (profile.role !== "super_admin") {
      await supabase.auth.signOut();
      return to("/admin/login?error=forbidden");
    }
    return to("/admin/dashboard");
  }
  if (profile.role === "super_admin") return to("/admin/dashboard");
  // Onboarding: a valid Game Master gets the one-time free trial (normally already granted by
  // the database when the email was confirmed). Idempotent and server-decided: repeated
  // sign-ins, new browsers or refreshes never restart it. Failures never block sign-in.
  if (profile.role === "subscriber" && !profile.deactivated_at) {
    const { error } = await supabase.rpc("ensure_my_trial");
    if (error) console.warn("[auth:trial]", JSON.stringify({ userId, errorCode: error.code ?? null }));
  }
  return to(safeNext(searchParams.get("next"), "/dashboard"));
}
