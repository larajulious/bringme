"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { adminErrorMessage, adminFetch } from "@/lib/admin/client";

/** Revoke ONE pass of a subscriber (reason required, audited). Unused time is removed; history stays. */
export function PassRevoke({ userId, passId, label }: { userId: string; passId: string; label: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const err = await adminFetch(`/api/admin/users/${userId}/subscription`, "POST", { action: "revoke", passId, reason });
    setBusy(false);
    if (err) return setError(adminErrorMessage(err));
    toast(`${label} revoked`, "success");
    setOpen(false);
    router.refresh();
  };

  return (
    <>
      <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setOpen(true)}>Revoke<span className="sr-only"> {label}</span></Button>
      <Modal open={open} onClose={() => setOpen(false)} title={`Revoke ${label}?`} className="max-w-md"
        description="The remaining time of this pass is removed immediately and the next queued pass (if any) takes over. Used time and the purchase stay in the history. This does not refund money: refunds are made in Polar.">
        <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor={`revoke-${passId}`}>Reason (kept in the audit log)</Label>
            <Input id={`revoke-${passId}`} value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={200} required />
          </div>
          {error ? <p role="alert" className="rounded-2xl bg-destructive/10 px-4 py-3 text-sm font-semibold text-destructive">{error}</p> : null}
          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
            <Button type="submit" variant="destructive" disabled={busy}>{busy ? "Revoking…" : "Revoke pass"}</Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
