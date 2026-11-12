"use client";

import { BadgeCheck, Check, Clock, History, Hourglass, Megaphone, RotateCcw, Trophy, Users, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { fetchBingoHostSnapshot } from "@/components/bingosnap/host-lobby";
import { useGameSync, useNow } from "@/components/game/use-game-sync";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { modeText } from "@/lib/bingosnap/board";
import { patternLabel } from "@/lib/bingosnap/completion";
import { REJECT_REASONS, buildQueue, reviewErrorText, type QueueEntry } from "@/lib/bingosnap/queue";
import { REASON_MAX_LENGTH, type BingoHostSnapshot, type ReviewDecision } from "@/lib/bingosnap/types";
import { secondsUntil } from "@/lib/game/sync";
import { cn } from "@/lib/utils";

const clockText = (secs: number) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
const timeOfDay = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
const sinceStart = (at: string, start: string | null) =>
  start ? `+${clockText(Math.max(0, Math.floor((Date.parse(at) - Date.parse(start)) / 1000)))}` : "";
const huntEnd = (s: BingoHostSnapshot) => s.board.huntEndsAt;
const statusBadge = {
  pending: { label: "Pending", variant: "yellow" },
  verified: { label: "Verified", variant: "success" },
  rejected: { label: "Rejected", variant: "destructive" },
} as const;

type Action = "close_hunt" | "end_game";
const confirmText: Record<Action, { title: string; label: string; text: string }> = {
  close_hunt: { title: "End the hunt now?", label: "End hunt", text: "No new claims are accepted from now on. Claims you've received stay open for review." },
  end_game: { title: "End this game now?", label: "End game", text: "The hunt stops for everyone, reviews close for good and the game moves to your history." },
};

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className={cn("grid justify-items-center rounded-3xl px-3 py-3 text-center", tone)}>
      <span className="font-display text-4xl font-bold tabular-nums">{value}</span>
      <span className="text-sm font-semibold">{label}</span>
    </div>
  );
}

function ClaimMeta({ q, start }: { q: QueueEntry; start: string | null }) {
  return (
    <span className="text-muted-foreground">
      #{q.order} · {patternLabel(q.pattern)}{q.attempt > 1 ? ` · attempt ${q.attempt}` : ""} · received{" "}
      <time dateTime={q.submittedAt}>{timeOfDay(q.submittedAt)}</time>
      {start ? <span className="font-mono tabular-nums"> ({sinceStart(q.submittedAt, start)})</span> : null}
    </span>
  );
}

function RejectDialog({ entry, busy, onClose, onReject }: { entry: QueueEntry | null; busy: boolean; onClose: () => void; onReject: (reason: string | null) => void }) {
  const [reason, setReason] = useState("");
  useEffect(() => { if (entry) setReason(""); }, [entry]);
  return (
    <Modal open={entry !== null} onClose={onClose} title={entry ? `Reject ${entry.nickname}'s claim?` : "Reject claim"}
      description="They'll see your reason on their phone and can fix their photos and claim again while time remains.">
      <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); onReject(reason.trim() || null); }}>
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-semibold">Quick reasons</legend>
          <div className="flex flex-wrap gap-2">
            {REJECT_REASONS.map((r) => (
              <Button key={r} type="button" size="sm" variant={reason === r ? "secondary" : "outline"} aria-pressed={reason === r} onClick={() => setReason(reason === r ? "" : r)}>{r}</Button>
            ))}
          </div>
        </fieldset>
        <div className="grid gap-1.5">
          <Label htmlFor="reject-reason">Reason (optional)</Label>
          <Input id="reject-reason" value={reason} maxLength={REASON_MAX_LENGTH} onChange={(e) => setReason(e.target.value)} placeholder="e.g. The red mug photo is missing" aria-describedby="reject-count" />
          <span id="reject-count" className="text-right text-xs text-muted-foreground">{reason.length}/{REASON_MAX_LENGTH}</span>
        </div>
        <div className="flex flex-wrap justify-end gap-3">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" variant="destructive" disabled={busy}><X aria-hidden="true" /> {busy ? "Rejecting…" : "Reject claim"}</Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * The host's live BingoSnap dashboard: game facts, the timer (database clock), headcount and
 * claim counts, and the claim queue. Players come forward and show their photos ON THEIR OWN
 * PHONE; the host taps Verify or Reject (optional reason). Every change arrives through the
 * existing Realtime hint + authoritative re-read, so entries can't duplicate and a reconnect
 * restores the exact state. After the game ends the dashboard stays as a read-only history.
 */
