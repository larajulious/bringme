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

  const historyRows = (history.data ?? []) as PurchaseRow[];

  return (
    <div className="grid gap-12">
      <div className="grid gap-4">
        <PageHeading title="Your Game Pass" description="Pay once, host for seven days. No subscriptions, nothing renews." className="mb-0" />
        {sp.checkout === "canceled" ? (
          <Card className="border-brand-coral/40" role="status">
            <CardContent className="pt-6">
              <p className="font-semibold text-foreground">Checkout cancelled. You were not charged.</p>
              <p className="text-sm text-muted-foreground">Pick a pass below whenever you&apos;re ready.</p>
            </CardContent>
          </Card>
        ) : null}
      </div>

      <section aria-labelledby="current-section-h">
        <SectionHeader id="current-section-h" step={1} title="Your current pass" description="What you can host right now, and any passes lined up next." />
        <CurrentPass summary={pass} timeline={(timeline.data ?? []) as PassTimelineEntry[]} />
      </section>

      <section id="plans" aria-labelledby="plans-h" className="scroll-mt-24">
        <SectionHeader
          id="plans-h" step={2} title="Buy a Game Pass"
          description="A bigger pass starts right away and saves the unused days of your current one for later. The same pass again adds 7 days."
        />
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
        <SectionHeader
          id="history-h" step={3} title="Purchase history"
          description={historyRows.length ? `${historyRows.length} order${historyRows.length === 1 ? "" : "s"}.` : undefined}
        />
        <PurchaseHistory resumeEnvironment={billing.checkout ? billing.environment : null} rows={historyRows} emptyText="No purchases yet. Your free trial and passes bought here will appear in this list." />
      </section>
    </div>
  );
}

function SectionHeader({ id, step, title, description }: { id: string; step: number; title: string; description?: string }) {
  return (
    <header className="mb-5 flex items-start gap-3">
      <span aria-hidden="true" className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-primary font-display text-sm font-bold text-primary-foreground">{step}</span>
      <div>
        <h2 id={id} className="text-xl font-bold text-primary sm:text-2xl">{title}</h2>
        {description ? <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p> : null}
      </div>
    </header>
  );
}
