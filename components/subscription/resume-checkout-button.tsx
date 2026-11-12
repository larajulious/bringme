"use client";

import { useState } from "react";

import { ERRORS } from "@/components/subscription/plan-picker";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

/** Re-opens an unfinished checkout. The server hands back the SAME Polar checkout for a pending order (no duplicate). */
export function ResumeCheckoutButton({ planCode, currency }: { planCode: string; currency: string }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const go = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ planCode, currency }),
      });
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (res.ok && data.url) { window.location.assign(data.url); return; }
      toast(ERRORS[data.error ?? ""] ?? (res.status === 401 ? "Please sign in again." : `Couldn't reopen checkout (${data.error ?? res.status}). You have not been charged.`), "error");
    } catch {
      toast("You seem to be offline. You have not been charged.", "error");
    }
    setBusy(false);
  };

  return (
    <Button size="sm" className="mt-2" onClick={go} disabled={busy} aria-busy={busy}>
      {busy ? "Opening…" : "Continue checkout"}
    </Button>
  );
}
