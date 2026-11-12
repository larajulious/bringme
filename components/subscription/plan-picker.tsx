"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Sparkles } from "lucide-react";

import { Mascot } from "@/components/brand/mascot";
import { Feature, TAGLINE } from "@/components/marketing/pricing-cards";
import { StartTrialButton } from "@/components/subscription/start-trial-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { formatMoney, type CheckoutCurrency } from "@/lib/billing/currency";
import { passAction, type CurrentPass } from "@/lib/game-pass/ui";
import { cn } from "@/lib/utils";

export type PickerPlan = {
  code: string;
  name: string;
  maxPlayers: number;
  maxRounds: number;
  days: number;
  prices: Partial<Record<CheckoutCurrency, number>>;
  /** Per currency: checkout enabled, product mapped AND Polar charges exactly this price. */
  purchasable: Partial<Record<CheckoutCurrency, boolean>>;
};
export type TrialCard = { maxPlayers: number; maxRounds: number; days: number; state: "available" | "active" | "used" | "unavailable" };

/** The required one-line terms (shown verbatim). */
export const PASS_TERMS_SENTENCE = "One-time payment. Seven days of access. No automatic renewal.";
export const PASS_TERMS = ["One-time purchase", "7 days of access", "No automatic renewal"] as const;

export const ERRORS: Record<string, string> = {
  pricing_unavailable: "We couldn't confirm that exact price with our payment provider, so you were not sent to pay. Please try again later or choose the other currency.",
  pricing_out_of_sync: "This price is being updated, so it can't be bought right now. You have not been charged.",
  checkout_unavailable: "Checkout is not available right now. You have not been charged.",
  too_many_pending_orders: "You have several unfinished checkouts. Please wait a moment and try again.",
  checkout_in_progress: "Your checkout is still being prepared. Please try again in a few seconds.",
  unknown_plan: "That pass isn't available. Please refresh the page.",
  invalid_currency: "Please choose PHP or USD.",
  plan_not_purchasable: "This pass can't be bought online right now.",
  account_suspended: "Your account is paused. Please contact the BringMe! team.",
};

