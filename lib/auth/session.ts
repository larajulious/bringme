import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { lookupOwnProfile, type ProfileRow } from "@/lib/auth/profile";
import type { AccessStatus, Entitlement, GamePassSummary } from "@/lib/supabase/database.types";

export type AppSession = {
  userId: string;
  email: string | null;
  profile: ProfileRow | null;
  /** The profile query itself errored (not the same as "no row"). */
  profileLookupFailed: boolean;
};

/**
 * Current user for Server Components (memoised per request). Identity comes
 * from verified JWT claims; the ROLE comes from the database, never from
 * metadata. Call it in every protected layout AND page: layouts don't re-run on
 * client navigations, so a layout check alone is not enough.
 */
export const getSession = cache(async (): Promise<AppSession | null> => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (error || !claims?.sub) return null;

  const { profile, failed } = await lookupOwnProfile(supabase, claims.sub, "getSession");

  return {
    userId: claims.sub,
    email: typeof claims.email === "string" ? claims.email : null,
    profile,
    profileLookupFailed: failed,
  };
});

/** Subscriber / Game Master pages. Unauthenticated -> login; admins -> admin console. */
export async function requireSubscriberPage() {
  const session = await getSession();
  if (!session) redirect("/auth/login?reason=expired");
  if (!session.profile) redirect(`/auth/error?error=${session.profileLookupFailed ? "profile_lookup_failed" : "profile_missing"}`);
  if (session.profile.role === "super_admin") redirect("/admin/dashboard");
  // Existing sessions of a deactivated account stop working immediately (the auth ban also blocks refresh).
  if (session.profile.deactivated_at) redirect("/auth/login?error=deactivated");
  return { ...session, profile: session.profile };
}

/** Super Admin pages. Verified on the server against profiles.role. */
export async function requireAdminPage() {
  const session = await getSession();
  if (!session) redirect("/admin/login?reason=expired");
  if (session.profile?.role !== "super_admin") redirect("/dashboard");
  return { ...session, profile: session.profile };
}

export async function getMyAccessStatus(): Promise<AccessStatus> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("my_access_status");
  const row = data?.[0];
  // Fail closed: if the lookup breaks, treat the user as not entitled.
  if (error || !row) return { state: "pending", plan_code: null, current_period_end: null };
  return row;
}

/** Plan limits for an ACTIVE subscriber, or null (pending/expired/suspended/deactivated). */
export async function getMyEntitlement(): Promise<Entitlement | null> {
  const { data, error } = await (await createClient()).rpc("my_entitlement");
  return error ? null : (data?.[0] ?? null);
}

/** Game Pass / trial summary for the host dashboard (database clock; null if the lookup fails). */
export const getMyGamePass = cache(async (): Promise<GamePassSummary | null> => {
  const { data, error } = await (await createClient()).rpc("my_game_pass_summary");
  return error || !data ? null : (data as GamePassSummary);
});
