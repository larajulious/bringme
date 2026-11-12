"use client";

import { BadgeCheck, Hourglass, Send, XCircle } from "lucide-react";

import { Confetti } from "@/components/game/confetti";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { patternLabel, type CardEvaluation } from "@/lib/bingosnap/completion";
import type { BingoPlayerSnapshot } from "@/lib/bingosnap/types";

const claimErrors: Record<string, string> = {
  hunt_over: "Time's up: your claim arrived too late.",
  hunt_not_active: "The hunt isn't running right now.",
  claim_pending: "You already have a claim being checked.",
  already_verified: "Your claim is already verified!",
  attempts_exhausted: "You've used all your claims for this game.",
  invalid_pattern: "Those squares don't make a winning pattern on your card. Check your card and try again.",
  invalid_cells: "Those squares don't match your card. Refresh the page and try again.",
  player_removed: "You're no longer in this game.",
  invalid_session: "Your session ended. Join again from the room link.",
};

/** A random id for one claim attempt (crypto.randomUUID needs a secure page; fall back to getRandomValues). */
function newRequestId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const RETRY_DELAYS_MS = [0, 800, 2000];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clockTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });

/**
 * Submit eligibility and the claim itself. The completion engine decides whether the player
 * has photos for a winning pattern; the server re-checks the pattern, the deadline and the
 * one-open-claim rule. The request carries ONLY the cell ids and a request id: photos never
 * leave the phone, and the Game Master judges them in person.
 *
 * Reliability: one request id per attempt, reused for automatic retries (network errors, 5xx) and
 * for a manual "try again", so a lost response can never create a second claim. A synchronous lock
 * stops double taps. "Already sent" (another tab, an earlier retry) is treated as success.
 */
