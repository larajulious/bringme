import type { Metadata } from "next";
import { headers } from "next/headers";

import { PageHeading } from "@/components/layout/dashboard-shell";
import { CurrentPass } from "@/components/subscription/current-pass";
import { PlanPicker, type PickerPlan, type TrialCard } from "@/components/subscription/plan-picker";
import { PurchaseHistory, type PurchaseRow } from "@/components/subscription/purchase-history";
import { Card, CardContent } from "@/components/ui/card";
import { getMyGamePass, requireSubscriberPage } from "@/lib/auth/session";
import { publicBillingState, type PaidPlanCode } from "@/lib/billing/config";
import { defaultCurrency, parseCurrency, type CheckoutCurrency } from "@/lib/billing/currency";
import { getBillingConfig } from "@/lib/billing/polar";
import { getPriceSync } from "@/lib/billing/price-sync-server";
import { createClient } from "@/lib/supabase/server";
import type { PassTimelineEntry } from "@/lib/supabase/database.types";

export const metadata: Metadata = { title: "Game Pass" };

export default async function GamePassPage({ searchParams }: { searchParams: Promise<{ checkout?: string; currency?: string; buy?: string }> }) {
  await requireSubscriberPage();
  const sp = await searchParams;
  const h = await headers();
  const config = getBillingConfig();
  const billing = publicBillingState(config);
  const initialCurrency: CheckoutCurrency = parseCurrency(sp.currency)
    ?? defaultCurrency({ country: h.get("x-vercel-ip-country"), acceptLanguage: h.get("accept-language") });

  const supabase = await createClient();
  const [pass, plans, prices, timeline, history] = await Promise.all([
    getMyGamePass(),
    supabase.from("subscription_plans").select("id, code, name, max_players_per_game, max_rounds_per_game, duration_seconds, is_trial, tier, is_active")
      .not("tier", "is", null).order("tier"),
    supabase.from("plan_prices").select("plan_id, currency, amount_minor").eq("is_active", true),
    supabase.rpc("my_pass_timeline"),
    supabase.rpc("my_purchase_history"),
  ]);

  const priceMap = (planId: string) => {
    const out: PickerPlan["prices"] = {};
    for (const x of prices.data ?? []) { const c = parseCurrency(x.currency); if (x.plan_id === planId && c && x.amount_minor > 0) out[c] = x.amount_minor; }
    return out;
  };
  const paid = (plans.data ?? []).filter((p) => !p.is_trial && p.is_active);
  // Pricing safety: only prices Polar is confirmed to charge exactly are offered for checkout.
  const sync = billing.checkout
    ? await getPriceSync(Object.fromEntries(paid.filter((p) => billing.plans.includes(p.code as PaidPlanCode)).map((p) => [p.code, priceMap(p.id)])), config)
    : {};
  const pickerPlans: PickerPlan[] = paid.map((p) => {
    const pr = priceMap(p.id);
    const s = sync[p.code as PaidPlanCode] ?? {};
    return {
      code: p.code, name: p.name, maxPlayers: p.max_players_per_game, maxRounds: p.max_rounds_per_game, days: Math.round(p.duration_seconds / 86_400), prices: pr,
      purchasable: { PHP: s.PHP === "ok", USD: s.USD === "ok" },
    };
  });

  const trialPlan = (plans.data ?? []).find((p) => p.is_trial);
  const trial: TrialCard | null = trialPlan ? {
    maxPlayers: trialPlan.max_players_per_game, maxRounds: trialPlan.max_rounds_per_game, days: Math.round(trialPlan.duration_seconds / 86_400),
    state: !trialPlan.is_active ? "unavailable"
      : pass?.trial.status === "active" ? "active"
      : pass?.trial.used ? "used"
      : pass?.trial.eligible ? "available" : "unavailable",
  } : null;

  return (
    <>
      <PageHeading title="Your Game Pass" description="7-Day Game Passes: pay once, host for seven days." />

      {sp.checkout === "canceled" ? (
        <Card className="mb-8 max-w-3xl border-brand-coral/40" role="status">
          <CardContent className="pt-6">
            <p className="font-semibold text-foreground">Checkout cancelled. You were not charged.</p>
            <p className="text-sm text-muted-foreground">Pick a pass below whenever you&apos;re ready.</p>
          </CardContent>
        </Card>
      ) : null}

      <section aria-label="Current pass" className="mb-10 max-w-4xl">
        <CurrentPass summary={pass} timeline={(timeline.data ?? []) as PassTimelineEntry[]} />
      </section>

      <section id="plans" aria-labelledby="plans-h" className="mb-12 scroll-mt-24">
        <h2 id="plans-h" className="mb-2 text-xl font-bold text-primary">Buy Game Pass</h2>
        <p className="mb-5 max-w-2xl text-sm text-muted-foreground">
          Buying a bigger pass starts it right away and keeps the unused days of your current one for later. The same pass again adds 7 days.
        </p>
        <PlanPicker
          plans={pickerPlans}
          trial={trial}
          current={{ active: pass?.state === "active", isTrial: pass?.isTrial ?? false, maxPlayers: pass?.maxPlayers ?? null }}
          initialCurrency={initialCurrency}
          checkoutEnabled={billing.checkout}
          testMode={billing.checkout && billing.environment === "sandbox"}
          highlight={pickerPlans.some((p) => p.code === sp.buy) ? sp.buy : null}
        />
      </section>

      <section aria-labelledby="history-h">
        <h2 id="history-h" className="mb-4 text-xl font-bold text-primary">Purchase History</h2>
        <PurchaseHistory rows={(history.data ?? []) as PurchaseRow[]} emptyText="No purchases yet. Your free trial and passes bought here will appear in this list." />
      </section>
    </>
  );
}