export function PlanPicker({
  plans, trial, current, initialCurrency, checkoutEnabled, testMode, highlight = null,
}: {
  plans: PickerPlan[]; trial: TrialCard | null; current: CurrentPass;
  initialCurrency: CheckoutCurrency; checkoutEnabled: boolean; testMode: boolean;
  /** Plan code the visitor picked on the public pricing section (?buy=…): outlined + its button focused. */
  highlight?: string | null;
}) {
  const { toast } = useToast();
  // Only currencies that at least one plan can actually be bought in are offered.
  const offered = (["PHP", "USD"] as const).filter((c) => plans.some((p) => p.prices[c] != null));
  const [currency, setCurrency] = useState<CheckoutCurrency>(offered.includes(initialCurrency) ? initialCurrency : (offered[0] ?? "USD"));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const other: CheckoutCurrency = currency === "PHP" ? "USD" : "PHP";
  const picked = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!highlight || !picked.current) return;
    picked.current.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    picked.current.focus({ preventScroll: true });
  }, [highlight]);

  const buy = async (plan: PickerPlan) => {
    setBusy(plan.code);
    setError(null);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planCode: plan.code, currency }),
      });
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        const msg = ERRORS[data.error ?? ""] ?? (res.status === 401 ? "Please sign in again to buy a pass." : "Couldn't start checkout. You have not been charged.");
        setError(msg);
        toast(msg, "error");
        setBusy(null);
        return;
      }
      window.location.assign(data.url);   // keep "Checkout initiated" while the browser leaves for Polar
    } catch {
      const msg = "You seem to be offline. You have not been charged.";
      setError(msg);
      toast(msg, "error");
      setBusy(null);
    }
  };

  const popular = plans.find((p) => p.code === "party")?.code ?? plans[Math.floor(plans.length / 2)]?.code;
  const anyBuyable = checkoutEnabled && plans.some((p) => p.purchasable[currency]);

  return (
    <div className="grid gap-5">
      <p className="rounded-2xl bg-brand-yellow/30 px-4 py-3 text-center font-display text-lg font-semibold text-brand-night">{PASS_TERMS_SENTENCE}</p>

      {offered.length > 1 ? (
        <fieldset className="flex flex-wrap items-center gap-3">
          <legend className="sr-only">Currency</legend>
          <span aria-hidden="true" className="text-sm font-semibold text-primary">Pay in</span>
          {offered.map((c) => (
            <label
              key={c}
              className={cn(
                "inline-flex cursor-pointer items-center gap-2 rounded-2xl border-2 px-4 py-2 font-display font-semibold transition-colors",
                "focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2",
                currency === c ? "border-primary bg-primary text-primary-foreground" : "border-primary/25 bg-card text-primary hover:border-primary/50",
              )}
            >
              <input type="radio" name="currency" value={c} checked={currency === c} onChange={() => setCurrency(c)} className="sr-only" />
              {c === "PHP" ? "₱ PHP" : "$ USD"}
            </label>
          ))}
          {testMode ? <Badge variant="coral">Test mode: no real charge</Badge> : null}
        </fieldset>
      ) : null}

      {busy ? (
        <p role="status" className="rounded-2xl border border-primary/30 bg-secondary px-4 py-3 text-sm font-semibold text-secondary-foreground">
          Checkout initiated: taking you to our secure payment page…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-2xl border border-brand-coral/40 bg-brand-coral/10 px-4 py-3 text-sm font-semibold text-foreground">{error}</p>
      ) : null}

      <ul className="grid items-stretch gap-5 pt-3 sm:grid-cols-2 lg:grid-cols-4">
        {trial ? (
          <li>
            <article className="flex h-full flex-col rounded-3xl border-2 border-dashed border-brand-yellow bg-card p-6 shadow-card">
              <h3 className="flex items-center gap-2 font-display text-xl font-bold text-primary"><Sparkles aria-hidden="true" className="size-5 text-brand-coral" /> Free Trial</h3>
              <p className="mt-1 text-sm text-muted-foreground">Try it with your closest teammates</p>
              <p className="mt-5 font-display text-5xl font-bold text-primary">Free</p>
              <p className="text-sm text-muted-foreground">No card needed</p>
              <ul className="my-6 grid gap-2.5 text-sm">
                <Feature icon><strong>Up to {trial.maxPlayers} players</strong> per game</Feature>
                <Feature><strong>Up to {trial.maxRounds} rounds</strong> per game</Feature>
                <Feature>{trial.days} days of hosting</Feature>
                <Feature>Once per account</Feature>
              </ul>
              <div className="mt-auto">
                {trial.state === "available" ? <StartTrialButton /> : (
                  <p className="rounded-2xl bg-secondary px-4 py-2 text-center text-sm font-semibold text-secondary-foreground">
                    {trial.state === "active" ? "Your free trial is active" : trial.state === "used" ? "Free trial already used" : "Not available for this account"}
                  </p>
                )}
              </div>
            </article>
          </li>
        ) : null}

        {plans.map((p) => {
          const price = p.prices[currency];
          const alt = p.prices[other];
          const canBuy = checkoutEnabled && price != null && p.purchasable[currency] === true;
          const action = passAction(current, p.maxPlayers);
          const otherOk = checkoutEnabled && p.purchasable[other] === true;
          const hot = p.code === popular;
          return (
            <li key={p.code}>
              <article
                className={cn(
                  "relative flex h-full flex-col rounded-3xl p-6 shadow-card",
                  hot ? "bg-gradient-to-b from-primary to-brand-night text-white ring-4 ring-brand-yellow lg:-my-3 lg:py-9" : "border bg-card",
                  highlight === p.code && !hot && "ring-4 ring-brand-yellow",
                )}
              >
                {hot ? (
                  <>
                    <Mascot mood="cheer" className="absolute -top-9 right-5 w-16" />
                    <Badge variant="yellow" className="absolute -top-3 left-6">Most popular</Badge>
                  </>
                ) : null}
                {highlight === p.code ? <Badge variant="coral" className="absolute -top-3 right-6">Your pick</Badge> : null}
                <h3 className={cn("font-display text-xl font-bold", hot ? "text-brand-yellow" : "text-primary")}>{p.name}</h3>
                <p className={cn("mt-1 text-sm", hot ? "text-white/80" : "text-muted-foreground")}>{TAGLINE[p.code] ?? `Games of up to ${p.maxPlayers} players`}</p>
                <p key={currency} className={cn("mt-5 animate-pop-in font-display text-5xl font-bold", hot ? "text-white" : "text-primary")}>
                  {price != null ? formatMoney(price, currency) : "—"}
                </p>
                <p className={cn("text-sm", hot ? "text-white/80" : "text-muted-foreground")}>
                  per {p.days}-day pass{alt != null ? <> · or {formatMoney(alt, other)} {other}</> : null}
                </p>
                <ul className="my-6 grid gap-2.5 text-sm">
                  <Feature icon hot={hot}><strong>Up to {p.maxPlayers} players</strong> per game</Feature>
                  <Feature hot={hot}><strong>Up to {p.maxRounds} rounds</strong> per game</Feature>
                  <Feature hot={hot}>One-time payment</Feature>
                  <Feature hot={hot}>{p.days} days of hosting</Feature>
                  <Feature hot={hot}>No automatic renewal</Feature>
                </ul>
                <div className="mt-auto grid gap-1.5">
                  <Button
                    ref={highlight === p.code ? picked : undefined}
                    variant={hot ? "default" : "outline"}
                    className="w-full"
                    disabled={!canBuy || busy !== null}
                    onClick={() => buy(p)}
                    aria-describedby={`note-${p.code} pass-terms`}
                    aria-busy={busy === p.code}
                  >
                    {canBuy && price != null
                      ? busy === p.code ? "Opening secure checkout…" : `${action.label} · ${formatMoney(price, currency)} ${currency}`
                      : action.label}
                  </Button>
                  <p id={`note-${p.code}`} className={cn("text-xs", hot ? "text-white/80" : "text-muted-foreground")}>
                    {canBuy ? action.note : checkoutEnabled && otherOk ? `Not available in ${currency} right now. Switch to ${other}.` : "Online checkout for this pass opens soon."}
                  </p>
                </div>
              </article>
            </li>
          );
        })}
      </ul>

      <div id="pass-terms" className="space-y-2 text-sm text-muted-foreground">
        <ul className="flex flex-wrap gap-2" aria-label="Purchase terms">
          {PASS_TERMS.map((t) => (
            <li key={t} className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-3 py-1 font-semibold text-secondary-foreground">
              <Check aria-hidden="true" className="size-4" /> {t}
            </li>
          ))}
        </ul>
        {anyBuyable ? (
          <p>You&apos;ll be charged in {currency}. If our payment provider can&apos;t confirm exactly this price, you won&apos;t be sent to pay.</p>
        ) : (
          <p>Online checkout opens soon. Until then, contact the BringMe! team to get a pass.</p>
        )}
      </div>
    </div>
  );
}
