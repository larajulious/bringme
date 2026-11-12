import type { Metadata } from "next";

import { PageHeading } from "@/components/layout/dashboard-shell";
import { CheckoutStatus } from "@/components/subscription/checkout-status";
import { requireSubscriberPage } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Checkout" };

/** Polar's success URL lands here with ?checkout_id=… (a lookup key, never proof of payment). */
export default async function CheckoutReturnPage({ searchParams }: { searchParams: Promise<{ checkout_id?: string }> }) {
  await requireSubscriberPage();
  const { checkout_id } = await searchParams;
  const id = typeof checkout_id === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(checkout_id) ? checkout_id : null;
  return (
    <>
      <PageHeading title="Your Game Pass purchase" description="One-time purchase · 7 days of access · No automatic renewal" />
      {id ? <CheckoutStatus checkoutId={id} /> : <p className="text-muted-foreground">This link is missing its checkout reference.</p>}
    </>
  );
}
