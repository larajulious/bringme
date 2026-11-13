"use client";

import { Camera, ChevronDown, Flag, Hourglass, MonitorPlay, Play, Plus, RotateCcw, Square, Trophy, Users } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { FinishedResults } from "@/components/game/finished-results";
import { fetchHostSnapshot, fetchRoster, fetchRounds, replayRound, runSteps } from "@/components/game/host-api";
import { rosterKey, roundsKey, submissionsKey } from "@/lib/game/refresh-keys";
import { ItemPrivacyToggle, ItemText, useItemPrivacy } from "@/components/game/item-privacy";
import { PhotoReviewGrid } from "@/components/game/photo-review-grid";
import { PhotoViewer } from "@/components/game/photo-viewer";
import { bringMeOnScreen } from "@/components/game/on-screen-now";
import { type Decision, type LiveSubmission } from "@/components/game/review-panel";
import { useGameSync, useNow, type Conn } from "@/components/game/use-game-sync";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { describeConfirmation, statusLabel } from "@/lib/game/review";
import { formatElapsed } from "@/lib/game/timing";
import type { HostAction, HostSnapshot } from "@/lib/game/types";
import { cn } from "@/lib/utils";

/** Buttons whose label may be long (names, counts): wrap instead of running off a phone screen. */
const WRAP = "h-auto min-h-11 whitespace-normal py-2 text-center leading-tight";
/** Modal footer buttons: full width and stacked on phones. */
const FOOT = cn(WRAP, "w-full sm:w-auto");
/** Late uploads the server still accepts after the time limit (see the submissions guard). */
const UPLOAD_GRACE_MS = 5000;
const START_ROUND: HostAction[] = ["start_countdown", "start_round"];
const STOP_AND_REVIEW: HostAction[] = ["close_submissions", "move_to_review"];

const errorCopy: Record<string, string> = {
  stale_state: "The game just changed. Check the screen and try again.",
  invalid_transition: "That step isn't available right now.",
  round_not_started: "The round hasn't officially started yet.",
  no_rounds_left: "There are no rounds left.",
  winner_mismatch: "The ranking changed while you were deciding. Check the new leader and confirm again.",
  winner_already_confirmed: "This round's winner is already official.",
  review_locked: "The winner is official, so photo decisions are locked.",
  submission_not_found: "That photo is no longer available.",
  subscription_required: "Your Game Pass isn't active. Choose a 7-Day Game Pass to continue hosting.",
  round_limit_reached: "You've reached your plan's round limit.",
  empty_item: "Type what players should bring.",
  invalid_item: "That item is too long.",
  network: "Can't reach the server. Check your connection.",
  game_not_found: "This game no longer exists.",
};
const connText: Record<Conn, string> = { connecting: "Connecting…", live: "Live", basic: "Live (basic mode)", reconnecting: "Reconnecting…", offline: "Offline" };

type Row = LiveSubmission;

type RoundRow = { round_no: number; prompt: string; status: string };

