"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Clock, SearchX, ShieldAlert, XCircle } from "lucide-react";

import { WaitingDots } from "@/components/game/waiting-dots";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney, parseCurrency } from "@/lib/billing/currency";

type State = "loading" | "confirmed" | "pending_verification" | "not_completed" | "unsuccessful" | "expired" | "canceled" | "review" | "not_found" | "error";
type Status = { state: State; plan: string | null; currency: string | null; amountMinor: number | null; environment: string | null; resumeUrl: string | null };

const WAITING: State[] = ["loading", "pending_verification", "not_completed"];
const PLANS = "/dashboard/subscription#plans";

/**
 * Return page after Polar. Shows only what the SERVER says about this checkout; reaching
 * this page proves nothing (a pass appears only after the verified payment webhook).
 */
export function CheckoutStatus({ checkoutId }: { checkoutId: string }) {
  const [s, setS] = useState<Status>({ state: "loading", plan: null, currency: null, amountMinor: null, environment: null, resumeUrl: null });
  const [slow, setSlow] = useState(false);
  const started = useRef(Date.now());

  useEffect(() => {
    let stop = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const res = await fetch(`/api/billing/checkout/status?checkout_id=${encodeURIComponent(checkoutId)}`, { cache: "no-store" });
        const data = (await res.json().catch(() => null)) as Status | null;
        if (!stop) setS(res.ok && data ? data : (prev) => ({ ...prev, state: prev.state === "loading" ? "error" : prev.state }));
        if (stop || (res.ok && data && !WAITING.includes(data.state))) return;
      } catch {
        /* offline: keep waiting */
      }
      const elapsed = Date.now() - started.current;
      if (elapsed > 90_000) setSlow(true);
      if (!stop) timer = window.setTimeout(poll, elapsed > 90_000 ? 10_000 : 3_000);
    };
    poll();
    return () => { stop = true; window.clearTimeout(timer); };
  }, [checkoutId]);

  const cur = parseCurrency(s.currency);
  const what = s.plan && cur && s.amountMinor != null ? `${s.plan} Game Pass · ${formatMoney(s.amountMinor, cur)} ${cur}` : s.plan ? `${s.plan} Game Pass` : null;

  const view: Record<Exclude<State, "loading">, { icon: React.ReactNode; title: string; text: string; action?: React.ReactNode }> = {
    pending_verification: {
      icon: <Clock aria-hidden="true" className="size-7 text-primary" />,
      title: "Payment received — confirming…",
      text: slow
        ? "Still confirming with our payment provider. You can leave this page: your Game Pass will appear on your dashboard as soon as it's confirmed. You won't be charged twice."
        : "Your Game Pass appears as soon as the payment is confirmed. This usually takes a few seconds.",
      action: <Button asChild variant="outline"><Link href="/dashboard">Back to dashboard</Link></Button>,
    },
    not_completed: {
      icon: <Clock aria-hidden="true" className="size-7 text-primary" />,
      title: "This checkout isn't finished yet",
      text: "Nothing has been charged. You can continue to the payment page or choose another pass.",
      action: s.resumeUrl
        ? <Button asChild><a href={s.resumeUrl}>Continue to payment</a></Button>
        : <Button asChild><Link href={PLANS}>Choose a Game Pass</Link></Button>,
    },
    confirmed: {
      icon: <CheckCircle2 aria-hidden="true" className="size-7 text-brand-success" />,
      title: "Payment successful: Pass activated!",
      text: "Your payment was confirmed and your 7-Day Game Pass is active. Time to host a game.",
      action: <Button asChild size="lg"><Link href="/dashboard">Go to dashboard</Link></Button>,
    },
    unsuccessful: {
      icon: <XCircle aria-hidden="true" className="size-7 text-brand-coral" />,
      title: "Payment unsuccessful",
      text: "The payment didn't go through, so you were not charged. You can try again with another card or payment method.",
      action: <Button asChild><Link href={PLANS}>Purchase Again</Link></Button>,
    },
    expired: {
      icon: <XCircle aria-hidden="true" className="size-7 text-brand-coral" />,
      title: "This checkout expired",
      text: "No payment was made. Start a new checkout whenever you're ready.",
      action: <Button asChild><Link href={PLANS}>Purchase Again</Link></Button>,
    },
    canceled: {
      icon: <XCircle aria-hidden="true" className="size-7 text-brand-coral" />,
      title: "Checkout cancelled",
      text: "No Game Pass was added from this checkout.",
      action: <Button asChild><Link href={PLANS}>Choose a Game Pass</Link></Button>,
    },
    review: {
      icon: <ShieldAlert aria-hidden="true" className="size-7 text-brand-coral" />,
      title: "We're checking your payment",
      text: "Something about this payment needs a quick manual check. Our team will sort it out; you won't be charged twice.",
      action: <Button asChild variant="outline"><Link href="/dashboard">Back to dashboard</Link></Button>,
    },
    not_found: {
      icon: <SearchX aria-hidden="true" className="size-7 text-muted-foreground" />,
      title: "We couldn't find this checkout",
      text: "It may belong to another account. Nothing was added to yours.",
      action: <Button asChild><Link href={PLANS}>Choose a Game Pass</Link></Button>,
    },
    error: {
      icon: <ShieldAlert aria-hidden="true" className="size-7 text-brand-coral" />,
      title: "We couldn't check this payment right now",
      text: "Please refresh in a moment. If you paid, your Game Pass will still appear once it's confirmed.",
    },
  };

  if (s.state === "loading") {
    return (
      <Card className="max-w-xl" aria-busy="true">
        <CardContent className="flex items-center gap-4 pt-6"><WaitingDots className="bg-primary" /><span>Checking your payment…</span></CardContent>
      </Card>
    );
  }
  const v = view[s.state];
  return (
    <Card className="max-w-xl" aria-live="polite">
      <CardHeader>
        <CardTitle className="flex items-center gap-3">{v.icon} {v.title}</CardTitle>
        {what ? <p className="text-sm text-muted-foreground">{what}{s.environment === "sandbox" ? " · test mode" : ""}</p> : null}
      </CardHeader>
      <CardContent className="space-y-5">
        {s.state === "pending_verification" ? <WaitingDots className="bg-primary" /> : null}
        <p className="text-foreground">{v.text}</p>
        {v.action ? <div>{v.action}</div> : null}
      </CardContent>
    </Card>
  );
}