export function BingoHostDashboard({ initial }: { initial: BingoHostSnapshot }) {
  const router = useRouter();
  const { toast } = useToast();
  const [confirm, setConfirm] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState<Set<string>>(new Set());
  const inflight = useRef(new Set<string>());
  const [rejectFor, setRejectFor] = useState<QueueEntry | null>(null);
  const [announce, setAnnounce] = useState("");
  const { state: s, resync, applyState, offsetMs, conn } = useGameSync<BingoHostSnapshot>({
    gameId: initial.gameId, role: "host", initial, fetchSnapshot: () => fetchBingoHostSnapshot(initial.gameId), deadlineOf: huntEnd,
  });
  useEffect(() => { if (s.status !== initial.status) router.refresh(); }, [s.status, initial.status, router]);

  const b = s.board;
  const live = s.status === "active";
  const reviewable = live && !b.resultsAt;
  const clientNow = useNow(live, 250);
  const beforeHunt = live && !!b.huntStartedAt && Date.parse(b.huntStartedAt) > clientNow + offsetMs;
  const left = secondsUntil(beforeHunt ? b.huntStartedAt : b.huntEndsAt, clientNow, offsetMs);
  const over = !beforeHunt && (!live || b.huntOver || left === 0 || s.phase !== "active");
  const players = s.players.filter((p) => p.state === "active").length;
  const queue = useMemo(() => buildQueue(s.submissions, b.winnerRule), [s.submissions, b.winnerRule]);
  const [next, ...waiting] = queue.pending;
  const mode = modeText(b.winMode);

  // Announce new claims (screen readers) once each, however many hints arrive.
  const seen = useRef(new Set(initial.submissions.map((x) => x.id)));
  useEffect(() => {
    const fresh = queue.pending.filter((q) => !seen.current.has(q.id));
    fresh.forEach((q) => seen.current.add(q.id));
    if (fresh.length) setAnnounce(`New claim from ${fresh.map((q) => q.nickname).join(", ")}`);
  }, [queue.pending]);

  const review = async (q: QueueEntry, decision: ReviewDecision, reason: string | null = null) => {
    if (inflight.current.has(q.id)) return;
    inflight.current.add(q.id);
    setReviewing(new Set(inflight.current));
    const res = await fetch(`/api/host/bingosnap/${s.gameId}/submissions/${q.id}/review`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(reason ? { decision, reason } : { decision }),
    }).catch(() => null);
    const data = (await res?.json().catch(() => null)) as { state?: BingoHostSnapshot; error?: string } | null;
    inflight.current.delete(q.id);
    setReviewing(new Set(inflight.current));
    if (res?.ok && data?.state) {
      applyState(data.state);
      setRejectFor(null);
      toast(decision === "verify" ? `${q.nickname} is verified` : decision === "reject" ? `${q.nickname}'s claim was rejected` : `${q.nickname}'s claim is back in the queue`, decision === "reject" ? "info" : "success");
      return;
    }
    toast(reviewErrorText(data?.error, q.nickname), "error");
    resync();
  };

  const run = async (action: Action) => {
    setBusy(true);
    const res = await fetch(`/api/host/bingosnap/${s.gameId}/transition`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, expectedVersion: s.version }),
    }).catch(() => null);
    setBusy(false);
    setConfirm(null);
    if (!res?.ok) {
      resync();
      return toast(res?.status === 409 ? "The game just changed (a new claim?). Check, then try again." : "That didn't work. Please try again.", "error");
    }
    toast(action === "close_hunt" ? "Hunt ended: no new claims" : "Game ended", "success");
    if (action === "end_game") router.refresh(); else resync();
  };

  const decide = (q: QueueEntry, big = false) => (
    <div className={cn("flex flex-wrap gap-2", big && "gap-3")}>
      <Button size={big ? "lg" : "default"} variant="success" className={cn(big && "min-w-40 text-xl")}
        disabled={!reviewable || q.playerRemoved || reviewing.has(q.id)} onClick={() => void review(q, "verify")}
        aria-label={`Verify ${q.nickname}`} title={q.playerRemoved ? "Removed players can't be verified" : undefined}>
        <Check aria-hidden="true" /> Verify
      </Button>
      <Button size={big ? "lg" : "default"} variant="destructive" className={cn(big && "min-w-40 text-xl")}
        disabled={!reviewable || reviewing.has(q.id)} onClick={() => setRejectFor(q)} aria-label={`Reject ${q.nickname}`}>
        <X aria-hidden="true" /> Reject
      </Button>
    </div>
  );

  return (
    <div className="mb-8 grid gap-4">
      <p className="sr-only" role="status" aria-live="polite">{announce}</p>

      {/* ----------------------------------------------------------- game facts + timer */}
      <section aria-labelledby="live-h" className="grid gap-5 rounded-4xl bg-gradient-to-b from-primary to-brand-night p-6 text-white shadow-card sm:p-8">
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
          <div className="grid min-w-0 gap-2">
            <h2 id="live-h" className="break-words font-display text-4xl font-bold">{s.title}</h2>
            <ul className="flex flex-wrap gap-2 text-sm font-semibold" aria-label="Game details">
              <li className="rounded-full bg-brand-yellow px-3 py-1 text-brand-night">{mode.name}</li>
              <li className="rounded-full bg-white/15 px-3 py-1">{b.size}×{b.size} card</li>
              <li className="rounded-full bg-white/15 px-3 py-1">{b.winnerRule === "first" ? "First Bingo wins" : "Ranked winners"}</li>
              <li><Badge variant={!live ? "secondary" : beforeHunt ? "yellow" : over ? "secondary" : "coral"} className="px-3 py-1 text-sm">
                {!live ? "Game over" : beforeHunt ? "Starting" : over ? "Time's up: reviewing" : "Hunt on"}
              </Badge></li>
            </ul>
            {live && over ? <p className="text-sm text-white/85">No new claims are accepted. You can still check the ones you received.</p> : null}
          </div>
          <div className="grid justify-items-start gap-3 md:justify-items-end">
            {live && !over ? (
              <p className="inline-flex items-center gap-2 rounded-full bg-brand-yellow px-5 py-2 font-mono text-4xl font-bold tabular-nums text-brand-night" role="timer" aria-label={beforeHunt ? `Hunt opens in ${left} seconds` : `Time left ${clockText(left)}`}>
                <Clock aria-hidden="true" className="size-7" />{clockText(left)}
              </p>
            ) : null}
            {live ? (
              <div className="flex flex-wrap gap-2">
                {!beforeHunt && !over ? <Button variant="outline-light" onClick={() => setConfirm("close_hunt")} disabled={busy}><Hourglass aria-hidden="true" /> End hunt now</Button> : null}
                <Button variant="outline-light" onClick={() => setConfirm("end_game")} disabled={busy}>End game</Button>
              </div>
            ) : null}
            <p className="text-xs text-white/70" role="status">{conn === "live" ? "Live" : conn === "basic" ? "Live (basic mode)" : conn === "offline" ? "Offline: reconnecting…" : "Connecting…"}</p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="group" aria-label="Counts">
          <Stat label={players === 1 ? "Player" : "Players"} value={players} tone="bg-white/12" />
          <Stat label="Pending" value={s.counts.pending} tone="bg-brand-yellow text-brand-night" />
          <Stat label="Verified" value={s.counts.verified} tone="bg-brand-success text-white" />
          <Stat label="Rejected" value={s.counts.rejected} tone="bg-white/12" />
        </div>
      </section>

      {/* ----------------------------------------------------------------- up next */}
      {next ? (
        <section key={next.id} aria-labelledby="next-h" className="grid animate-pop-in gap-4 rounded-4xl border-4 border-brand-yellow bg-card p-6 text-card-foreground shadow-card motion-reduce:animate-none sm:p-8">
          <p className="inline-flex w-fit items-center gap-2 rounded-full bg-brand-yellow px-3 py-1 text-sm font-bold uppercase tracking-wide text-brand-night"><Megaphone aria-hidden="true" className="size-4" /> Call forward</p>
          <div className="grid gap-1">
            <h2 id="next-h" className="break-words font-display text-5xl font-bold text-primary sm:text-6xl">
              {next.nickname}{next.playerRemoved ? <span className="text-2xl text-muted-foreground"> (removed)</span> : null}
            </h2>
            <p className="text-lg"><ClaimMeta q={next} start={b.huntStartedAt} /></p>
          </div>
          {next.cells?.length ? (
            <div className="grid gap-2">
              <p className="font-semibold">Ask them to open their card and show you a photo of each:</p>
              <ul className="flex flex-wrap gap-2" aria-label={`Squares in ${next.nickname}'s claim`}>
                {next.cells.map((c) => <li key={c.id} className="rounded-2xl bg-secondary px-4 py-2 text-lg font-semibold text-primary">{c.challenge}</li>)}
              </ul>
            </div>
          ) : null}
          {reviewable ? decide(next, true) : <p className="text-muted-foreground">Reviews are closed for this game.</p>}
        </section>
      ) : live ? (
        <section className="rounded-4xl border-2 border-dashed bg-card p-6 text-center text-muted-foreground" role="status">
          <p className="font-display text-2xl font-semibold text-primary">No claims waiting</p>
          <p>When a player submits, their name appears here, in the order the server received it.</p>
        </section>
      ) : null}

      {/* -------------------------------------------------------- rest of the queue */}
      {waiting.length ? (
        <section aria-labelledby="queue-h" className="grid gap-3 rounded-4xl bg-card p-6 text-card-foreground shadow-card">
          <h2 id="queue-h" className="font-display text-2xl font-bold text-primary">Also waiting ({waiting.length})</h2>
          <ol className="grid gap-2" aria-label="Pending claims in the order received">
            {waiting.map((q) => (
              <li key={q.id} className="grid animate-pop-in gap-2 rounded-2xl border p-4 motion-reduce:animate-none sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <div className="min-w-0">
                  <p className="break-words font-display text-2xl font-bold">{q.nickname}{q.playerRemoved ? <span className="text-base text-muted-foreground"> (removed)</span> : null}</p>
                  <p className="text-sm"><ClaimMeta q={q} start={b.huntStartedAt} /></p>
                  {q.cells?.length ? <p className="text-sm text-muted-foreground">{q.cells.map((c) => c.challenge).join(" · ")}</p> : null}
                </div>
                {reviewable ? decide(q) : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {/* ----------------------------------------------------------------- verified */}
      <section aria-labelledby="verified-h" className="grid gap-3 rounded-4xl bg-card p-6 text-card-foreground shadow-card">
        <h2 id="verified-h" className="flex items-center gap-2 font-display text-2xl font-bold text-primary"><BadgeCheck aria-hidden="true" className="size-6 text-brand-success" /> Verified players</h2>
        {queue.verified.length ? (
          <>
            {b.winnerRule === "first" && queue.leader ? <p className="font-semibold">First Bingo wins: <span className="text-brand-success">{queue.leader.nickname}</span> is the winner so far.</p> : null}
            <ol className="grid gap-2" aria-label="Verified players by finish">
              {queue.verified.map((q, i) => (
                <li key={q.id} className={cn("flex animate-pop-in flex-wrap items-center gap-3 rounded-2xl border-2 border-brand-success/40 bg-brand-success/10 p-4 motion-reduce:animate-none", i === 0 && "border-brand-success")}>
                  <span className={cn("grid size-11 shrink-0 place-items-center rounded-full font-display text-lg font-bold", i === 0 ? "bg-brand-yellow text-brand-night" : "bg-brand-success text-white")}>
                    {i === 0 ? <Trophy aria-hidden="true" className="size-5" /> : <span aria-hidden="true">{q.rank ?? i + 1}</span>}
                    <span className="sr-only">Rank {q.rank ?? i + 1}</span>
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="break-words font-display text-2xl font-bold">{q.nickname}</p>
                    <p className="text-sm"><ClaimMeta q={q} start={b.huntStartedAt} /></p>
                  </div>
                  {reviewable ? <Button variant="outline" size="sm" disabled={reviewing.has(q.id)} onClick={() => void review(q, "reset")} aria-label={`Undo: put ${q.nickname}'s claim back in the queue`}><RotateCcw aria-hidden="true" /> Undo</Button> : null}
                </li>
              ))}
            </ol>
          </>
        ) : <p className="text-muted-foreground">Nobody yet.</p>}
      </section>

      {/* ------------------------------------------------------------------ history */}
      {queue.history.length ? (
        <section aria-labelledby="history-h" className="grid gap-3 rounded-4xl bg-card p-6 text-card-foreground shadow-card">
          <h2 id="history-h" className="flex items-center gap-2 font-display text-2xl font-bold text-primary"><History aria-hidden="true" className="size-6" /> Verification history</h2>
          <ol className="grid gap-2" aria-label="Decisions, most recent first">
            {queue.history.map((q) => (
              <li key={q.id} className="grid gap-1 rounded-2xl border p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-3">
                <div className="min-w-0">
                  <p className="font-semibold">
                    {q.nickname}
                    {queue.verifiedPlayers.has(q.playerId) ? <><BadgeCheck aria-hidden="true" className="ml-1 inline size-4 text-brand-success" /><span className="sr-only"> (verified player)</span></> : null}
                    {" "}<Badge variant={statusBadge[q.status].variant}>{statusBadge[q.status].label}</Badge>
                    {q.validatedAt ? <span className="text-sm font-normal text-muted-foreground"> at <time dateTime={q.validatedAt}>{timeOfDay(q.validatedAt)}</time></span> : null}
                  </p>
                  <p className="text-sm"><ClaimMeta q={q} start={b.huntStartedAt} /></p>
                  {q.rejectionReason ? <p className="text-sm">Reason: “{q.rejectionReason}”</p> : null}
                </div>
                {reviewable && q.status === "rejected" ? (
                  <Button variant="ghost" size="sm" disabled={reviewing.has(q.id)} onClick={() => void review(q, "reset")} aria-label={`Undo: put ${q.nickname}'s claim back in the queue`}><RotateCcw aria-hidden="true" /> Undo</Button>
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {live ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground"><Users aria-hidden="true" className="size-4" /> Photos never leave the players&apos; phones: you check them in person.</p>
      ) : null}

      <RejectDialog entry={rejectFor} busy={!!rejectFor && reviewing.has(rejectFor.id)} onClose={() => setRejectFor(null)}
        onReject={(reason) => rejectFor && void review(rejectFor, "reject", reason)} />
      <ConfirmDialog
        open={confirm !== null} busy={busy}
        title={confirm ? confirmText[confirm].title : ""}
        confirmLabel={confirm ? confirmText[confirm].label : ""}
        description={confirm ? confirmText[confirm].text : ""}
        onClose={() => setConfirm(null)} onConfirm={() => confirm && void run(confirm)}
      />
    </div>
  );
}
