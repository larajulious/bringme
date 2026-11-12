"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { adminErrorMessage, adminFetch } from "@/lib/admin/client";
import type { AccessState } from "@/lib/supabase/database.types";

type Pending = null | "suspend" | "deactivate" | "reactivate";

/** Admin-only controls. Every call is re-authorized and re-validated on the server. */
export function SubscriberActions({
  userId,
  label,
  state,
  currentPlanCode,
  currentEnd,
  plans,
}: {
  userId: string;
  label: string;
  state: AccessState;
  currentPlanCode: string | null;
  currentEnd: string | null;
  plans: { code: string; name: string }[];
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Pending>(null);
  const [plan, setPlan] = useState(currentPlanCode && plans.some((p) => p.code === currentPlanCode) ? currentPlanCode : (plans[0]?.code ?? ""));
  const [days, setDays] = useState(7);
  const [expiry, setExpiry] = useState(currentEnd ? currentEnd.slice(0, 10) : "");
  const [extendDays, setExtendDays] = useState(7);
  const [extendReason, setExtendReason] = useState("");

  const run = async (path: "subscription" | "account", body: object, ok: string) => {
    setBusy(true);
    const err = await adminFetch(`/api/admin/users/${userId}/${path}`, "POST", body);
    setBusy(false);
    setConfirm(null);
    if (err) return toast(adminErrorMessage(err), "error");
    toast(ok, "success");
    router.refresh();
  };

  const deactivated = state === "deactivated";
  const hasSubscription = state !== "pending" && state !== "deactivated" ? true : currentPlanCode !== null;
  const noPlans = plans.length === 0;

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Grant a Game Pass</CardTitle>
          <CardDescription>Starts now if nothing is running; otherwise it is queued (a higher tier starts now and the rest resumes later). No payment is processed.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="act-plan">Plan</Label>
            <Select id="act-plan" value={plan} onChange={(e) => setPlan(e.target.value)} disabled={busy || deactivated || noPlans}>
              {plans.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="act-days">Days of access</Label>
            <Input id="act-days" type="number" min={1} max={366} value={days} onChange={(e) => setDays(Number(e.target.value))} disabled={busy || deactivated} />
          </div>
          <Button disabled={busy || deactivated || noPlans} onClick={() => run("subscription", { action: "activate", planCode: plan, days }, `Game Pass granted to ${label}`)}>
            Grant pass
          </Button>
          {deactivated ? <p className="text-sm text-muted-foreground">Reactivate the account first.</p> : null}
          {noPlans ? <p className="text-sm text-muted-foreground">No active plans. Create one under Plans.</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Adjust current manual pass</CardTitle>
          <CardDescription>{hasSubscription ? "Change the plan or end date of the current manual pass. Paid passes stay as sold." : "Grant a pass first."}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="set-plan">Assign plan</Label>
            <div className="flex gap-2">
              <Select id="set-plan" value={plan} onChange={(e) => setPlan(e.target.value)} disabled={busy || !hasSubscription || noPlans}>
                {plans.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
              </Select>
              <Button variant="secondary" disabled={busy || !hasSubscription || noPlans} onClick={() => run("subscription", { action: "set_plan", planCode: plan }, "Plan updated")}>
                Assign
              </Button>
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="set-expiry">Expires on</Label>
            <div className="flex gap-2">
              <Input id="set-expiry" type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} disabled={busy || !hasSubscription} />
              <Button variant="secondary" disabled={busy || !hasSubscription || !expiry}
                onClick={() => run("subscription", { action: "set_expiry", expires: `${expiry}T23:59:59Z` }, "Expiration updated")}>
                Save
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Extend access</CardTitle>
          <CardDescription>Adds complimentary days of the host&apos;s current plan after their current access (works for paid passes too; the paid pass itself is never edited).</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
            <div className="grid gap-2">
              <Label htmlFor="ext-days">Days</Label>
              <Input id="ext-days" type="number" min={1} max={366} value={extendDays} onChange={(e) => setExtendDays(Number(e.target.value))} disabled={busy || state !== "active"} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ext-reason">Reason</Label>
              <Input id="ext-reason" value={extendReason} onChange={(e) => setExtendReason(e.target.value)} placeholder="e.g. outage compensation" maxLength={200} disabled={busy || state !== "active"} />
            </div>
          </div>
          <Button variant="secondary" disabled={busy || state !== "active" || extendReason.trim().length < 3}
            onClick={() => run("subscription", { action: "extend", days: extendDays, reason: extendReason }, `Extended ${label} by ${extendDays} days`)}>
            Extend
          </Button>
          {state !== "active" ? <p className="text-sm text-muted-foreground">Only an active pass can be extended. Grant a pass instead.</p> : null}
        </CardContent>
      </Card>

      <Card className="border-destructive/30">
        <CardHeader>
          <CardTitle>Access controls</CardTitle>
          <CardDescription>Suspending pauses hosting. Deactivating also blocks sign-in. Both are reversible.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          {state === "active" ? <Button variant="destructive" disabled={busy} onClick={() => setConfirm("suspend")}>Suspend hosting</Button> : null}
          {state === "suspended" ? <Button disabled={busy} onClick={() => run("subscription", { action: "unsuspend" }, `Hosting restored for ${label}`)}>Unsuspend hosting</Button> : null}
          {deactivated ? (
            <Button disabled={busy} onClick={() => setConfirm("reactivate")}>Reactivate account</Button>
          ) : (
            <Button variant="destructive" disabled={busy} onClick={() => setConfirm("deactivate")}>Deactivate account</Button>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirm === "suspend"} busy={busy} title={`Suspend ${label}?`} confirmLabel="Suspend"
        description="They won't be able to create or start games until you unsuspend them. Pass time keeps running. Games already running can still be finished."
        onClose={() => setConfirm(null)}
        onConfirm={() => run("subscription", { action: "suspend" }, `Suspended ${label}`)}
      />
      <ConfirmDialog
        open={confirm === "deactivate"} busy={busy} title={`Deactivate ${label}?`} confirmLabel="Deactivate"
        description="They will be signed out of new sessions and cannot sign in or host games. You can reactivate the account at any time."
        onClose={() => setConfirm(null)}
        onConfirm={() => run("account", { action: "deactivate" }, `Deactivated ${label}`)}
      />
      <ConfirmDialog
        open={confirm === "reactivate"} busy={busy} destructive={false} title={`Reactivate ${label}?`} confirmLabel="Reactivate"
        description="They can sign in again. Their Game Passes (if any) are unchanged."
        onClose={() => setConfirm(null)}
        onConfirm={() => run("account", { action: "reactivate" }, `Reactivated ${label}`)}
      />
    </div>
  );
}
