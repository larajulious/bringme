"use client";

import { Clock, Grid3x3, ListOrdered, Pencil, Play, Trophy, Users, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { BoardPreview } from "@/components/bingosnap/board-preview";
import { bingoOnScreen } from "@/components/bingosnap/on-screen";
import { OnScreenNow } from "@/components/game/on-screen-now";
import { CopyField } from "@/components/game/copy-button";
import { useGameSync } from "@/components/game/use-game-sync";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { formatMinutes } from "@/lib/bingosnap/board";
import type { BingoHostSnapshot } from "@/lib/bingosnap/types";
import type { FetchResult } from "@/lib/game/sync";
import { cn } from "@/lib/utils";

export const startErrors: Record<string, string> = {
  no_players: "Wait for at least one player to join before starting.",
  player_limit_exceeded: "More players joined than your current Game Pass allows. Remove some players, or upgrade your pass.",
  subscription_required: "Your Game Pass isn't active, so this game can't start. Choose a 7-Day Game Pass to continue.",
  board_incomplete: "Every square needs an instruction before the game can start. Edit the card first.",
  duplicate_challenge: "Two squares have the same instruction. Edit the card first.",
  invalid_transition: "This game can't be started from its current state.",
  network: "Can't reach the server. Check your connection and try again.",
};

export async function fetchBingoHostSnapshot(gameId: string): Promise<FetchResult<BingoHostSnapshot>> {
  const r = await fetch(`/api/host/bingosnap/${gameId}`, { cache: "no-store" }).catch(() => null);
  if (!r) return { status: "error" };
  if (r.status === 401) return { status: "unauthorized" };
  if (!r.ok) return { status: "error" };
  return { status: "ok", state: (await r.json()) as BingoHostSnapshot };
}

async function post(url: string, body?: object): Promise<{ ok: true; state?: BingoHostSnapshot } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, { method: "POST", headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    const json = (await res.json().catch(() => ({}))) as { state?: BingoHostSnapshot; error?: string };
    return res.ok ? { ok: true, state: json.state } : { ok: false, error: json.error ?? "request_failed" };
  } catch {
    return { ok: false, error: "network" };
  }
}

type Player = BingoHostSnapshot["players"][number];

/**
 * The BingoSnap waiting lobby for the host: a stage to project (QR, room code, link, arrivals),
 * the participant list with removal, n / cap from the Game Pass, and Start game.
 * Joins arrive as Realtime hints; the snapshot is always re-read from the server.
 */
