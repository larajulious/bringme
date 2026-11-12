import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

import { createClient } from "@/lib/supabase/server";

/**
 * Admin reads run under the signed-in admin's own session (not the service
 * role): the SQL functions / RLS policies re-check super_admin themselves.
 * Callers must still `requireAdminPage()` first so unauthorized users are
 * redirected instead of seeing a database error.
 */
export async function getOverview() {
  const { data, error } = await (await createClient()).rpc("admin_overview");
  if (error || !data?.[0]) throw new Error("Could not load platform metrics");
  return data[0];
}

export async function listSubscribers(args: { q: string; state: string | null; page: number; pageSize: number }) {
  const { data, error } = await (await createClient()).rpc("admin_list_subscribers", {
    p_search: args.q || undefined,
    p_state: (args.state as never) ?? undefined,
    p_limit: args.pageSize,
    p_offset: (args.page - 1) * args.pageSize,
  });
  if (error) throw new Error("Could not load subscribers");
  return { rows: data ?? [], total: data?.[0]?.total_count ?? 0 };
}

export async function listPlans() {
  const { data, error } = await (await createClient())
    .from("subscription_plans")
    .select("*")
    .order("max_players_per_game", { ascending: true });
  if (error) throw new Error("Could not load plans");
  return data ?? [];
}

export async function getSettings() {
  const { data, error } = await (await createClient()).from("platform_settings").select("*").eq("id", true).maybeSingle();
  if (error || !data) throw new Error("Could not load settings");
  return data;
}

export async function getSubscriberDetail(userId: string, gamesPage: number, pageSize: number) {
  const supabase = await createClient();
  const [profile, access, subs, games, gameCount, purchases, audit, trial] = await Promise.all([
    supabase.from("profiles").select("id, email, display_name, role, deactivated_at, created_at").eq("id", userId).maybeSingle(),
    supabase.rpc("admin_subscriber_state", { p_user: userId }),
    // Game Pass ledger: every pass (incl. backfilled legacy subscriptions), newest first.
    supabase.rpc("admin_pass_timeline", { p_user: userId }),
    supabase
      .from("games")
      .select("id, title, status, join_code, max_players, created_at")
      .eq("owner_id", userId)
      .order("created_at", { ascending: false })
      .range((gamesPage - 1) * pageSize, gamesPage * pageSize - 1),
    supabase.from("games").select("id", { count: "exact", head: true }).eq("owner_id", userId),
    supabase.rpc("admin_purchase_history", { p_user: userId }),
    supabase.from("entitlement_events").select("id, at, action, actor_kind, details").eq("user_id", userId).order("at", { ascending: false }).limit(30),
    // trial_eligibility is service-only; the page is already verified as super admin (requireAdminPage).
    createAdminClient().rpc("trial_eligibility", { p_user: userId }),
  ]);
  if (profile.error || access.error || subs.error || games.error) throw new Error("Could not load subscriber");
  return {
    profile: profile.data,
    access: access.data?.[0] ?? null,
    passes: (subs.data ?? []).slice(0, 20),
    purchases: purchases.data ?? [],
    audit: audit.data ?? [],
    trial: trial.data?.[0] ?? null,
    games: games.data ?? [],
    gameTotal: gameCount.count ?? 0,
  };
}
