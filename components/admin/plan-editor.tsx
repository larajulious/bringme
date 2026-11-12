"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { adminErrorMessage, adminFetch } from "@/lib/admin/client";
import type { SubscriptionPlan } from "@/lib/supabase/database.types";

/** Create (no `plan`) or edit a plan: name, capacity and limits. Prices are edited per currency in PriceEditor. */
export function PlanEditor({ plan, limitsOnly = false }: { plan?: SubscriptionPlan; limitsOnly?: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [code, setCode] = useState(plan?.code ?? "");
  const [name, setName] = useState(plan?.name ?? "");
  const [description, setDescription] = useState(plan?.description ?? "");
  const [maxPlayers, setMaxPlayers] = useState(String(plan?.max_players_per_game ?? 20));
  const [maxGames, setMaxGames] = useState(plan?.max_games_per_period == null ? "" : String(plan.max_games_per_period));
  const [maxActive, setMaxActive] = useState(String(plan?.max_active_games ?? 1));
  const [maxRounds, setMaxRounds] = useState(String(plan?.max_rounds_per_game ?? 10));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const body = {
      ...(plan ? {} : { code: code.trim() }),
      ...(limitsOnly ? {} : { name, max_players_per_game: Number(maxPlayers) }),
      description: description.trim() || null,
      max_games_per_period: maxGames.trim() === "" ? null : Number(maxGames),
      max_active_games: Number(maxActive),
      max_rounds_per_game: Number(maxRounds),
    };
    setBusy(true);
    const err = await adminFetch(plan ? `/api/admin/plans/${plan.id}` : "/api/admin/plans", plan ? "PATCH" : "POST", body);
    setBusy(false);
    if (err) return setError(adminErrorMessage(err));
    toast(plan ? "Plan updated" : "Plan created", "success");
    setOpen(false);
    router.refresh();
  };

  const id = plan?.id ?? "new";
  return (
    <>
      <Button size={plan ? "sm" : "default"} variant={plan ? "outline" : "default"} onClick={() => setOpen(true)}>
        {plan ? (limitsOnly ? "Limits" : "Edit") : "New plan"}
        {plan ? <span className="sr-only"> {plan.name}</span> : null}
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title={plan ? `Edit ${plan.name}` : "New plan"}
        description="Capacity and limits apply to NEW passes; passes already sold keep their player limit. Prices are set separately per currency." className="max-w-lg">
        <form onSubmit={submit} className="grid gap-4">
          {!plan ? (
            <div className="grid gap-2">
              <Label htmlFor={`${id}-code`}>Code</Label>
              <Input id={`${id}-code`} value={code} onChange={(e) => setCode(e.target.value.toLowerCase())} required pattern="[a-z0-9_\-]{2,40}" placeholder="e.g. gold" />
              <p className="text-xs text-muted-foreground">Lowercase letters, numbers, - or _. Can&apos;t be changed later.</p>
            </div>
          ) : null}
          {!limitsOnly ? <div className="grid gap-2">
            <Label htmlFor={`${id}-name`}>Name</Label>
            <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
          </div> : null}
          <div className="grid gap-2">
            <Label htmlFor={`${id}-desc`}>Description</Label>
            <Input id={`${id}-desc`} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {!limitsOnly ? <div className="grid gap-2">
              <Label htmlFor={`${id}-players`}>Max players per game</Label>
              <Input id={`${id}-players`} type="number" min={2} max={500} value={maxPlayers} onChange={(e) => setMaxPlayers(e.target.value)} required />
            </div> : null}
            <div className="grid gap-2">
              <Label htmlFor={`${id}-games`}>Games per period</Label>
              <Input id={`${id}-games`} type="number" min={1} max={10000} value={maxGames} onChange={(e) => setMaxGames(e.target.value)} placeholder="Unlimited" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`${id}-active`}>Games open at once</Label>
              <Input id={`${id}-active`} type="number" min={1} max={100} value={maxActive} onChange={(e) => setMaxActive(e.target.value)} required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`${id}-rounds`}>Rounds per game</Label>
              <Input id={`${id}-rounds`} type="number" min={1} max={200} value={maxRounds} onChange={(e) => setMaxRounds(e.target.value)} required />
            </div>
          </div>
          {error ? <p role="alert" className="rounded-2xl bg-destructive/10 px-4 py-3 text-sm font-semibold text-destructive">{error}</p> : null}
          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save plan"}</Button>
          </div>
        </form>
      </Modal>
    </>
  );
}

/** Activate / deactivate. Deactivating hides the plan from new assignments; current subscribers keep it. */
export function PlanStatusToggle({ plan }: { plan: SubscriptionPlan }) {
  const router = useRouter();
  const { toast } = useToast();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const apply = async (is_active: boolean) => {
    setBusy(true);
    const err = await adminFetch(`/api/admin/plans/${plan.id}`, "PATCH", { is_active });
    setBusy(false);
    setConfirm(false);
    if (err) return toast(adminErrorMessage(err), "error");
    toast(is_active ? "Plan activated" : "Plan deactivated", "success");
    router.refresh();
  };

  return (
    <>
      {plan.is_active ? (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm(true)}>
          Deactivate<span className="sr-only"> {plan.name}</span>
        </Button>
      ) : (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => apply(true)}>
          Activate<span className="sr-only"> {plan.name}</span>
        </Button>
      )}
      <ConfirmDialog open={confirm} busy={busy} title={`Deactivate ${plan.name}?`} confirmLabel="Deactivate"
        description="It can't be assigned to anyone new. Subscribers already on this plan keep it until it ends."
        onClose={() => setConfirm(false)} onConfirm={() => apply(false)} />
    </>
  );
}