export function BingoHostLobby({
  initial, joinUrl, siteUrlConfigured,
}: { initial: BingoHostSnapshot; joinUrl: string; siteUrlConfigured: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState<null | string>(null);
  const [confirm, setConfirm] = useState<null | { kind: "cancel" } | { kind: "kick"; player: Player }>(null);
  const gameId = initial.gameId;

  const { state: s, applyState, resync } = useGameSync<BingoHostSnapshot>({
    gameId, role: "host", initial, fetchSnapshot: () => fetchBingoHostSnapshot(gameId),
  });
  // Started or cancelled (here or in another tab): the server picks the right screen.
  useEffect(() => { if (s.status !== "lobby") router.refresh(); }, [s.status, router]);

  const players = s.players.filter((p) => p.state === "active");
  const count = players.length;
  const full = count >= s.maxPlayers;
  const seen = useRef(new Set(initial.players.map((p) => p.id)));
  useEffect(() => { for (const p of players) seen.current.add(p.id); });

  const start = async () => {
    setBusy("start");
    let r = await post(`/api/host/bingosnap/${gameId}/start`, { expectedVersion: s.version });
    if (!r.ok && r.error === "stale_state") {
      // Usually just a player joining meanwhile: retry once if the game is still waiting in the lobby.
      const fresh = await fetchBingoHostSnapshot(gameId);
      if (fresh.status === "ok") {
        applyState(fresh.state);
        if (fresh.state.status === "lobby") r = await post(`/api/host/bingosnap/${gameId}/start`, { expectedVersion: fresh.state.version });
      }
    }
    setBusy(null);
    if (!r.ok) {
      resync();
      return toast(startErrors[r.error] ?? "Something went wrong. Please try again.", "error");
    }
    if (r.state) applyState(r.state);
    toast("Game started! 3, 2, 1…", "success");
    router.refresh();
  };

  const kick = async (p: Player) => {
    setBusy(p.id);
    const r = await post(`/api/host/games/${gameId}/players/${p.id}/remove`);
    setBusy(null);
    setConfirm(null);
    if (!r.ok) return toast("Couldn't remove that player. Please try again.", "error");
    toast(`${p.nickname} removed`, "success");
    resync();
  };

  const cancel = async () => {
    setBusy("cancel");
    const r = await post(`/api/host/bingosnap/${gameId}/transition`, { action: "cancel", expectedVersion: s.version });
    setBusy(null);
    setConfirm(null);
    if (!r.ok) {
      resync();
      return toast(r.error === "stale_state" ? "The game just changed. Check it and try again." : "We couldn't cancel the game. Please try again.", "error");
    }
    toast("Game cancelled", "success");
    router.refresh();
  };

  const b = s.board;
  return (
    <div className="grid gap-6">
      <OnScreenNow screen={bingoOnScreen(s, false, false)} />

      {/* Host controls */}
      <div className="grid content-start gap-6 lg:grid-cols-2 lg:items-start">
        <Card className="lg:row-span-2">
          <CardHeader>
            <CardTitle className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2"><Users aria-hidden="true" className="size-5 text-primary" /> Players</span>
              <span className="text-base font-semibold text-muted-foreground" aria-label={`${count} of ${s.maxPlayers} players`}>{count} / {s.maxPlayers}</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            {full ? (
              <div role="status" className="rounded-2xl border border-brand-coral/40 bg-brand-coral/10 px-4 py-3 text-sm">
                <p className="font-semibold text-foreground">Player limit reached ({count}/{s.maxPlayers})</p>
                <p className="text-muted-foreground">New players can&apos;t join this room. A bigger Game Pass raises the limit right away.</p>
                <Link href="/dashboard/subscription#plans" className="mt-1 inline-block font-semibold text-primary underline underline-offset-4">Upgrade your Game Pass</Link>
              </div>
            ) : null}
            {count === 0 ? (
              <p className="rounded-2xl border-2 border-dashed border-primary/25 px-4 py-6 text-center text-muted-foreground">
                Waiting for players. Ask everyone to scan the QR code on the presenter screen, or enter the room code at <span className="font-semibold">/play</span>.
              </p>
            ) : (
              <ul className="grid max-h-60 gap-2 overflow-y-auto" aria-label="Joined players">
                {players.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2 rounded-2xl bg-secondary px-4 py-1.5">
                    <span className="truncate font-display text-lg font-semibold text-secondary-foreground">{p.nickname}</span>
                    <Button type="button" size="icon" variant="ghost" aria-label={`Remove ${p.nickname}`} disabled={busy !== null} onClick={() => setConfirm({ kind: "kick", player: p })}>
                      <X aria-hidden="true" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <Button
              size="lg"
              className={cn("h-20 w-full text-2xl", count > 0 && busy === null && "animate-pulse-soft motion-reduce:animate-none")}
              disabled={count === 0 || busy !== null}
              onClick={start}
            >
              <Play aria-hidden="true" className="!size-7" /> {busy === "start" ? "Starting…" : "Start game"}
            </Button>
            <p className="-mt-2 text-center text-sm text-muted-foreground">
              {count === 0 ? "You can start once someone has joined." : "Starting closes the lobby, then a 3-second countdown opens the hunt."}
            </p>
            <Button variant="ghost" className="text-destructive hover:bg-destructive/10" disabled={busy !== null} onClick={() => setConfirm({ kind: "cancel" })}>
              Cancel game
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between gap-3">
              <span>The card</span>
              <Button asChild variant="outline" size="sm"><Link href={`/dashboard/extra-fun/bingosnap/${gameId}/edit`}><Pencil aria-hidden="true" /> Edit card</Link></Button>
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <BoardPreview size={b.size} className="mx-auto w-full max-w-[18rem]" label="Your card" cells={(s.cells ?? []).map((c) => ({ challenge: c.challenge, isFree: c.isFree }))} />
            <dl className="grid gap-2 text-sm">
              <div className="flex items-center justify-between gap-3"><dt className="flex items-center gap-2 text-muted-foreground"><Grid3x3 aria-hidden="true" className="size-4" /> Mode</dt><dd className="font-semibold">{b.winMode === "traditional" ? "Traditional Bingo" : "Full Card"}</dd></div>
              <div className="flex items-center justify-between gap-3"><dt className="flex items-center gap-2 text-muted-foreground">{b.winnerRule === "ranked" ? <ListOrdered aria-hidden="true" className="size-4" /> : <Trophy aria-hidden="true" className="size-4" />} Winners</dt><dd className="font-semibold">{b.winnerRule === "ranked" ? "Ranked list" : "First wins"}</dd></div>
              <div className="flex items-center justify-between gap-3"><dt className="flex items-center gap-2 text-muted-foreground"><Clock aria-hidden="true" className="size-4" /> Timer</dt><dd className="font-semibold">{formatMinutes(Math.round(b.durationSeconds / 60))}</dd></div>
            </dl>
            <p className="text-sm text-muted-foreground">Players see the instructions only once the game starts, each in their own order.</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Invite players</CardTitle></CardHeader>
          <CardContent className="grid gap-3">
            <CopyField value={joinUrl} label="Join link" />
            <CopyField value={s.joinCode} label="Room code" />
            {!siteUrlConfigured ? (
              <p role="note" className="rounded-2xl bg-brand-yellow/30 px-4 py-3 text-sm font-semibold text-brand-night">
                Heads up: <code>NEXT_PUBLIC_SITE_URL</code> isn&apos;t set, so this link may not work from other devices.
              </p>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <ConfirmDialog
        open={confirm?.kind === "kick"} busy={busy !== null}
        title={confirm?.kind === "kick" ? `Remove ${confirm.player.nickname}?` : "Remove player?"}
        description="They'll be removed from the lobby and signed out of this game."
        confirmLabel="Remove" onClose={() => setConfirm(null)}
        onConfirm={() => confirm?.kind === "kick" && kick(confirm.player)}
      />
      <ConfirmDialog
        open={confirm?.kind === "cancel"} busy={busy !== null} title="Cancel this game?" confirmLabel="Cancel game"
        description="The lobby closes and players can no longer join. This can't be undone."
        onClose={() => setConfirm(null)} onConfirm={cancel}
      />
    </div>
  );
}
