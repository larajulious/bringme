import "server-only";

import { createClient } from "@supabase/supabase-js";
import { cacheLife } from "next/cache";

import { parseCurrency, type CheckoutCurrency } from "@/lib/billing/currency";
import type { Database } from "@/lib/supabase/database.types";

export type PublicPlan = { code: string; name: string; maxPlayers: number; days: number; prices: Partial<Record<CheckoutCurrency, number>> };
export type PublicCatalog = { trial: { maxPlayers: number; days: number } | null; plans: PublicPlan[] };

/**
 * Active Game Pass catalogue for the public homepage (no login). Reads only what RLS already exposes to `anon`
 * (active plans + active prices) with the publishable key and no cookies, so it can be cached and shared by all
 * visitors. Prices are the same rows checkout uses; checkout still verifies Polar charges exactly this amount.
 * Cached for minutes: admin price edits show up on the homepage shortly after they're saved.
 */
export async function getPublicCatalog(): Promise<PublicCatalog> {
  "use cache";
  cacheLife("minutes");

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return { trial: null, plans: [] };
  const supabase = createClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });

  const [plans, prices] = await Promise.all([
    supabase.from("subscription_plans").select("id, code, name, max_players_per_game, duration_seconds, is_trial, tier, is_active")
      .eq("is_active", true).not("tier", "is", null).order("tier"),
    supabase.from("plan_prices").select("plan_id, currency, amount_minor").eq("is_active", true),
  ]);
  if (plans.error || prices.error) return { trial: null, plans: [] };

  const days = (s: number) => Math.round(s / 86_400);
  const trialRow = (plans.data ?? []).find((p) => p.is_trial);
  return {
    trial: trialRow ? { maxPlayers: trialRow.max_players_per_game, days: days(trialRow.duration_seconds) } : null,
    plans: (plans.data ?? []).filter((p) => !p.is_trial).map((p) => {
      const out: PublicPlan["prices"] = {};
      for (const x of prices.data ?? []) {
        const c = parseCurrency(x.currency);
        if (x.plan_id === p.id && c && x.amount_minor > 0) out[c] = x.amount_minor;
      }
      return { code: p.code, name: p.name, maxPlayers: p.max_players_per_game, days: days(p.duration_seconds), prices: out };
    }).filter((p) => Object.keys(p.prices).length > 0),
  };
}
