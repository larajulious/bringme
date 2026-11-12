"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { describeSync, type SyncResponse } from "@/lib/billing/sync-messages";
import { parseMoneyInput } from "@/lib/game-pass/ui";

async function post(url: string, body: object): Promise<SyncResponse> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await res.json().catch(() => ({ error: "update_failed" }))) as SyncResponse;
  } catch {
    return { error: "network" };
  }
}

export function PlanSyncEditor({ plan, php, usd }: { plan: { id: string; name: string; max_players_per_game: number; duration_seconds: number }; php: number | null; usd: number | null }) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [v, setV] = useState({ name: plan.name, players: String(plan.max_players_per_game), php: php == null ? "" : (php / 100).toFixed(2), usd: usd == null ? "" : (usd / 100).toFixed(2) });

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const phpMinor = parseMoneyInput(v.php);
    const usdMinor = parseMoneyInput(v.usd);
    if (phpMinor === null || usdMinor === null) return setError("Enter prices like 99 or 1.99 (at most 2 decimals).");
    setBusy(true);
    const r = await post(`/api/admin/plans/${plan.id}/sync`, { name: v.name, maxPlayers: Number(v.players), phpMinor, usdMinor });
    setBusy(false);
    const d = describeSync(r);
    if (!d.ok) { setError(d.text); router.refresh(); return; }
    toast(d.text, "success");
    setOpen(false);
    router.refresh();
  };

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>Edit &amp; sync<span className="sr-only"> {plan.name}</span></Button>
      <Modal open={open} onClose={() => setOpen(false)} title={`Edit ${plan.name}`} className="max-w-lg"
        description="Changes are applied to Polar first, verified, then saved in BringMe!. PHP and USD are independent prices (no conversion). Passes already sold keep their player limit and price.">
        <form onSubmit={save} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor={`${plan.id}-n`}>Plan name</Label>
            <Input id={`${plan.id}-n`} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} minLength={3} maxLength={64} required />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-2">
              <Label htmlFor={`${plan.id}-php`}>PHP price (₱)</Label>
              <Input id={`${plan.id}-php`} inputMode="decimal" value={v.php} onChange={(e) => setV({ ...v, php: e.target.value })} required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`${plan.id}-usd`}>USD price ($)</Label>
              <Input id={`${plan.id}-usd`} inputMode="decimal" value={v.usd} onChange={(e) => setV({ ...v, usd: e.target.value })} required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`${plan.id}-pl`}>Maximum players</Label>
              <Input id={`${plan.id}-pl`} type="number" min={2} max={500} value={v.players} onChange={(e) => setV({ ...v, players: e.target.value })} required />
            </div>
          </div>
          <p className="text-sm text-muted-foreground">Duration: <strong>{Math.round(plan.duration_seconds / 86_400)} days</strong> (fixed for every Game Pass). One-time purchase, no automatic renewal.</p>
          {error ? <p role="alert" className="rounded-2xl bg-destructive/10 px-4 py-3 text-sm font-semibold text-destructive">{error}</p> : null}
          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? "Syncing with Polar…" : "Save & sync"}</Button>
          </div>
        </form>
      </Modal>
    </>
  );
}

/** Retry a failed / half-done sync, or re-check Polar. */
export function SyncActions({ planId, retryJobId, canCheck }: { planId: string; retryJobId: string | null; canCheck: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const run = async (body: object) => {
    setBusy(true);
    const r = await post(`/api/admin/plans/${planId}/sync`, body);
    setBusy(false);
    const status = "status" in r ? String(r.status) : "";
    const d = ["in_sync", "out_of_sync", "sync_in_progress", "stale"].includes(status)
      ? { ok: status === "in_sync", text: status === "in_sync" ? "Polar matches BringMe!." : `Polar check: ${status.replaceAll("_", " ")}.` }
      : describeSync(r);
    toast(d.text, d.ok ? "success" : "error");
    router.refresh();
  };
  return (
    <div className="flex flex-wrap gap-1">
      {retryJobId ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => run({ action: "retry", jobId: retryJobId })}>Retry Sync</Button> : null}
      {canCheck ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => run({ action: "check" })}>Check Polar</Button> : null}
    </div>
  );
}
