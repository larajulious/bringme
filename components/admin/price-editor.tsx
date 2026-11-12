"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { adminErrorMessage, adminFetch } from "@/lib/admin/client";
import { parseMoneyInput } from "@/lib/game-pass/ui";

const toInput = (minor: number | null | undefined) => (minor == null ? "" : (minor / 100).toFixed(2));

/**
 * Edit a plan's PHP and USD prices (exact, independent amounts; never converted).
 * Saving changes BringMe!'s price only: Polar is not modified, so checkout for a changed price
 * stays blocked ("Needs sync") until the same amount is set on the Polar product.
 */
export function PriceEditor({ planId, planName, php, usd, isTrial }: { planId: string; planName: string; php: number | null; usd: number | null; isTrial: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [vals, setVals] = useState({ PHP: toInput(php), USD: toInput(usd) });

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const changes: { currency: "PHP" | "USD"; amountMinor: number }[] = [];
    for (const [currency, original] of [["PHP", php], ["USD", usd]] as const) {
      const minor = parseMoneyInput(vals[currency]);
      if (minor === null) return setError(`Enter the ${currency} price like 99 or 1.99 (at most 2 decimals).`);
      if (minor !== original) changes.push({ currency, amountMinor: minor });
    }
    if (changes.length === 0) return setOpen(false);
    setBusy(true);
    for (const c of changes) {
      const err = await adminFetch(`/api/admin/plans/${planId}/prices`, "PUT", c);
      if (err) { setBusy(false); return setError(adminErrorMessage(err)); }
    }
    setBusy(false);
    toast(`${planName} prices saved. Update the Polar product to match before it can be bought.`, "success");
    setOpen(false);
    router.refresh();
  };

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} disabled={isTrial}>
        Prices<span className="sr-only"> for {planName}</span>
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title={`${planName} prices`} className="max-w-md"
        description="PHP and USD are set independently (no conversion). This does NOT change Polar: until the Polar product charges the same amount, this price can't be bought.">
        <form onSubmit={save} className="grid gap-4">
          {(["PHP", "USD"] as const).map((c) => (
            <div key={c} className="grid gap-2">
              <Label htmlFor={`${planId}-${c}`}>{c === "PHP" ? "PHP (₱)" : "USD ($)"}</Label>
              <Input id={`${planId}-${c}`} inputMode="decimal" value={vals[c]} onChange={(e) => setVals((v) => ({ ...v, [c]: e.target.value }))} required />
            </div>
          ))}
          {error ? <p role="alert" className="rounded-2xl bg-destructive/10 px-4 py-3 text-sm font-semibold text-destructive">{error}</p> : null}
          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save prices"}</Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
