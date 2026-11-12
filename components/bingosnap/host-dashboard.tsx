"use client";

import { BadgeCheck, Check, CheckCircle2, ChevronRight, Circle, Clock, Hourglass, Megaphone, RotateCcw, Search, SkipForward, Trophy, Users, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { bingoOnScreen } from "@/components/bingosnap/on-screen";
import { fetchBingoHostSnapshot } from "@/components/bingosnap/host-lobby";
import { OnScreenNow } from "@/components/game/on-screen-now";
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

type Action = "close_hunt" | "end_game" | "announce_results";
const confirmText: Record<Exclude<Action, "announce_results">, { title: string; label: string; text: string }> = {
  close_hunt: { title: "End the hunt now?", label: "End hunt", text: "No new claims are accepted from now on. Claims you've received stay open for review." },
  end_game: { title: "End this game now?", label: "End game", text: "The hunt stops for everyone, reviews close for good and the game moves to your history." },
};

function Stat({ label, value, tone, onOpen }: { label: string; value: number; tone: string; onOpen?: () => void }) {
  const body = (
    <>
      <span className="font-display text-4xl font-bold tabular-nums">{value}</span>
      <span className="text-sm font-semibold">{label}{onOpen ? <ChevronRight aria-hidden="true" className="ml-0.5 inline size-4 align-[-3px]" /> : null}</span>
    </>
  );
  const cls = cn("grid justify-items-center rounded-3xl px-3 py-3 text-center", tone);
  return onOpen ? (
    <button type="button" onClick={onOpen} aria-label={`${label}: ${value}. Show the list`}
      className={cn(cls, "transition-transform focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/60 motion-safe:hover:-translate-y-0.5")}>{body}</button>
  ) : <div className={cls}>{body}</div>;
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

function RejectDialog({ entry, suggested, busy, onClose, onReject }: { entry: QueueEntry | null; suggested?: string; busy: boolean; onClose: () => void; onReject: (reason: string | null) => void }) {
  const [reason, setReason] = useState("");
  // Pre-filled with the squares the host didn't tick off (they can change or clear it).
  useEffect(() => { if (entry) setReason(suggested ?? ""); }, [entry, suggested]);
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
  // The claim being checked: the earliest received, unless the host picked another ("Review now").
  const [focusId, setFocusId] = useState<string | null>(null);
  // "Not here? Skip for now": skipped claims move to the back of the host's own order (still pending).
  const [skipped, setSkipped] = useState<string[]>([]);
  const ordered = useMemo(() => [
    ...queue.pending.filter((q) => !skipped.includes(q.id)),
    ...skipped.map((id) => queue.pending.find((q) => q.id === id)).filter((q): q is QueueEntry => !!q),
  ], [queue.pending, skipped]);
  const next = ordered.find((q) => q.id === focusId) ?? ordered[0];
  const waiting = ordered.filter((q) => q !== next);
  const skip = (q: QueueEntry) => {
    setSkipped((cur) => [...cur.filter((id) => id !== q.id), q.id]);
    if (focusId === q.id) setFocusId(null);
    toast(`${q.nickname} moved to the back of the line`, "info");
  };
  /** The claim lists (waiting / verified / history) live in one modal with tabs. */
  const [list, setList] = useState<null | "waiting" | "verified" | "history">(null);
  const [search, setSearch] = useState("");
  const term = search.trim().toLowerCase();
  const match = (q: QueueEntry) => !term || q.nickname.toLowerCase().includes(term);
  // First Bingo wins and a winner is verified: the other claims can't change the result.
  const decided = b.winnerRule === "first" && !!queue.leader;
  // Announcing (server rules, bingo_transition 'announce_results'): after the hunt, the winner is the earliest
  // verified claim, and no unchecked claim received BEFORE it may remain (it could still take first place).
  const leader = queue.verified[0] ?? null;
  const blockers = queue.pending.filter((q) => !leader || q.order < leader.order);
  // Squares the host has seen on the player's phone, per claim (local only: photos never leave the phone).
  const [seenCells, setSeenCells] = useState<Record<string, string[]>>({});
  const toggleSeen = (claimId: string, cellId: string) => setSeenCells((cur) => {
    const list = cur[claimId] ?? [];
    return { ...cur, [claimId]: list.includes(cellId) ? list.filter((x) => x !== cellId) : [...list, cellId] };
  });
  const missingReason = (q: QueueEntry) => {
    const missing = (q.cells ?? []).filter((c) => !(seenCells[q.id] ?? []).includes(c.id)).map((c) => c.challenge);
    if (!missing.length || missing.length === (q.cells ?? []).length) return undefined; // nothing ticked: no guess
    const text = `${missing.length === 1 ? "Photo missing" : "Photos missing"}: ${missing.join(", ")}`;
    return text.length > REASON_MAX_LENGTH ? `${text.slice(0, REASON_MAX_LENGTH - 1)}…` : text;
  };
  const keysRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  /** Checking claims happens in a modal that moves on to the next claim by itself after each decision. */
  const [checking, setChecking] = useState(false);
  const reviewNow = (q: QueueEntry) => { setFocusId(q.id); setChecking(true); };
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

  // Laptop shortcuts while the check modal is open: V verify, R reject, S skip (never while typing or in another dialog).
  keysRef.current = (e: KeyboardEvent) => {
    if (!checking || list || !next || !reviewable || rejectFor || confirm || e.altKey || e.ctrlKey || e.metaKey) return;
    if ((e.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable]")) return;
    const k = e.key.toLowerCase();
    if (k === "v" && !next.playerRemoved && !reviewing.has(next.id)) { e.preventDefault(); void review(next, "verify"); }
    else if (k === "r" && !reviewing.has(next.id)) { e.preventDefault(); setRejectFor(next); }
    else if (k === "s" && waiting.length) { e.preventDefault(); skip(next); }
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => keysRef.current(e);
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  const run = async (action: Action) => {
    setBusy(true);
    const send = (version: number) => fetch(`/api/host/bingosnap/${s.gameId}/transition`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(action === "announce_results" ? { action, expectedVersion: version, winnerSubmissionId: leader?.id ?? null } : { action, expectedVersion: version }),
    }).catch(() => null);
    let res = await send(s.version);
    let code = res && !res.ok ? ((await res.clone().json().catch(() => ({}))) as { error?: string }).error : undefined;
    if (code === "stale_state") {
      // Only the version moved (e.g. the hunt just settled into review): retry once against the fresh state.
      const fresh = await fetchBingoHostSnapshot(s.gameId);
      if (fresh.status === "ok") { applyState(fresh.state); res = await send(fresh.state.version); code = res && !res.ok ? ((await res.clone().json().catch(() => ({}))) as { error?: string }).error : undefined; }
    }
    setBusy(false);
    setConfirm(null);
    if (!res?.ok) {
      resync();
      const text = code === "earlier_claim_pending" ? "A claim received before the winner still needs checking. Check it first."
        : code === "winner_mismatch" ? "The ranking just changed. Check the winner and try again."
        : code === "invalid_transition" && action === "announce_results" ? "Late claims can still arrive for a moment. Try again in a few seconds."
        : res?.status === 409 ? "The game just changed (a new claim?). Check, then try again." : "That didn't work. Please try again.";
      return toast(text, "error");
    }
    const body = (await res.json().catch(() => null)) as { state?: BingoHostSnapshot } | null;
    if (body?.state) applyState(body.state);
    toast(action === "close_hunt" ? "Hunt ended: no new claims" : action === "announce_results" ? "Winners announced on the presenter screen!" : "Game ended", "success");
    if (action === "end_game") router.refresh(); else resync();
  };

  const seenOf = (q: QueueEntry) => (seenCells[q.id] ?? []).filter((id) => q.cells?.some((c) => c.id === id)).length;
  const decide = (q: QueueEntry, big = false) => {
    const allSeen = !!q.cells?.length && seenOf(q) === q.cells.length;
    return (
      <div className={cn("grid gap-2 sm:flex sm:flex-wrap", big && "gap-3")}>
        <Button size={big ? "lg" : "default"} variant="success" className={cn("h-auto min-h-11 whitespace-normal py-2", big && "min-h-14 text-xl sm:min-w-40", big && allSeen && "motion-safe:animate-pulse-soft")}
          disabled={!reviewable || q.playerRemoved || reviewing.has(q.id)} onClick={() => void review(q, "verify")}
          aria-label={`Verify ${q.nickname}`} title={q.playerRemoved ? "Removed players can't be verified" : undefined}>
          <Check aria-hidden="true" /> {big && allSeen ? `All seen: Verify ${q.nickname}` : "Verify"}
        </Button>
        <Button size={big ? "lg" : "default"} variant="destructive" className={cn("h-auto min-h-11 whitespace-normal py-2", big && "min-h-14 text-xl sm:min-w-40")}
          disabled={!reviewable || reviewing.has(q.id)} onClick={() => setRejectFor(q)} aria-label={`Reject ${q.nickname}`}>
          <X aria-hidden="true" /> Reject
        </Button>
        {big && waiting.length ? (
          <Button size="lg" variant="ghost" className="h-auto min-h-14 whitespace-normal py-2 sm:ml-auto" disabled={reviewing.has(q.id)} onClick={() => skip(q)}>
            <SkipForward aria-hidden="true" /> Not here? Skip for now
          </Button>
        ) : null}
      </div>
    );
  };

  return (
    <div className="mb-8 grid gap-4">
      <p className="sr-only" role="status" aria-live="polite">{announce}</p>
      <OnScreenNow screen={bingoOnScreen(s, beforeHunt, over)} />

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
          <Stat label="Pending" value={s.counts.pending} tone="bg-brand-yellow text-brand-night" onOpen={() => setList("waiting")} />
          <Stat label="Verified" value={s.counts.verified} tone="bg-brand-success text-white" onOpen={() => setList("verified")} />
          <Stat label="Rejected" value={s.counts.rejected} tone="bg-white/12" onOpen={() => setList("history")} />
        </div>
      </section>

      {/* ----------------------------------------------------------------- up next */}
      {decided && queue.pending.length && live ? (
        <section role="status" className="grid gap-3 rounded-4xl border-2 border-brand-success bg-brand-success/10 p-5 sm:flex sm:items-center sm:justify-between">
          <p className="flex items-start gap-2 font-semibold">
            <Trophy aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-brand-success" />
            <span>{queue.leader!.nickname} has the first verified Bingo. The {queue.pending.length} other claim{queue.pending.length === 1 ? "" : "s"} can&apos;t change the winner, so you don&apos;t have to check them.</span>
          </p>
          <Button variant="success" className="shrink-0" onClick={() => setConfirm("end_game")} disabled={busy}><Trophy aria-hidden="true" /> End game &amp; show winner</Button>
        </section>
      ) : null}
      {next ? (
        <section aria-labelledby="next-h" className="grid gap-4 rounded-4xl border-4 border-brand-yellow bg-card p-5 text-card-foreground shadow-card sm:flex sm:items-center sm:justify-between sm:p-6">
          <div className="min-w-0">
            <p className="inline-flex w-fit items-center gap-2 rounded-full bg-brand-yellow px-3 py-1 text-sm font-bold uppercase tracking-wide text-brand-night"><Megaphone aria-hidden="true" className="size-4" /> Next to check</p>
            <h2 id="next-h" className="mt-2 break-words font-display text-3xl font-bold text-primary sm:text-4xl">{next.nickname}</h2>
            <p className="text-sm text-muted-foreground">{queue.pending.length} claim{queue.pending.length === 1 ? "" : "s"} waiting · <ClaimMeta q={next} start={b.huntStartedAt} /></p>
          </div>
          <div className="grid shrink-0 gap-2 sm:justify-items-end">
            {reviewable ? (
              <Button size="lg" className="min-h-14 w-full text-xl sm:w-auto" onClick={() => setChecking(true)}>
                <BadgeCheck aria-hidden="true" /> Check claims
              </Button>
            ) : <p className="text-muted-foreground">Reviews are closed for this game.</p>}
            <Button variant="ghost" className="w-full sm:w-auto" onClick={() => setList("waiting")}><Users aria-hidden="true" /> See everyone in line</Button>
          </div>
        </section>
      ) : live ? (
        <section className="rounded-4xl border-2 border-dashed bg-card p-6 text-center text-muted-foreground" role="status">
          <p className="font-display text-2xl font-semibold text-primary">No claims waiting</p>
          <p>When a player submits, their name appears here, in the order the server received it.</p>
        </section>
      ) : null}

      {/* ---------------------------------------------------------------- announce */}
      {live && b.resultsAt ? (
        <section role="status" className="grid gap-3 rounded-4xl border-2 border-brand-success bg-card p-5 shadow-card sm:flex sm:items-center sm:justify-between sm:p-6">
          <p className="flex items-start gap-2 font-display text-xl font-semibold">
            <Trophy aria-hidden="true" className="mt-0.5 size-6 shrink-0 text-brand-success" />
            <span>Winners are on the presenter screen{leader ? `: ${leader.nickname}${b.winnerRule === "first" ? " wins!" : " is #1."}` : "."}</span>
          </p>
          <Button size="lg" className="w-full shrink-0 sm:w-auto" onClick={() => setConfirm("end_game")} disabled={busy}>Finish game</Button>
        </section>
      ) : live && over && !beforeHunt ? (
        <section aria-labelledby="announce-h" className="grid gap-3 rounded-4xl bg-card p-5 shadow-card sm:p-6">
          <h2 id="announce-h" className="flex items-center gap-2 font-display text-2xl font-bold text-primary"><Trophy aria-hidden="true" className="size-6 text-brand-yellow-deep" /> Announce the winners</h2>
          {blockers.length ? (
            <>
              <p className="text-muted-foreground">
                {leader
                  ? <>Check <strong className="text-foreground">{blockers.map((q) => q.nickname).slice(0, 3).join(", ")}{blockers.length > 3 ? ` +${blockers.length - 3}` : ""}</strong> first: they called Bingo before {leader.nickname}, so {blockers.length === 1 ? "they" : "one of them"} could still win.</>
                  : <>Check the claims first: nobody is verified yet.</>}
              </p>
              <Button size="lg" className="w-full sm:w-fit" onClick={() => reviewNow(blockers[0])}><BadgeCheck aria-hidden="true" /> Check {blockers[0].nickname} now</Button>
            </>
          ) : (
            <>
              <p className="text-muted-foreground">
                {leader ? (b.winnerRule === "first"
                  ? <>Winner: <strong className="text-foreground">{leader.nickname}</strong>, the first verified Bingo.</>
                  : <><strong className="text-foreground">{queue.verified.length}</strong> verified player{queue.verified.length === 1 ? "" : "s"}, in order. #1 is <strong className="text-foreground">{leader.nickname}</strong>.</>)
                  : "Nobody got a verified Bingo this time."}
                {queue.pending.length ? ` ${queue.pending.length} later claim${queue.pending.length === 1 ? " is" : "s are"} still waiting and won't be checked once you announce.` : ""}
              </p>
              <Button size="lg" className="min-h-14 w-full text-xl sm:w-fit motion-safe:animate-pulse-soft" onClick={() => setConfirm("announce_results")} disabled={busy}>
                <Trophy aria-hidden="true" /> Announce winners
              </Button>
            </>
          )}
        </section>
      ) : null}

      {live ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground"><Users aria-hidden="true" className="size-4" /> Photos never leave the players&apos; phones: you check them in person.</p>
      ) : null}

      {/* --------------------------------------------------------- claim lists modal */}
      <Modal
        open={list !== null} onClose={() => { setList(null); setSearch(""); }} className="max-w-2xl max-sm:mb-auto max-sm:mt-3"
        title="Bingo claims" description="Everyone who called Bingo, in the order the server received them."
        footer={<Button variant="outline" className="w-full sm:w-auto" onClick={() => { setList(null); setSearch(""); }}>Close</Button>}
      >
        <div className="grid gap-3">
          <div className="sticky top-0 z-10 -mx-6 grid gap-2 bg-card px-6 pb-2">
            <div role="group" aria-label="Show claims" className="flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none]">
              {([["waiting", "Waiting", queue.pending.length], ["verified", "Verified", queue.verified.length], ["history", "History", queue.history.length]] as const).map(([k, label, n]) => (
                <button key={k} type="button" aria-pressed={list === k} onClick={() => setList(k)}
                  className={cn("min-h-11 shrink-0 rounded-full px-4 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    list === k ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground hover:bg-accent")}>
                  {label} ({n})
                </button>
              ))}
            </div>
            {queue.pending.length + queue.history.length >= 6 ? (
              <div className="relative">
                <Label htmlFor="claims-search" className="sr-only">Find a player</Label>
                <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-muted-foreground" />
                <Input id="claims-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find a player…" className="pl-10" autoComplete="off" />
              </div>
            ) : null}
          </div>

          {list === "waiting" ? (
            ordered.filter(match).length ? (
              <ol className="grid gap-2" aria-label="Claims waiting, in the order you'll check them">
                {ordered.filter(match).map((q) => (
                  <li key={q.id} className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border p-3", q === next && "border-2 border-brand-yellow bg-brand-yellow/10")}>
                    <div className="min-w-0 flex-1">
                      <p className="break-words font-display text-xl font-bold">
                        {q.nickname}{q.playerRemoved ? <span className="text-base text-muted-foreground"> (removed)</span> : null}
                        {q === next ? <Badge variant="yellow" className="ml-2 align-middle">next</Badge> : null}
                        {skipped.includes(q.id) ? <Badge variant="secondary" className="ml-2 align-middle">skipped</Badge> : null}
                      </p>
                      <p className="text-sm"><ClaimMeta q={q} start={b.huntStartedAt} /></p>
                    </div>
                    {reviewable ? (
                      <Button variant="secondary" className="w-full sm:w-auto" onClick={() => { setList(null); setSearch(""); reviewNow(q); }} aria-label={`Review ${q.nickname} now`}>
                        <Megaphone aria-hidden="true" /> Review now
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ol>
            ) : <p className="rounded-2xl bg-secondary px-4 py-6 text-center text-muted-foreground" role="status">{term ? `Nobody called “${search.trim()}” is waiting.` : "Nobody is waiting."}</p>
          ) : list === "verified" ? (
            queue.verified.filter(match).length ? (
              <>
                {b.winnerRule === "first" && queue.leader ? <p className="font-semibold">First Bingo wins: <span className="text-brand-success">{queue.leader.nickname}</span> is the winner so far.</p> : null}
                <ol className="grid gap-2" aria-label="Verified players by finish">
                  {queue.verified.filter(match).map((q) => {
                    const first = q === queue.verified[0];
                    return (
                      <li key={q.id} className={cn("flex flex-wrap items-center gap-3 rounded-2xl border-2 border-brand-success/40 bg-brand-success/10 p-3", first && "border-brand-success")}>
                        <span className={cn("grid size-11 shrink-0 place-items-center rounded-full font-display text-lg font-bold", first ? "bg-brand-yellow text-brand-night" : "bg-brand-success text-white")}>
                          {first ? <Trophy aria-hidden="true" className="size-5" /> : <span aria-hidden="true">{q.rank ?? "•"}</span>}
                          <span className="sr-only">Rank {q.rank ?? ""}</span>
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="break-words font-display text-xl font-bold">{q.nickname}</p>
                          <p className="text-sm"><ClaimMeta q={q} start={b.huntStartedAt} /></p>
                        </div>
                        {reviewable ? <Button variant="outline" size="sm" className="h-11" disabled={reviewing.has(q.id)} onClick={() => void review(q, "reset")} aria-label={`Undo: put ${q.nickname}'s claim back in the queue`}><RotateCcw aria-hidden="true" /> Undo</Button> : null}
                      </li>
                    );
                  })}
                </ol>
              </>
            ) : <p className="rounded-2xl bg-secondary px-4 py-6 text-center text-muted-foreground" role="status">{term ? `No verified player called “${search.trim()}”.` : "Nobody verified yet."}</p>
          ) : (
            queue.history.filter(match).length ? (
              <ol className="grid gap-2" aria-label="Decisions, most recent first">
                {queue.history.filter(match).map((q) => (
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
                      <Button variant="ghost" size="sm" className="h-11" disabled={reviewing.has(q.id)} onClick={() => void review(q, "reset")} aria-label={`Undo: put ${q.nickname}'s claim back in the queue`}><RotateCcw aria-hidden="true" /> Undo</Button>
                    ) : null}
                  </li>
                ))}
              </ol>
            ) : <p className="rounded-2xl bg-secondary px-4 py-6 text-center text-muted-foreground" role="status">{term ? `No decision for “${search.trim()}”.` : "No decisions yet."}</p>
          )}
        </div>
      </Modal>

      {/* ------------------------------------------------------- check claims modal */}
      <Modal
        open={checking && reviewable} onClose={() => setChecking(false)} className="max-w-2xl max-sm:mb-auto max-sm:mt-3"
        title={next ? `Call forward: ${next.nickname}` : "All claims checked"}
        description={next ? `${queue.pending.length} claim${queue.pending.length === 1 ? "" : "s"} waiting. Photos stay on their phone: check them in person.` : "Nobody is waiting right now. New claims appear here as they arrive."}
        footer={<Button variant="outline" className="w-full sm:w-auto" onClick={() => setChecking(false)}>{next ? "Close" : "Done"}</Button>}
      >
        {next ? (
          <div key={next.id} className="grid animate-pop-in gap-4 motion-reduce:animate-none">
            {decided ? (
              <p role="status" className="flex items-start gap-2 rounded-2xl bg-brand-success/10 px-4 py-3 text-sm font-semibold">
                <Trophy aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-brand-success" />
                <span>{queue.leader!.nickname} already has the first verified Bingo, so this claim can&apos;t change the winner.</span>
              </p>
            ) : null}
            <p className="text-sm"><ClaimMeta q={next} start={b.huntStartedAt} />{next.playerRemoved ? <span className="text-muted-foreground"> · removed from the game</span> : null}{skipped.includes(next.id) ? <Badge variant="secondary" className="ml-2">skipped once</Badge> : null}</p>
            {next.cells?.length ? (
              <div className="grid gap-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-semibold">Tap each photo once they&apos;ve shown it to you:</p>
                  <p className="text-sm font-semibold text-muted-foreground" aria-live="polite">{seenOf(next)} of {next.cells.length} seen</p>
                </div>
                <ul className="grid gap-2 sm:grid-cols-2" aria-label={`Squares in ${next.nickname}'s claim`}>
                  {next.cells.map((c) => {
                    const on = (seenCells[next.id] ?? []).includes(c.id);
                    return (
                      <li key={c.id}>
                        <button type="button" aria-pressed={on} onClick={() => toggleSeen(next.id, c.id)}
                          className={cn("flex min-h-14 w-full items-center gap-3 rounded-2xl border-2 px-4 py-2 text-left text-lg font-semibold transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/40",
                            on ? "border-brand-success bg-brand-success/10 text-foreground" : "border-primary/15 bg-secondary text-primary hover:border-primary/40")}>
                          {on ? <CheckCircle2 aria-hidden="true" className="size-6 shrink-0 text-brand-success" /> : <Circle aria-hidden="true" className="size-6 shrink-0 text-primary/40" />}
                          <span className="min-w-0 break-words">{c.challenge}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
            {decide(next, true)}
            {waiting.length ? (
              <p className="text-sm text-muted-foreground">
                Next in line: <span className="font-semibold text-foreground">{waiting.slice(0, 3).map((q) => q.nickname).join(", ")}</span>{waiting.length > 3 ? ` +${waiting.length - 3}` : ""}
              </p>
            ) : null}
            <p className="hidden text-xs text-muted-foreground md:block">Keys: <kbd className="rounded bg-secondary px-1.5 py-0.5 font-sans">V</kbd> verify · <kbd className="rounded bg-secondary px-1.5 py-0.5 font-sans">R</kbd> reject{waiting.length ? <> · <kbd className="rounded bg-secondary px-1.5 py-0.5 font-sans">S</kbd> skip</> : null}</p>
          </div>
        ) : (
          <div className="grid justify-items-center gap-2 rounded-2xl bg-secondary px-4 py-8 text-center">
            <BadgeCheck aria-hidden="true" className="size-10 text-brand-success" />
            <p className="font-display text-xl font-semibold">Everyone in line has been checked</p>
            {over && !beforeHunt && !b.resultsAt ? (
              <Button size="lg" className="mt-2" onClick={() => { setChecking(false); setConfirm("announce_results"); }} disabled={busy}><Trophy aria-hidden="true" /> Announce winners</Button>
            ) : null}
          </div>
        )}
      </Modal>

      <RejectDialog entry={rejectFor} suggested={rejectFor ? missingReason(rejectFor) : undefined} busy={!!rejectFor && reviewing.has(rejectFor.id)} onClose={() => setRejectFor(null)}
        onReject={(reason) => rejectFor && void review(rejectFor, "reject", reason)} />
      <ConfirmDialog
        open={confirm !== null} busy={busy}
        destructive={confirm !== "announce_results"}
        title={confirm === "announce_results" ? (leader ? (b.winnerRule === "first" ? `Announce ${leader.nickname} as the winner?` : "Announce the winners?") : "Announce: no Bingo?") : confirm ? confirmText[confirm].title : ""}
        confirmLabel={confirm === "announce_results" ? "Announce" : confirm ? confirmText[confirm].label : ""}
        description={confirm === "announce_results"
          ? `The results appear on the presenter screen and everyone's phone. Reviews close for good${queue.pending.length ? `, so the ${queue.pending.length} claim${queue.pending.length === 1 ? "" : "s"} still waiting won't be checked` : ""}.`
          : confirm ? confirmText[confirm].text : ""}
        onClose={() => setConfirm(null)} onConfirm={() => confirm && void run(confirm)}
      />
    </div>
  );
}