export function ClaimPanel({
  result, me, huntActive, onState,
}: {
  result: CardEvaluation;
  me: BingoPlayerSnapshot["me"];
  huntActive: boolean;
  /** The fresh snapshot returned by the server (or null: resync). */
  onState: (s: BingoPlayerSnapshot | null) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const lock = useRef(false);
  const requestId = useRef<string | null>(null);
  // A new attempt (e.g. after a rejection) gets a new request id.
  const attempts = me.submissions.length;
  useEffect(() => { requestId.current = null; }, [attempts]);
  const subs = me.submissions;
  const pending = subs.find((x) => x.status === "pending");
  const verified = subs.find((x) => x.status === "verified");
  const lastRejected = !pending && !verified ? [...subs].reverse().find((x) => x.status === "rejected") : undefined;
  const full = result.mode === "full_card";
  const what = full ? "Full Card" : "Bingo";
  // Status changes: focus the new status after a submit (the button it replaces is gone), and
  // celebrate a verification the moment it arrives (not when a refresh restores it).
  const statusRef = useRef<HTMLDivElement>(null);
  const justSent = useRef(false);
  const prevStatus = useRef<string | null | undefined>(undefined);
  const [celebrate, setCelebrate] = useState(false);
  const current = verified ? "verified" : pending ? "pending" : lastRejected ? "rejected" : null;
  useEffect(() => {
    if (prevStatus.current !== undefined && prevStatus.current !== current && current === "verified") setCelebrate(true);
    prevStatus.current = current;
    if (justSent.current && current === "pending") { justSent.current = false; statusRef.current?.focus(); }
  }, [current]);
  const canSubmit = huntActive && me.canClaim && result.eligible && !!result.claim && !pending && !verified && !busy;

  const submit = async () => {
    if (lock.current || !result.claim) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    requestId.current ??= newRequestId();
    const body = JSON.stringify({ cellIds: result.claim.cellIds, requestId: requestId.current });
    let res: Response | null = null;
    type Reply = { state?: BingoPlayerSnapshot; error?: string };
    let data: Reply | null = null;
    for (const delay of RETRY_DELAYS_MS) {
      if (delay) await sleep(delay);
      res = await fetch("/api/play/bingosnap/claim", { method: "POST", headers: { "content-type": "application/json" }, body }).catch(() => null);
      data = res ? ((await res.json().catch(() => null)) as Reply | null) : null;
      if (res && res.status < 500) break; // a definite answer: don't retry
    }
    lock.current = false;
    setBusy(false);
    setConfirm(false);
    const reply = data as Reply | null;
    if (res?.ok && reply?.state) { justSent.current = true; return onState(reply.state); }
    const code = reply?.error ?? "";
    if (code === "claim_pending" || code === "already_verified") {
      justSent.current = true;
      setNotice("Your claim was already sent (maybe from another tab).");
      return onState(null);
    }
    if (!res || res.status >= 500) {
      // Keep the request id: trying again can't create a second claim.
      setError("We couldn't reach the server. Your photos are safe: tap Submit to try again.");
      return onState(null);
    }
    requestId.current = null;
    setError(claimErrors[code] ?? "We couldn't send your claim. Try again.");
    onState(null);
  };

  if (verified) {
    return (
      <div className="relative overflow-hidden rounded-3xl bg-brand-success px-4 py-4 text-center text-white shadow-card" role="status">
        {celebrate ? <Confetti pieces={26} once /> : null}
        <p className="relative flex items-center justify-center gap-2 font-display text-2xl font-bold">
          <BadgeCheck aria-hidden="true" className={celebrate ? "size-7 animate-bounce-in motion-reduce:animate-none" : "size-7"} /> Verified!
        </p>
        <p className="relative text-sm font-semibold">The Game Master accepted your {what}.</p>
      </div>
    );
  }
  if (pending) {
    return (
      <div ref={statusRef} tabIndex={-1} className="grid animate-pop-in justify-items-center gap-1 rounded-3xl bg-white/12 px-4 py-3 text-center ring-1 ring-white/20 focus:outline-none focus-visible:ring-4 focus-visible:ring-brand-yellow motion-reduce:animate-none" role="status">
        <p className="flex items-center gap-2 font-display text-lg font-bold"><Hourglass aria-hidden="true" className="size-5 text-brand-yellow" /> Claim sent: {patternLabel(pending.pattern)}</p>
        <p className="text-sm text-white/85">Received at {clockTime(pending.submittedAt)}. You&apos;re in the Game Master&apos;s queue: show them your photos and keep this page open.</p>
        {notice ? <p className="text-xs text-white/70">{notice}</p> : null}
      </div>
    );
  }
  if (!huntActive) {
    // After the deadline a rejection still has to reach the player, but they can't claim again.
    return lastRejected ? (
      <p className="flex items-start gap-2 rounded-2xl bg-brand-coral/25 px-4 py-3 text-left text-sm ring-1 ring-brand-coral/60" role="status">
        <XCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span>Your claim wasn&apos;t accepted{lastRejected.rejectionReason ? `: “${lastRejected.rejectionReason}”` : ""}. Time&apos;s up, so there are no more claims this game.</span>
      </p>
    ) : null;
  }

  return (
    <div className="grid justify-items-center gap-2">
      {lastRejected ? (
        <p className="flex items-start gap-2 rounded-2xl bg-brand-coral/25 px-4 py-2 text-left text-sm ring-1 ring-brand-coral/60" role="status">
          <XCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            Your last claim wasn&apos;t accepted{lastRejected.rejectionReason ? `: “${lastRejected.rejectionReason}”` : ""}. Retake photos and try again
            {me.attemptsLeft > 0 ? ` (${me.attemptsLeft} ${me.attemptsLeft === 1 ? "claim" : "claims"} left).` : "."}
          </span>
        </p>
      ) : null}
      <Button size="lg" className="w-full max-w-sm" disabled={!canSubmit} onClick={() => setConfirm(true)} aria-describedby="claim-hint">
        <Send aria-hidden="true" /> {busy ? "Sending…" : `Submit ${what}`}
      </Button>
      <p id="claim-hint" className="text-center text-sm text-white/80" role="status">
        {error ?? notice ??
          (!me.canClaim || me.attemptsLeft <= 0
            ? "No more claims for this game."
            : result.eligible
              ? "The Game Master will check that each photo matches."
              : full
                ? `Snap every square to submit: ${result.toGo} to go.`
                : `Complete a row, column or diagonal to submit: ${result.toGo} more ${result.toGo === 1 ? "photo" : "photos"} needed.`)}
      </p>
      <ConfirmDialog
        open={confirm} busy={busy} destructive={false}
        title={`Submit your ${what}?`}
        confirmLabel={busy ? "Sending…" : "Submit"}
        description={`${result.claim ? patternLabel(result.claim.pattern) : ""}: the Game Master will check the photos of these ${result.claim?.cellIds.length ?? 0} squares. They can't be retaken while they're being checked.`}
        onClose={() => setConfirm(false)}
        onConfirm={() => void submit()}
      />
    </div>
  );
}
