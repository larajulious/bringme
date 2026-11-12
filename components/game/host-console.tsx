"use client";

import { Flag, Hourglass, Play, Trophy, Users } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { FinishedResults } from "@/components/game/finished-results";
import { fetchHostSnapshot, fetchRoster, phaseKey, runAction } from "@/components/game/host-api";
import { PhotoViewer } from "@/components/game/photo-viewer";
import { OnScreenNow, bringMeOnScreen } from "@/components/game/on-screen-now";
import { ReviewPanel, type Decision, type LiveSubmission } from "@/components/game/review-panel";
import { useGameSync, type Conn } from "@/components/game/use-game-sync";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { describeConfirmation, statusLabel } from "@/lib/game/review";
import { formatElapsed } from "@/lib/game/timing";
import type { GamePhase, HostAction, HostSnapshot } from "@/lib/game/types";
import { cn } from "@/lib/utils";

const phaseLabel: Record<GamePhase, string> = {
  lobby: "Waiting", countdown: "Countdown", active: "Round live", reviewing: "Reviewing", winner_announced: "Winner announced", finished: "Finished",
};
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
  network: "Can't reach the server. Check your connection.",
  game_not_found: "This game no longer exists.",
};
const connText: Record<Conn, string> = { connecting: "Connecting…", live: "Live", basic: "Live (basic mode)", reconnecting: "Reconnecting…", offline: "Offline" };

type Row = LiveSubmission;

