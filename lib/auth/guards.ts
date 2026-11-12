import "server-only";

import { HttpError } from "@/lib/api/http";
import { createClient } from "@/lib/supabase/server";
import type { Entitlement, UserRole } from "@/lib/supabase/database.types";

/**
 * Server-side authorization. The role is read from `public.profiles` (protected
 * by RLS + column grants + a trigger), NEVER from JWT/user metadata, which the
 * user can edit. Route protection in proxy.ts is only a UX convenience: call
 * these inside every handler / server action that does anything privileged.
 */
export async function requireUser() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub;
  if (error || !userId) throw new HttpError(401, "unauthenticated");
  return { supabase, userId };
}

export async function requireRole(role: UserRole) {
  const ctx = await requireUser();
  const { data, error } = await ctx.supabase
    .from("profiles")
    .select("role")
    .eq("id", ctx.userId)
    .maybeSingle();
  if (error) throw new HttpError(500, "profile_lookup_failed");
  if (data?.role !== role) throw new HttpError(403, "forbidden");
  return ctx;
}

export const requireSuperAdmin = () => requireRole("super_admin");

/**
 * Subscriber with an unexpired subscription. Entitlement is computed by the
 * database (`my_entitlement`, time-based), the same source the triggers use,
 * so UI checks and DB enforcement cannot disagree. The DB still enforces on
 * every write; this is for early, friendly failures.
 */
export async function requireActiveSubscription(): Promise<
  Awaited<ReturnType<typeof requireUser>> & { entitlement: Entitlement }
> {
  const ctx = await requireUser();
  const { data, error } = await ctx.supabase.rpc("my_entitlement");
  if (error) throw new HttpError(500, "entitlement_lookup_failed");
  const entitlement = data?.[0];
  if (!entitlement) throw new HttpError(402, "subscription_required");
  return { ...ctx, entitlement };
}
