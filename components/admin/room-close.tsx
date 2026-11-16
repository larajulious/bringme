"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { adminErrorMessage, adminFetch } from "@/lib/admin/client";

const PRESETS = [
  "Abandoned room (host left it open)",
  "Inappropriate content",
  "Host asked us to close it",
  "Technical problem",
  "Abuse or spam",
] as const;
const OTHER = "other";

/** Force-close ONE active room (reason required, audited). Players and screens see the game end immediately. */
export function RoomClose({ gameId, title }: { gameId: string; title: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<string>(PRESETS[0]);
  const [details, setDetails] = useState("");
  const other = choice === OTHER;
  // A preset can carry optional details; "Other" needs its own text.
  const reason = other ? details.trim() : details.trim() ? `${choice}: ${details.trim()}`.slice(0, 200) : choice;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const err = await adminFetch(`/api/admin/rooms/${gameId}/close`, "POST", { reason });
    setBusy(false);
    if (err === "room_not_active") {
      // Someone (the host or another admin) already ended it: just refresh the list.
      setOpen(false);
      toast(`“${title}” had already ended`, "success");
      return router.refresh();
    }
    if (err) return setError(adminErrorMessage(err));
    toast(`“${title}” closed`, "success");
    setOpen(false);
    router.refresh();
  };

  return (
    <>
      <Button size="sm" variant="outline" className="text-destructive" onClick={() => { setError(null); setChoice(PRESETS[0]); setDetails(""); setOpen(true); }}>
        Close room<span className="sr-only"> {title}</span>
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title={`Close “${title}”?`} className="max-w-md"
        description="The game ends right away for the host and every player and is marked as canceled. This can't be undone. The host's Game Pass is not affected.">
        <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor={`close-reason-${gameId}`}>Reason (kept in the audit log)</Label>
            <Select id={`close-reason-${gameId}`} value={choice} onChange={(e) => setChoice(e.target.value)}>
              {PRESETS.map((p) => <option key={p} value={p}>{p}</option>)}
              <option value={OTHER}>Other…</option>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor={`close-details-${gameId}`}>{other ? "Describe the reason" : "Details (optional)"}</Label>
            <Input id={`close-details-${gameId}`} value={details} onChange={(e) => setDetails(e.target.value)}
              minLength={other ? 3 : undefined} maxLength={150} required={other} />
          </div>
          {error ? <p role="alert" className="rounded-2xl bg-destructive/10 px-4 py-3 text-sm font-semibold text-destructive">{error}</p> : null}
          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
            <Button type="submit" variant="destructive" disabled={busy}>{busy ? "Closing…" : "Close room"}</Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
