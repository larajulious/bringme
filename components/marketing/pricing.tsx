import { headers } from "next/headers";

import { PricingCards } from "@/components/marketing/pricing-cards";
import { Reveal } from "@/components/marketing/reveal";
import { publicBillingState } from "@/lib/billing/config";
import { defaultCurrency } from "@/lib/billing/currency";
import { getBillingConfig } from "@/lib/billing/polar";
import { getPublicCatalog } from "@/lib/billing/public-plans";

const FAQ = [
  { q: "Does it renew automatically?", a: "Never. A Game Pass is a one-time payment for 7 days of hosting. When it ends, it simply ends." },
  { q: "Do players need to pay or sign up?", a: "No. Only the Game Master needs a pass. Players scan the QR code and join with a nickname." },
  { q: "What if our event runs longer?", a: "Buy the same pass again to add 7 more days, or a bigger one if more people show up." },
];

export function PricingSection({ children }: { children: React.ReactNode }) {
  // phones (below md, matching the story engine): extra room at the bottom for Snappy peeking over the footer
  return (
    <section id="pricing" aria-labelledby="pricing-heading" className="flex min-h-svh scroll-mt-6 flex-col justify-center px-5 pb-[10rem] pt-[clamp(2.5rem,6svh,5rem)] md:pb-[clamp(2.5rem,6svh,5rem)]">
      <Reveal className="relative isolate mx-auto w-full max-w-6xl">
        <h2 id="pricing-heading" className="mb-3 text-center text-3xl font-bold text-primary sm:text-4xl lg:text-5xl">Simple pricing, per event</h2>
        <p className="mx-auto mb-[clamp(1.25rem,4svh,2.5rem)] max-w-xl text-center text-muted-foreground lg:text-lg">Pay once, host for 7 days. No subscriptions to forget about — Snappy hates those too.</p>
        {children}
        <dl className="mx-auto mt-[clamp(1.5rem,5svh,3rem)] grid max-w-4xl gap-4 md:grid-cols-3">
          {FAQ.map((f) => (
            <div key={f.q} className="rounded-3xl bg-secondary p-5">
              <dt className="font-display font-bold text-primary">{f.q}</dt>
              <dd className="mt-1.5 text-sm text-muted-foreground">{f.a}</dd>
            </div>
          ))}
        </dl>
      </Reveal>
    </section>
  );
}

/** Live part (streams in): visitor's default currency from request headers + the cached public catalogue. */
export async function Pricing() {
  const h = await headers();
  const initialCurrency = defaultCurrency({ country: h.get("x-vercel-ip-country") ?? h.get("cf-ipcountry"), acceptLanguage: h.get("accept-language") });
  const catalog = await getPublicCatalog();
  if (!catalog.trial && catalog.plans.length === 0) {
    return <p className="text-center text-muted-foreground">Pricing is loading slower than Snappy on a Monday. Please refresh in a moment.</p>;
  }
  return <PricingCards catalog={catalog} initialCurrency={initialCurrency} checkoutEnabled={publicBillingState(getBillingConfig()).checkout} />;
}

/** Same footprint as the cards, so nothing jumps when prices arrive. */
export function PricingSkeleton() {
  return (
    <div aria-hidden="true" className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
      <div className="mx-auto mb-10 h-11 w-52 rounded-2xl bg-secondary sm:col-span-2 lg:col-span-4" />
      {[0, 1, 2, 3].map((i) => <div key={i} className="h-[26rem] animate-pulse rounded-3xl bg-secondary motion-reduce:animate-none" />)}
    </div>
  );
}
