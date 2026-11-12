"use client";

import { Clock, Expand, Grid3x3, ListOrdered, Minimize, Pencil, Play, Trophy, Users, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { BoardPreview } from "@/components/bingosnap/board-preview";
import { Backdrop } from "@/components/brand/backdrop";
import { CopyField } from "@/components/game/copy-button";
import { useGameSync } from "@/components/game/use-game-sync";
import { Badge } from "@/components/ui/badge";
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
  initial, joinUrl, qr, siteUrlConfigured,
}: { initial: BingoHostSnapshot; joinUrl: string; qr: ReactNode; siteUrlConfigured: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const stage = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [busy, setBusy] = useState<null | string>(null);
  const [confirm, setConfirm] = useState<null | { kind: "cancel" } | { kind: "kick"; player: Player }>(null);
  const gameId = initial.gameId;

  const { state: s, applyState, resync } = useGameSync<BingoHostSnapshot>({
    gameId, role: "host", initial, fetchSnapshot: () => fetchBingoHostSnapshot(gameId),
  });
  // Started or cancelled (here or in another tab): the server picks the right screen.
  useEffect(() => { if (s.status !== "lobby") router.refresh(); }, [s.status, router]);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === stage.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await stage.current?.requestFullscreen();
    } catch {
      toast("Fullscreen isn't available in this browser.", "error");
    }
  };

  const players = s.players.filter((p) => p.state === "active");
  const count = players.length;
  const full = count >= s.maxPlayers;
  const seen = useRef(new Set(initial.players.map((p) => p.id)));
  useEffect(() => { for (const p of players) seen.current.add(p.id); });
  const chips = fullscreen ? players : players.slice(0, 14);

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
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      {/* Presentation stage: this element goes fullscreen */}
      <div
        ref={stage}
        className={cn(
          "relative isolate overflow-hidden bg-gradient-to-b from-primary to-brand-night text-white",
          fullscreen ? "h-viewport flex flex-col justify-center rounded-none p-[3dvh]" : "rounded-4xl p-6 sm:p-10",
        )}
      >
        <Backdrop />
        <div className={cn("flex w-full items-center justify-between gap-3", fullscreen && "absolute inset-x-0 top-0 p-6")}>
          <Badge variant="yellow">Lobby open</Badge>
          <Button type="button" variant="outline-light" size="sm" onClick={toggleFullscreen}>
            {fullscreen ? <Minimize aria-hidden="true" /> : <Expand aria-hidden="true" />}
            {fullscreen ? "Exit fullscreen" : "Present fullscreen"}
          </Button>
        </div>

        <div className={cn("flex flex-col items-center text-center", fullscreen ? "gap-[2.5dvh]" : "mt-2 gap-5")}>
          <h2 className={cn("break-words font-display font-bold", fullscreen ? "text-[clamp(2.25rem,6dvh,4rem)] leading-tight" : "text-3xl")}>{s.title}</h2>
          <p className={cn("text-white/90", fullscreen ? "text-[clamp(1.125rem,3dvh,1.75rem)]" : "text-lg")}>
            Scan to join · {b.winMode === "traditional" ? "Traditional Bingo" : "Full Card"} · {b.size}×{b.size}
          </p>

          <div className={cn("relative", fullscreen ? "w-[min(46dvh,80vw)]" : "w-full max-w-xs sm:max-w-sm")}>
            <span aria-hidden="true" className="absolute -inset-3 animate-ping-soft rounded-[2rem] border-2 border-brand-yellow/40 motion-reduce:hidden" />
            {["-left-3 -top-3 rounded-tl-3xl border-l-4 border-t-4", "-right-3 -top-3 rounded-tr-3xl border-r-4 border-t-4", "-bottom-3 -left-3 rounded-bl-3xl border-b-4 border-l-4", "-bottom-3 -right-3 rounded-br-3xl border-b-4 border-r-4"].map((c) => (
              <span key={c} aria-hidden="true" className={cn("absolute size-10 border-brand-yellow", c)} />
            ))}
            <div className="rounded-3xl bg-white p-4 shadow-pop">{qr}</div>
          </div>

          <div>
            <p className={cn("mb-2 font-semibold uppercase tracking-widest text-white/80", fullscreen ? "text-[clamp(1rem,2.2dvh,1.25rem)]" : "text-sm")}>Room code</p>
            <p role="img" aria-label={`Room code ${s.joinCode.split("").join(" ")}`} className="flex justify-center gap-1.5 sm:gap-2">
              {s.joinCode.split("").map((ch, i) => (
                <span key={i} aria-hidden="true" className={cn("grid place-items-center rounded-xl bg-white font-display font-bold text-primary shadow-pop", fullscreen ? "size-[min(5rem,9dvh)] text-[min(3.75rem,6.5dvh)]" : "size-11 text-3xl sm:size-14 sm:text-4xl")}>{ch}</span>
              ))}
            </p>
          </div>
          <p className={cn("break-all font-mono text-white/80", fullscreen ? "text-[clamp(1rem,2.2dvh,1.25rem)]" : "text-sm")}>{joinUrl}</p>

          <div className="grid justify-items-center gap-3">
            <p className={cn("font-display font-semibold", fullscreen ? "text-[clamp(1.5rem,4dvh,2.25rem)]" : "text-xl")} aria-live="polite">
              <span key={count} className="inline-block animate-pop-in text-brand-yellow motion-reduce:animate-none">{count}</span> of {s.maxPlayers} {s.maxPlayers === 1 ? "player" : "players"} joined
            </p>
            {count > 0 ? (
              <ul className="flex max-w-5xl flex-wrap justify-center gap-2" aria-label="Players in the lobby">
                {chips.map((p) => (
                  <li key={p.id} className={cn("rounded-full bg-white/15 px-4 py-1.5 font-display font-semibold", fullscreen ? "text-[clamp(1.125rem,2.8dvh,1.75rem)]" : "text-base", !seen.current.has(p.id) && "animate-join-in motion-reduce:animate-none")}>{p.nickname}</li>
                ))}
                {count > chips.length ? <li className="rounded-full bg-white/10 px-4 py-1.5 font-display font-semibold text-white/80">+{count - chips.length} more</li> : null}
              </ul>
            ) : (
              <p className="text-white/75">Waiting for the first player…</p>
            )}
          </div>
        </div>
      </div>

      {/* Host controls */}
      <div className="grid content-start gap-6">
        <Card>
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
                Waiting for players. Ask everyone to scan the QR code or enter the room code at <span className="font-semibold">/play</span>.
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