export function HostConsole({ gameId, initial, initialPlayers }: { gameId: string; initial: HostSnapshot; initialPlayers: { id: string; nickname: string }[] }) {
  const { toast } = useToast();
  const { state: s, conn, offsetMs, applyState, resync } = useGameSync<HostSnapshot>({
    gameId, role: "host", initial, fetchSnapshot: () => fetchHostSnapshot(gameId),
  });
  const [busy, setBusy] = useState<HostAction | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [confirmWinner, setConfirmWinner] = useState(false);
  const [players, setPlayers] = useState(initialPlayers);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [rowsError, setRowsError] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void fetchRoster(gameId).then((r) => { if (live && r) setPlayers(r); });
    return () => { live = false; };
  }, [gameId, s.version]);

  // Live submissions: re-read on every state change (a new photo or review decision bumps the version).
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
  useEffect(() => {
    if (wantRows) void loadRows(); else { setRows(null); }
  }, [wantRows, s.version, s.round?.id, loadRows]);

  const send = async (action: HostAction, winner?: string | null) => {
    setBusy(action);
    const { result, changedUnderneath } = await runAction(gameId, action, s.version, phaseKey(s), winner);
    setBusy(null);
    if (result.ok) { applyState(result.state); return true; }
    if (changedUnderneath) applyState(changedUnderneath); else resync();
    if (result.error === "winner_mismatch") void loadRows();
    toast(errorCopy[result.error] ?? "Something went wrong. Please try again.", "error");
    return false;
  };

  const review = async (submissionId: string, decision: Decision) => {
    setBusyId(submissionId);
    const res = await fetch(`/api/host/games/${gameId}/submissions/${submissionId}/review`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision }),
    }).catch(() => null);
    setBusyId(null);
    if (res?.ok) {
      const { state } = (await res.json()) as { state: HostSnapshot };
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
  const nextNo = s.totalRounds - s.roundsRemaining + (s.phase === "lobby" ? 1 : 0);
  const started = r?.openedAt ? Date.now() + offsetMs >= Date.parse(r.openedAt) : false;
  const viewingRow = rows?.find((x) => x.submissionId === viewing) ?? null;

  if (s.status === "finished" || s.status === "canceled") return <FinishedResults gameId={gameId} initial={s} />;

  const primary = (label: string, action: HostAction, opts: { disabled?: boolean; icon?: React.ReactNode; onClick?: () => void } = {}) => (
    <Button size="lg" className="h-16 w-full text-xl sm:w-auto sm:px-8" disabled={busy !== null || opts.disabled} onClick={opts.onClick ?? (() => void send(action))}>
      {opts.icon}{busy === action ? "Working…" : label}
    </Button>
  );
  const finishBtn = primary("Finish game", "end_game", { icon: <Flag aria-hidden="true" className="!size-6" /> });

  let actions: React.ReactNode = null;
  if (s.phase === "lobby") actions = s.roundsRemaining > 0 ? primary("Start countdown", "start_countdown", { icon: <Play aria-hidden="true" className="!size-6" /> }) : finishBtn;
  else if (s.phase === "countdown") actions = primary("Start round", "start_round", { icon: <Play aria-hidden="true" className="!size-6" /> });
  else if (s.phase === "active" && r) actions = r.status === "open" ? primary("Close submissions", "close_submissions", { disabled: !started }) : primary("Move to review", "move_to_review");
  else if (s.phase === "reviewing") {
    actions = primary(confirmation.kind === "winner" ? "Declare winner…" : "Declare no winner…", "announce_winner", {
      icon: <Trophy aria-hidden="true" className="!size-6" />, onClick: () => setConfirmWinner(true), disabled: rows === null,
    });
  } else if (s.phase === "winner_announced") actions = s.roundsRemaining > 0 ? primary("Next round", "next_round", { icon: <Play aria-hidden="true" className="!size-6" /> }) : finishBtn;

  const nextOnScreen: Record<string, string> = {
    start_countdown: "Shows the 3-2-1 countdown.",
    start_round: "Reveals the item and starts the timer.",
    close_submissions: "Shows “Time's up” and stops new photos.",
    move_to_review: "Shows “Judging time!”.",
    announce_winner: "Reveals the winner (or no winner) to everyone.",
    next_round: "Shows “Get ready!” for the next round.",
    end_game: "Shows the final results.",
  };
  const stepAction: HostAction | null =
    s.phase === "lobby" ? (s.roundsRemaining > 0 ? "start_countdown" : "end_game")
    : s.phase === "countdown" ? "start_round"
    : s.phase === "active" && r ? (r.status === "open" ? "close_submissions" : "move_to_review")
    : s.phase === "reviewing" ? "announce_winner"
    : s.phase === "winner_announced" ? (s.roundsRemaining > 0 ? "next_round" : "end_game")
    : null;

  const declare = async () => {
    const winnerId = confirmation.kind === "winner" ? confirmation.leader.playerId : null;
    const ok = await send("announce_winner", winnerId);
    setConfirmWinner(false);
    if (ok) void loadRows();
  };

  return (
    <div className="grid gap-6">
      <Card>
        <CardContent className="grid gap-4 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3" role="status">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{r ? `Round ${r.no} of ${s.totalRounds}` : `Round ${Math.min(nextNo, s.totalRounds)} of ${s.totalRounds}`}</Badge>
              <Badge variant="yellow">{phaseLabel[s.phase]}</Badge>
            </div>
            <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
              <span aria-hidden="true" className={cn("size-2.5 rounded-full", conn === "live" ? "bg-emerald-500" : conn === "offline" ? "bg-brand-coral" : "bg-brand-yellow")} />
              {connText[conn]}
            </span>
          </div>

          <OnScreenNow screen={bringMeOnScreen(s)} className="border-0 bg-secondary/60 shadow-none" />

          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <div className="grid grid-cols-3 gap-3">
              <Stat label="Item to bring" value={r?.prompt ?? "—"} />
              <Stat label="Players" value={String(s.playerCount)} />
              <Stat label="Photos in" value={String(s.submissionCount)} />
            </div>
            <div className="grid justify-items-stretch gap-1.5 sm:justify-items-end">
              <div className="flex flex-wrap gap-3">{actions}</div>
              {stepAction ? <p className="text-sm text-muted-foreground sm:text-right">Next on screen: {nextOnScreen[stepAction]}</p> : null}
            </div>
          </div>
        </CardContent>
      </Card>

      {wantRows ? (
        <ReviewPanel rows={rows} counts={s.reviewCounts} locked={locked} busyId={busyId} error={rowsError} onReview={review} onOpen={(x) => setViewing(x.submissionId)} />
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1fr_auto]">
        <Card className="content-start">
          <CardHeader>
            <CardTitle className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2"><Users aria-hidden="true" className="size-5 text-primary" /> Players</span>
              <span className="text-base font-semibold text-muted-foreground">{s.playerCount}</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {players.length === 0 ? (
              <p className="flex items-center gap-2 text-muted-foreground"><Hourglass aria-hidden="true" className="size-4" /> No players.</p>
            ) : (
              <ul className="flex flex-wrap gap-2" aria-label="Players">
                {players.map((p) => <li key={p.id} className="rounded-full bg-secondary px-4 py-1.5 font-display font-semibold text-secondary-foreground">{p.nickname}</li>)}
              </ul>
            )}
            <p className="mt-3 text-xs text-muted-foreground">New players can&apos;t join once the game has started.</p>
          </CardContent>
        </Card>
        <div className="self-end">
          <Button variant="ghost" className="text-destructive hover:bg-destructive/10" disabled={busy !== null} onClick={() => setConfirmEnd(true)}>End game now</Button>
        </div>
      </div>

      <PhotoViewer row={viewingRow} rows={rows ?? []} locked={locked} busy={busyId !== null} prompt={r?.prompt ?? null} onClose={() => setViewing(null)} onReview={review} onNavigate={(x) => setViewing(x.submissionId)} />

      <Modal
        open={confirmWinner} onClose={() => setConfirmWinner(false)}
        title={confirmation.kind === "winner" ? "Announce the winner?" : "Announce no winner?"}
        description="This is final: the round's result can't be changed afterwards."
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirmWinner(false)} disabled={busy !== null}>Keep reviewing</Button>
            <Button onClick={declare} disabled={busy !== null}>
              {busy === "announce_winner" ? "Announcing…" : confirmation.kind === "winner" ? `Yes, announce ${confirmation.leader.nickname}` : "Yes, no winner"}
            </Button>
          </>
        }
      >
        {confirmation.kind === "winner" ? (
          <div className="grid gap-3">
            <div className="flex items-center gap-3 rounded-2xl bg-brand-yellow/25 p-3">
              {rows?.find((x) => x.playerId === confirmation.leader.playerId)?.photoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={rows.find((x) => x.playerId === confirmation.leader.playerId)!.photoUrl!} alt={`Photo from ${confirmation.leader.nickname}`} className="size-20 rounded-xl bg-black object-cover" />
              ) : null}
              <div>
                <p className="font-display text-2xl font-bold text-primary">{confirmation.leader.nickname}</p>
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
        open={confirmEnd} busy={busy !== null} title="End the game now?" confirmLabel="End game"
        description="The game stops for everyone and players are told it's over. This can't be undone."
        onClose={() => setConfirmEnd(false)}
        onConfirm={async () => { await send("end_game"); setConfirmEnd(false); }}
      />
    </div>
  );
}

function Stat({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={cn("min-w-0", wide && "lg:col-span-1")}>
      <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">{label}</p>
      <p className="truncate font-display text-xl font-bold text-primary" title={value}>{value}</p>
    </div>
  );
}
