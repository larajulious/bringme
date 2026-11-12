"use client";

import Link from "next/link";
import { Check, Sparkles, Users } from "lucide-react";
import { useState } from "react";

import { Mascot } from "@/components/brand/mascot";
import { Reveal } from "@/components/marketing/reveal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatMoney, type CheckoutCurrency } from "@/lib/billing/currency";
import type { PublicCatalog } from "@/lib/billing/public-plans";
import { cn } from "@/lib/utils";

/**
 * Plan card row: centered and wrapping, so 2 or 3 cards (a plan or the trial switched off) sit in the middle
 * instead of hugging the left of a fixed 4-column grid. Widths match that grid (gap-5 = 1.25rem).
 */
export const PLAN_ROW = "flex flex-wrap items-stretch justify-center gap-5";
export const PLAN_CELL = "w-full sm:w-[calc((100%_-_1.25rem)/2)] lg:w-[calc((100%_-_3.75rem)/4)]";

export const TAGLINE: Record<string, string> = {
  starter: "Team huddles and small teams",
  party: "Department parties and team building",
  pro: "Town halls and company-wide events",
};
const TERMS = ["One-time payment", "7 days of hosting", "No automatic renewal"];

/**
 * Public pricing cards. Buying needs an account, so paid CTAs go to the Game Pass page with the pick preselected
 * (?buy=&currency=); signed-out visitors pass through the email-code sign-in and land back on their pick.
 */
export function PricingCards({ catalog, initialCurrency, checkoutEnabled }: { catalog: PublicCatalog; initialCurrency: CheckoutCurrency; checkoutEnabled: boolean }) {
  const offered = (["PHP", "USD"] as const).filter((c) => catalog.plans.some((p) => p.prices[c] != null));
  const [currency, setCurrency] = useState<CheckoutCurrency>(offered.includes(initialCurrency) ? initialCurrency : (offered[0] ?? "USD"));
  const popular = catalog.plans.find((p) => p.code === "party")?.code ?? catalog.plans[Math.floor(catalog.plans.length / 2)]?.code;

  return (
    <Reveal>
      {offered.length > 1 ? (
        <div role="radiogroup" aria-label="Currency" className="reveal-item mx-auto mb-10 flex w-fit gap-1 rounded-2xl bg-secondary p-1" style={{ "--i": 1 } as React.CSSProperties}>
          {offered.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={currency === c}
              onClick={() => setCurrency(c)}
              className={cn(
                "rounded-xl px-5 py-2 font-display font-semibold transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring",
                currency === c ? "bg-primary text-primary-foreground shadow-pop-purple" : "text-primary hover:bg-primary/10",
              )}
            >
              {c === "PHP" ? "₱ PHP" : "$ USD"}
            </button>
          ))}
        </div>
      ) : null}

      <ul className={PLAN_ROW}>
        {catalog.trial ? (
          <li className={cn("reveal-item", PLAN_CELL)} style={{ "--i": 2 } as React.CSSProperties}>
            <article className="flex h-full flex-col rounded-3xl border-2 border-dashed border-brand-yellow bg-card p-6 shadow-card transition-transform duration-300 motion-safe:hover:-translate-y-1.5">
              <h3 className="flex items-center gap-2 font-display text-xl font-bold text-primary"><Sparkles aria-hidden="true" className="size-5 text-brand-coral" /> Free Trial</h3>
              <p className="mt-1 text-sm text-muted-foreground">Try it with your closest teammates</p>
              <p className="mt-5 font-display text-5xl font-bold text-primary">Free</p>
              <p className="text-sm text-muted-foreground">No card needed</p>
              <ul className="my-6 grid gap-2.5 text-sm">
                <Feature icon><strong>Up to {catalog.trial.maxPlayers} players</strong> per game</Feature>
                <Feature><strong>Up to {catalog.trial.maxRounds} rounds</strong> per game</Feature>
                <Feature>{catalog.trial.days} days of hosting</Feature>
                <Feature>Starts automatically when you sign up</Feature>
              </ul>
              <Button asChild variant="secondary" className="mt-auto w-full">
                <Link href="/auth/login?next=/dashboard">Start free</Link>
              </Button>
            </article>
          </li>
        ) : null}

        {catalog.plans.map((p, i) => {
          const price = p.prices[currency];
          const hot = p.code === popular;
          return (
            <li key={p.code} className={cn("reveal-item", PLAN_CELL)} style={{ "--i": i + 3 } as React.CSSProperties}>
              <article
                className={cn(
                  "relative flex h-full flex-col rounded-3xl p-6 shadow-card transition-transform duration-300 motion-safe:hover:-translate-y-1.5",
                  hot ? "bg-gradient-to-b from-primary to-brand-night text-white ring-4 ring-brand-yellow lg:-my-3 lg:py-9" : "border bg-card",
                )}
              >
                {hot ? (
                  <>
                    <Mascot mood="cheer" className="absolute -top-9 right-5 w-16" />
                    <Badge variant="yellow" className="absolute -top-3 left-6">Most popular</Badge>
                  </>
                ) : null}
                <h3 className={cn("font-display text-xl font-bold", hot ? "text-brand-yellow" : "text-primary")}>{p.name}</h3>
                <p className={cn("mt-1 text-sm", hot ? "text-white/80" : "text-muted-foreground")}>{TAGLINE[p.code] ?? `Games of up to ${p.maxPlayers} players`}</p>
                <p key={currency} className={cn("mt-5 animate-pop-in font-display text-5xl font-bold", hot ? "text-white" : "text-primary")}>
                  {price != null ? formatMoney(price, currency) : "—"}
                </p>
                <p className={cn("text-sm", hot ? "text-white/80" : "text-muted-foreground")}>
                  per 7-day pass
                </p>
                <ul className="my-6 grid gap-2.5 text-sm">
                  <Feature icon hot={hot}><strong>Up to {p.maxPlayers} players</strong> per game</Feature>
                  <Feature hot={hot}><strong>Up to {p.maxRounds} rounds</strong> per game</Feature>
                  {TERMS.map((t) => <Feature key={t} hot={hot}>{t}</Feature>)}
                </ul>
                {checkoutEnabled && price != null ? (
                  <Button asChild variant={hot ? "default" : "outline"} className={cn("mt-auto w-full", hot && "bg-brand-yellow text-brand-night shadow-pop hover:bg-brand-yellow/90")}>
                    <Link href={`/dashboard/subscription?buy=${encodeURIComponent(p.code)}&currency=${currency}`}>Get {p.name}<span className="sr-only"> pass for {formatMoney(price, currency)}</span></Link>
                  </Button>
                ) : (
                  <Button disabled variant="outline" className="mt-auto w-full">Opens soon</Button>
                )}
              </article>
            </li>
          );
        })}
      </ul>
    </Reveal>
  );
}

export function Feature({ children, icon = false, hot = false }: { children: React.ReactNode; icon?: boolean; hot?: boolean }) {
  const Icon = icon ? Users : Check;
  return (
    <li className="flex items-start gap-2">
      <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", hot ? "text-brand-yellow" : "text-primary")} />
      <span>{children}</span>
    </li>
  );
}