export function HostConsole({ gameId, initial, initialPlayers, initialRounds = [], maxRounds = 0 }: { gameId: string; initial: HostSnapshot; initialPlayers: { id: string; nickname: string }[]; initialRounds?: RoundRow[]; maxRounds?: number }) {
  const { toast } = useToast();
  const { state: s, conn, offsetMs, applyState, resync } = useGameSync<HostSnapshot>({
    gameId, role: "host", initial, fetchSnapshot: () => fetchHostSnapshot(gameId),
  });
  const [busy, setBusy] = useState<HostAction | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [confirmReplay, setConfirmReplay] = useState(false);
  const [itemHidden, toggleItem] = useItemPrivacy();
  /** The Submissions list, as a modal. Opens by itself when photos stop. */
  const [showPhotos, setShowPhotos] = useState(false);
  const [confirmWinner, setConfirmWinner] = useState(false);
  /** Confirmations for stopping the hunt early and for finishing the game. */
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmFinish, setConfirmFinish] = useState(false);
  const [players, setPlayers] = useState(initialPlayers);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [rowsError, setRowsError] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [roundList, setRoundList] = useState<RoundRow[]>(initialRounds);
  const [newItem, setNewItem] = useState("");
  const [adding, setAdding] = useState(false);

  // Each side list is re-read only when its own data changed (Phase 2): photos and reviews no longer re-read the roster.
  const rosterDep = rosterKey(s);
  useEffect(() => {
    let live = true;
    void fetchRoster(gameId).then((r) => { if (live && r) setPlayers(r); });
    return () => { live = false; };
  }, [gameId, rosterDep]);

  // Upcoming items: a round was added, opened, closed or replayed, or the game moved on.
  const roundsDep = roundsKey(s);
  useEffect(() => {
    let live = true;
    void fetchRounds(gameId).then((x) => { if (live && x) setRoundList(x); });
    return () => { live = false; };
  }, [gameId, roundsDep]);

  // Live submissions: a new photo, a review decision, a removal, or the round/phase/winner changed.
  const reqId = useRef(0);
  const wantRows = (s.phase === "active" || s.phase === "reviewing" || s.phase === "winner_announced") && Boolean(s.round);
  const loadRows = useCallback(async () => {
    const id = ++reqId.current;
    try {
      const res = await fetch(`/api/host/games/${gameId}/submissions`, { cache: "no-store" });
      if (!res.ok) throw new Error("failed");
      const data = (await res.json()) as { submissions: Row[] };
      if (id === reqId.current) { setRows(data.submissions); setRowsError(false); } // never let an older response overwrite a newer one
    } catch {
      if (id === reqId.current) setRowsError(true);
    }
  }, [gameId]);
  const rowsDep = submissionsKey(s);
  useEffect(() => {
    if (wantRows) void loadRows(); else { setRows(null); }
  }, [wantRows, rowsDep, loadRows]);

  /** One host step = one or more server actions in a row. `quiet`: automatic steps don't toast (another tab may have done it). */
  const send = async (step: HostAction | HostAction[], winner?: string | null, quiet = false) => {
    const actions = Array.isArray(step) ? step : [step];
    setBusy(actions[0]);
    const { result, changedUnderneath, reached } = await runSteps(gameId, actions, s, winner);
    setBusy(null);
    if (result.ok) { applyState(result.state); return true; }
    if (changedUnderneath) applyState(changedUnderneath); else if (reached) applyState(reached); else resync();
    if (result.error === "winner_mismatch") void loadRows();
    if (!quiet) toast(errorCopy[result.error] ?? "Something went wrong. Please try again.", "error");
    return false;
  };

  const replay = async () => {
    setBusy("start_round");
    const { result, changedUnderneath } = await replayRound(gameId, s);
    setBusy(null);
    setConfirmReplay(false);
    if (result.ok) { setViewing(null); applyState(result.state); toast("Round restarted with a new countdown.", "success"); return; }
    if (changedUnderneath) applyState(changedUnderneath); else resync();
    toast(errorCopy[result.error] ?? "Couldn't replay the round. Please try again.", "error");
  };

  const addRound = async (e: React.FormEvent) => {
    e.preventDefault();
    const prompt = newItem.trim();
    if (!prompt) return;
    setAdding(true);
    const res = await fetch(`/api/host/games/${gameId}/rounds`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt }),
    }).catch(() => null);
    setAdding(false);
    if (res?.ok) {
      const { state } = (await res.json()) as { state: HostSnapshot };
      applyState(state);
      setNewItem("");
      toast("Round added.", "success");
      return;
    }
    const code = res ? ((await res.json().catch(() => ({}))) as { error?: string }).error : "network";
    toast(errorCopy[code ?? ""] ?? "Couldn't add the round. Please try again.", "error");
  };

  const review = async (submissionId: string, decision: Decision) => {
    setBusyId(submissionId);
    const res = await fetch(`/api/host/games/${gameId}/submissions/${submissionId}/review`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision }),
    }).catch(() => null);
    setBusyId(null);
    if (res?.ok) {
      const { state } = (await res.json()) as { state: HostSnapshot };
      if (decision !== "reset") advanceFrom.current = submissionId; // move the viewer on once the list shows it
      applyState(state);
      void loadRows();
      return;
    }
    const code = res ? ((await res.json().catch(() => ({}))) as { error?: string }).error : "network";
    toast(errorCopy[code ?? ""] ?? "Couldn't save that decision. Please try again.", "error");
    void loadRows();
  };

  const r = s.round;
  const confirmation = describeConfirmation(rows ?? []);
  const locked = Boolean(r?.decided);
  const viewingRow = rows?.find((x) => x.submissionId === viewing) ?? null;

  // Round clock (server time): before openedAt the 3-2-1 is still running on everyone's screen.
  const now = useNow(s.phase === "active" || s.phase === "countdown", 250) + offsetMs;
  const openedAt = r?.openedAt ? Date.parse(r.openedAt) : null;
  const started = openedAt !== null && now >= openedAt;
  const secsToStart = openedAt !== null ? Math.max(0, Math.ceil((openedAt - now) / 1000)) : 0;
  const timeLeft = openedAt !== null && r ? Math.max(0, Math.ceil((openedAt + r.timeLimitSeconds * 1000 - now) / 1000)) : 0;

  // Photos stop by themselves once the time limit (+ upload grace) has passed, and the review opens.
  // Once per round; a failure (another tab got there first) just re-syncs, and the manual button stays.
  const autoStopped = useRef<string | null>(null);
  const roundOpen = s.phase === "active" && r?.status === "open";
  useEffect(() => {
    if (!roundOpen || !r || openedAt === null || busy !== null || autoStopped.current === r.id) return;
    const wait = openedAt + r.timeLimitSeconds * 1000 + UPLOAD_GRACE_MS - (Date.now() + offsetMs);
    const t = setTimeout(() => { autoStopped.current = r.id; void send(STOP_AND_REVIEW, undefined, true); }, Math.max(0, wait));
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `send` reads the latest state; re-arm on each state change
  }, [roundOpen, r?.id, openedAt, r?.timeLimitSeconds, offsetMs, busy, s.version]);

  // Review flow: when photos stop, the Submissions modal opens (once per round).
  const reviewOpened = useRef<string | null>(null);
  const advanceFrom = useRef<string | null>(null);
  const reviewing = s.phase === "reviewing" && !r?.decided;
  useEffect(() => {
    if (!reviewing || !r || rows === null || reviewOpened.current === r.id) return;
    reviewOpened.current = r.id;
    if (rows.length > 0) setShowPhotos(true);
  }, [reviewing, r, rows]);
  // After Approve / Disqualify in the large viewer: go to the next waiting photo; after the last one, back to the list.
  useEffect(() => {
    const from = advanceFrom.current;
    if (!from || rows === null) return;
    const decided = rows.find((x) => x.submissionId === from);
    if (decided?.status === "pending") return; // the list hasn't caught up yet
    advanceFrom.current = null;
    if (viewing !== from) return; // decided from the list, not the viewer: leave the screen alone
    const next = rows.find((x) => x.status === "pending");
    if (next) { setViewing(next.submissionId); return; }
    setViewing(null);
  }, [rows, viewing]);

  if (s.status === "finished" || s.status === "canceled") return <FinishedResults gameId={gameId} initial={s} />;

  const nextItem = roundList.find((x) => x.status === "pending")?.prompt ?? null;
  const roundNo = r?.no ?? Math.min(s.totalRounds - s.roundsRemaining + 1, s.totalRounds);
  const lastRound = s.roundsRemaining === 0;
  const pending = s.reviewCounts?.pending ?? 0;

  // ONE step at a time: what is happening, what to do, and the single button that does it.
  type Step = { title: string; hint: string; button?: { label: string; run: () => void; icon: React.ReactNode; disabled?: boolean; pulse?: boolean; variant?: "default" | "camera" } };
  const startNext = (label: string, actions: HostAction[]): Step["button"] => ({ label, run: () => void send(actions), icon: <Play aria-hidden="true" className="!size-6" />, pulse: true });
  const finish: Step["button"] = { label: "Finish game & show results", run: () => setConfirmFinish(true), icon: <Flag aria-hidden="true" className="!size-6" /> };
  let step: Step;
  if (s.phase === "lobby") {
    step = lastRound
      ? { title: "All rounds played", hint: "Finish the game to show the champion.", button: finish }
      : { title: `Ready for round ${roundNo}`, hint: "Press start: everyone sees a 5-second countdown, then the item.", button: startNext(`Start round ${roundNo}`, START_ROUND) };
  } else if (s.phase === "countdown") {
    // Only reached from an older screen or another tab: the 3-2-1 ran, the item isn't revealed yet.
    step = { title: "Countdown finished", hint: "Reveal the item to start the timer.", button: startNext("Reveal item & start", ["start_round"]) };
  } else if (s.phase === "active" && r && r.status === "open") {
    step = !started
      ? { title: "Get ready…", hint: "The countdown is on everyone's screen. The item appears at GO!" }
      : { title: "Players are hunting!", hint: "The hunt ends by itself when time runs out, or stop it now. Either way, you review the photos next.",
          button: { label: "Stop the hunt now", run: () => setConfirmStop(true), icon: <Square aria-hidden="true" className="!size-5" />, variant: "camera" } };
  } else if (s.phase === "active" && r) {
    step = { title: "Time's up", hint: "Check the photos to pick a winner.", button: { label: "Review photos", run: () => void send("move_to_review"), icon: <Hourglass aria-hidden="true" className="!size-6" /> } };
  } else if (s.phase === "reviewing") {
    const hint = s.submissionCount === 0 ? "No photos came in this round."
      : pending > 0 ? `Approve or disqualify each photo. The fastest approved photo wins.`
      : confirmation.kind === "winner" ? `All photos checked. ${confirmation.leader.nickname} is the fastest approved photo.`
      : "All photos checked, none approved.";
    step = {
      title: "Pick the winner", hint,
      // One button: check the photos while any are waiting, then announce.
      button: pending > 0
        ? { label: `Check photos (${pending} left)`, run: () => setShowPhotos(true), icon: <Camera aria-hidden="true" className="!size-6" /> }
        : { label: confirmation.kind === "winner" ? "Announce winner…" : "Announce no winner…", run: () => { setShowPhotos(false); setConfirmWinner(true); }, icon: <Trophy aria-hidden="true" className="!size-6" />, disabled: rows === null },
    };
  } else if (s.phase === "winner_announced" && r) {
    step = lastRound
      ? { title: r.winnerName ? `${r.winnerName} wins the last round!` : "No winner in the last round", hint: "That was the final round. Show everyone the results.", button: finish }
      : { title: r.winnerName ? `${r.winnerName} wins round ${r.no}!` : `No winner in round ${r.no}`, hint: "When everyone's ready, start the next round.", button: startNext(`Start round ${r.no + 1}`, ["next_round", ...START_ROUND]) };
  } else {
    step = { title: "Working…", hint: "Hang on a second." };
  }

  // Progress inside a round: Hunt → Review → Winner.
  const stages = ["Hunt", "Review", "Winner"];
  const stageNow = s.phase === "countdown" || (s.phase === "active" && r?.status === "open") ? 0
    : s.phase === "active" || s.phase === "reviewing" ? 1
    : s.phase === "winner_announced" ? 2 : -1;
  // Before a round starts (also on the winner screen), the host sees the item that round will reveal.
  const upNext = s.phase === "lobby" || (s.phase === "winner_announced" && !lastRound);
  const item = upNext ? nextItem : r?.prompt ?? nextItem;
  const showClock = s.phase === "active" && r?.status === "open";
  const onScreen = bringMeOnScreen(s);
  // Photos stopped but the result isn't official yet: the round can still be replayed (replay_round).
  const canReplay = Boolean(r && r.status === "closed" && !r.decided && (s.phase === "active" || s.phase === "reviewing"));

  const declare = async () => {
    const winnerId = confirmation.kind === "winner" ? confirmation.leader.playerId : null;
    const ok = await send("announce_winner", winnerId);
    setConfirmWinner(false);
    if (ok) void loadRows();
  };

  return (
    <div className="grid gap-6">
      <Card>
        <CardContent className="grid gap-4 p-4 sm:gap-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Badge variant="outline">Round {roundNo} of {s.totalRounds}</Badge>
            <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
              <span aria-hidden="true" className={cn("size-2.5 rounded-full", conn === "live" ? "bg-emerald-500" : conn === "offline" ? "bg-brand-coral" : "bg-brand-yellow")} />
              {connText[conn]}
            </span>
          </div>

          <ol aria-label="Round progress" className="grid grid-cols-3 gap-2">
            {stages.map((label, i) => (
              <li key={label} aria-current={i === stageNow ? "step" : undefined}
                className={cn("flex items-center justify-center gap-1.5 rounded-full px-2 py-1.5 text-sm font-semibold",
                  i < stageNow ? "bg-primary/10 text-primary" : i === stageNow ? "bg-brand-yellow text-brand-night" : "bg-secondary text-muted-foreground")}>
                <span aria-hidden="true">{i < stageNow ? "✓" : i + 1}</span> {label}
              </li>
            ))}
          </ol>

          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-3xl bg-secondary/60 p-4 sm:gap-4 sm:p-5">
            <div className="min-w-0">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">{upNext ? `Round ${s.phase === "lobby" ? roundNo : roundNo + 1} item · only you can see it` : "Bring me…"}</p>
                {item ? <ItemPrivacyToggle hidden={itemHidden} onToggle={toggleItem} className="-my-2" /> : null}
              </div>
              <p className="break-words font-display text-2xl font-bold leading-tight text-primary min-[400px]:text-3xl sm:text-4xl">{item ? <ItemText text={item} hidden={itemHidden} /> : "—"}</p>
              <p className="mt-1 text-sm font-semibold text-muted-foreground">
                {s.playerCount} {s.playerCount === 1 ? "player" : "players"}
                {r ? <> · {s.submissionCount} {s.submissionCount === 1 ? "photo" : "photos"} in</> : null}
              </p>
            </div>
            {showClock ? (
              <p className={cn("text-right font-mono text-4xl font-bold tabular-nums sm:text-5xl", started && timeLeft <= 10 ? "text-brand-coral-deep" : "text-foreground")}
                aria-label={started ? `${timeLeft} seconds left` : `Starts in ${secsToStart}`}>
                {started ? `${Math.floor(timeLeft / 60)}:${String(timeLeft % 60).padStart(2, "0")}` : secsToStart}
              </p>
            ) : null}
          </div>

          <div role="status" className="grid gap-1 text-center">
            <h2 className="break-words font-display text-xl font-bold sm:text-2xl">{step.title}</h2>
            <p className="text-sm text-muted-foreground sm:text-base">{step.hint}</p>
          </div>

          {wantRows && !(s.phase === "reviewing" && pending > 0) ? (
            <Button variant="secondary" className={cn(WRAP, "mx-auto w-full sm:w-auto")} onClick={() => setShowPhotos(true)}>
              <Camera aria-hidden="true" /> See photos ({rows?.length ?? s.submissionCount})
            </Button>
          ) : null}

          <p className="flex flex-wrap items-center justify-center gap-x-1.5 text-center text-sm text-muted-foreground">
            <MonitorPlay aria-hidden="true" className="size-4" /> Presenter screen: <span className="font-semibold text-foreground">{onScreen.title}</span>
          </p>

          {/* Pinned to the bottom of the scroll area, so the one button is always in reach (phones especially). */}
          <div className="sticky bottom-0 z-10 -mx-4 -mb-4 rounded-b-3xl bg-card px-4 pb-4 pt-3 shadow-[0_-8px_16px_-12px_rgb(0_0_0/0.25)] sm:-mx-6 sm:-mb-6 sm:px-6 sm:pb-6">
            <Button size="lg"
              className={cn(WRAP, "min-h-16 w-full text-lg sm:text-xl", step.button?.pulse && busy === null && "animate-pulse-soft motion-reduce:animate-none")}
              variant={step.button?.variant ?? "default"}
              disabled={!step.button || busy !== null || step.button.disabled} onClick={step.button?.run}>
              {step.button?.icon}{busy !== null ? "Working…" : step.button?.label ?? "Starting…"}
            </Button>
            {canReplay ? (
              <Button variant="ghost" className={cn(WRAP, "mt-2 w-full text-sm sm:text-base")} disabled={busy !== null} onClick={() => setConfirmReplay(true)}>
                <RotateCcw aria-hidden="true" /> Hunt ended too early? Replay this round
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Modal
        open={showPhotos && wantRows} onClose={() => setShowPhotos(false)} className="max-w-5xl"
        title={r?.prompt && !itemHidden ? `Does it show: ${r.prompt}?` : `Photos · round ${roundNo}`}
        description="Fastest first. Approve or reject each photo, or tap it to see it larger."
        footer={
          s.phase === "reviewing" && !locked ? (
            <>
              <Button variant="outline" className={FOOT} onClick={() => setShowPhotos(false)}>Close</Button>
              <Button className={FOOT} disabled={busy !== null || rows === null} onClick={() => { setShowPhotos(false); setConfirmWinner(true); }}>
                <Trophy aria-hidden="true" /> {confirmation.kind === "winner" ? "Announce winner…" : "Announce no winner…"}
              </Button>
            </>
          ) : <Button variant="outline" className={FOOT} onClick={() => setShowPhotos(false)}>Close</Button>
        }
      >
        <PhotoReviewGrid rows={rows} locked={locked} busyId={busyId} error={rowsError} onReview={review} onOpen={(x) => setViewing(x.submissionId)} />
      </Modal>

      <div className="grid gap-3">
        <Fold icon={<Users aria-hidden="true" className="size-5 text-primary" />} title="Players" meta={String(s.playerCount)}>
          {players.length === 0 ? (
            <p className="flex items-center gap-2 text-muted-foreground"><Hourglass aria-hidden="true" className="size-4" /> No players.</p>
          ) : (
            <ul className="flex flex-wrap gap-2" aria-label="Players">
              {players.map((p) => <li key={p.id} className="rounded-full bg-secondary px-4 py-1.5 font-display font-semibold text-secondary-foreground">{p.nickname}</li>)}
            </ul>
          )}
          <p className="mt-3 text-xs text-muted-foreground">New players can&apos;t join once the game has started.</p>
        </Fold>

        {s.totalRounds < maxRounds ? (
          <Fold icon={<Plus aria-hidden="true" className="size-5 text-primary" />} title="Add another round" meta={`${s.totalRounds} of ${maxRounds}`}>
            <form onSubmit={(e) => void addRound(e)} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
              <div className="grid gap-1.5">
                <label htmlFor="add-round" className="text-sm font-semibold">What should players bring?</label>
                <Input id="add-round" value={newItem} maxLength={200} onChange={(e) => setNewItem(e.target.value)} placeholder="Something blue" />
              </div>
              <Button type="submit" disabled={adding || newItem.trim() === ""}><Plus aria-hidden="true" />{adding ? "Adding…" : "Add round"}</Button>
            </form>
            <p className="mt-2 text-xs text-muted-foreground">It plays after the current rounds.</p>
          </Fold>
        ) : null}

        <div className="flex justify-end">
          <Button variant="ghost" className="text-destructive hover:bg-destructive/10" disabled={busy !== null} onClick={() => setConfirmEnd(true)}>End game now</Button>
        </div>
      </div>

      <PhotoViewer row={viewingRow} rows={rows ?? []} locked={locked} busy={busyId !== null} prompt={itemHidden ? null : r?.prompt ?? null} onClose={() => setViewing(null)} onReview={review} onNavigate={(x) => setViewing(x.submissionId)} />

      <Modal
        open={confirmWinner} onClose={() => setConfirmWinner(false)}
        title={confirmation.kind === "winner" ? "Announce the winner?" : "Announce no winner?"}
        description="This is final: the round's result can't be changed afterwards."
        footer={
          <>
            <Button variant="outline" className={FOOT} onClick={() => setConfirmWinner(false)} disabled={busy !== null}>Keep reviewing</Button>
            <Button className={FOOT} onClick={declare} disabled={busy !== null}>
              {busy === "announce_winner" ? "Announcing…" : confirmation.kind === "winner" ? `Yes, announce ${confirmation.leader.nickname}` : "Yes, no winner"}
            </Button>
          </>
        }
      >
        {confirmation.kind === "winner" ? (
          <div className="grid gap-3">
            <div className="flex min-w-0 items-center gap-3 rounded-2xl bg-brand-yellow/25 p-3">
              {rows?.find((x) => x.playerId === confirmation.leader.playerId)?.photoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={rows.find((x) => x.playerId === confirmation.leader.playerId)!.photoUrl!} alt={`Photo from ${confirmation.leader.nickname}`} className="size-20 rounded-xl bg-black object-cover" />
              ) : null}
              <div className="min-w-0">
                <p className="break-words font-display text-2xl font-bold text-primary">{confirmation.leader.nickname}</p>
                <p className="font-mono text-xl font-bold tabular-nums">{formatElapsed(confirmation.leader.rankMs)}</p>
                <p className="text-sm text-muted-foreground">Fastest approved photo</p>
              </div>
            </div>
            {confirmation.flagged ? <p className="rounded-xl bg-brand-coral/15 px-3 py-2 text-sm font-semibold text-brand-coral-deep">This time is the server&apos;s own measurement because the player&apos;s reported time didn&apos;t add up.</p> : null}
            {confirmation.closeContenders.length ? (
              <div className="rounded-xl bg-brand-yellow/30 px-3 py-2 text-sm text-brand-night" role="alert">
                <p className="font-semibold">Close finish: within 150 ms of</p>
                <ul className="list-inside list-disc">
                  {confirmation.closeContenders.map((c) => <li key={c.playerId}>{c.nickname}, {formatElapsed(c.rankMs)} ({statusLabel[c.status].toLowerCase()})</li>)}
                </ul>
                <p className="mt-1">Open the photos to compare before you confirm.</p>
              </div>
            ) : null}
            {confirmation.pending ? <p className="rounded-xl bg-secondary px-3 py-2 text-sm">{confirmation.pending} photo{confirmation.pending === 1 ? " is" : "s are"} still waiting for review. Only approved photos can win.</p> : null}
          </div>
        ) : (
          <p className="rounded-xl bg-secondary px-3 py-2 text-sm">
            No photo is approved{confirmation.pending ? `, and ${confirmation.pending} still need${confirmation.pending === 1 ? "s" : ""} review` : ""}. Approve a valid photo first if there should be a winner.
          </p>
        )}
      </Modal>

      <ConfirmDialog
        open={confirmReplay} busy={busy !== null} destructive={false}
        title={`Replay round ${r?.no ?? ""}?`} confirmLabel="Replay round"
        description={`Everyone gets a new countdown and the full time to bring ${r?.prompt ? `“${r.prompt}”` : "the same item"}. Photos from the ended hunt are set aside, and it counts as no winner. It doesn't use up a round on your plan.`}
        onClose={() => setConfirmReplay(false)} onConfirm={() => void replay()}
      />
      <ConfirmDialog
        open={confirmStop && roundOpen} busy={busy !== null} destructive={false}
        title="Stop the hunt now?" confirmLabel="Stop the hunt"
        description={`Players can't send photos after this${started && timeLeft > 0 ? ` (${Math.floor(timeLeft / 60)}:${String(timeLeft % 60).padStart(2, "0")} was still left)` : ""}. You'll review the photos next.`}
        onClose={() => setConfirmStop(false)}
        onConfirm={async () => { setConfirmStop(false); await send(STOP_AND_REVIEW); }}
      />
      <ConfirmDialog
        open={confirmFinish} busy={busy !== null} destructive={false}
        title="Finish the game?" confirmLabel="Finish & show results"
        description="Everyone sees the final results and the champion. The game can't be played after this."
        onClose={() => setConfirmFinish(false)}
        onConfirm={async () => { await send("end_game"); setConfirmFinish(false); }}
      />
      <ConfirmDialog
        open={confirmEnd} busy={busy !== null} title="End the game now?" confirmLabel="End game"
        description="The game stops for everyone and players are told it's over. This can't be undone."
        onClose={() => setConfirmEnd(false)}
        onConfirm={async () => { await send("end_game"); setConfirmEnd(false); }}
      />
    </div>
  );
}

/** A collapsed section, so the main step stays the only thing competing for attention. */
function Fold({ icon, title, meta, children }: { icon: React.ReactNode; title: string; meta?: string; children: React.ReactNode }) {
  return (
    <details className="group rounded-3xl border bg-card shadow-card">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-3xl px-5 py-4 font-display text-lg font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-2">{icon}{title}</span>
        <span className="flex items-center gap-2 text-base text-muted-foreground">
          {meta}<ChevronDown aria-hidden="true" className="size-5 transition-transform group-open:rotate-180 motion-reduce:transition-none" />
        </span>
      </summary>
      <div className="px-5 pb-5">{children}</div>
    </details>
  );
}
