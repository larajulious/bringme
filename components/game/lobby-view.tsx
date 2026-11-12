"use client";

import { Expand, Minimize, Play, Users, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Backdrop } from "@/components/brand/backdrop";
import { fetchHostSnapshot, fetchRoster, phaseKey, runAction } from "@/components/game/host-api";
import { useGameSync } from "@/components/game/use-game-sync";
import type { HostSnapshot } from "@/lib/game/types";
import { CopyField } from "@/components/game/copy-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

export type LobbyPlayer = { id: string; nickname: string };

const apiErrors: Record<string, string> = {
  no_players: "Wait for at least one player to join before starting.",
  player_limit_exceeded: "Player limit reached: more players joined than your current Game Pass allows. Remove some players, or upgrade your pass.",
  subscription_required: "Pass expired: your Game Pass isn't active, so this game can't start. Choose a 7-Day Game Pass to continue.",
  invalid_game_transition: "This game can't be started from its current state.",
};

/**
 * Lobby for projecting on a big screen. `qr` is a server-rendered SVG passed in
 * as a child, so no QR code logic ships to the browser.
 * Player list refreshes by polling the server every few seconds (Realtime comes later).
 */
export function LobbyView({
  gameId, title, code, joinUrl, maxPlayers, roundCount, items, players: initialPlayers, qr, siteUrlConfigured, initialState,
}: {
  gameId: string; title: string; code: string; joinUrl: string; maxPlayers: number; roundCount: number; items: string[];
  players: LobbyPlayer[]; qr: ReactNode; siteUrlConfigured: boolean; initialState: HostSnapshot;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const stage = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [busy, setBusy] = useState<null | "start" | "cancel" | string>(null);
  const [confirm, setConfirm] = useState<null | { kind: "cancel" } | { kind: "kick"; player: LobbyPlayer }>(null);

  // Realtime hints + authoritative re-reads (no fixed-interval polling here).
  const { state, applyState, resync } = useGameSync<HostSnapshot>({
    gameId, role: "host", initial: initialState, fetchSnapshot: () => fetchHostSnapshot(gameId),
  });
  const [players, setPlayers] = useState(initialPlayers);
  useEffect(() => {
    let live = true;
    void fetchRoster(gameId).then((r) => { if (live && r) setPlayers(r); });
    return () => { live = false; };
  }, [gameId, state.version]);
  // The game moved on (started in another tab, cancelled): let the server pick the right screen.
  useEffect(() => {
    if (state.status !== "lobby") router.refresh();
  }, [state.status, router]);

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

  const act = async (key: string, action: "start_game" | "cancel" | "kick", ok: string, playerId?: string) => {
    setBusy(key);
    if (action === "kick") {
      const res = await fetch(`/api/host/games/${gameId}/players/${playerId}/remove`, { method: "POST" }).catch(() => null);
      setBusy(null);
      setConfirm(null);
      if (!res?.ok) return toast("Couldn't remove that player. Please try again.", "error");
      toast(ok, "success");
      resync();
      return;
    }
    const { result, changedUnderneath } = await runAction(gameId, action, state.version, phaseKey(state));
    setBusy(null);
    setConfirm(null);
    if (!result.ok) {
      if (changedUnderneath) applyState(changedUnderneath); else resync();
      return toast(apiErrors[result.error] ?? "Something went wrong. Please try again.", "error");
    }
    applyState(result.state);
    toast(ok, "success");
    router.refresh();
  };

  const count = players.length;
  // chips that arrive after the first paint get the "join" animation
  const seen = useRef(new Set(initialPlayers.map((p) => p.id)));
  useEffect(() => { for (const p of players) seen.current.add(p.id); }, [players]);
  const chips = fullscreen ? players : players.slice(0, 14);

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      {/* Presentation stage: this element goes fullscreen */}
      <div
        ref={stage}
        className={cn(
          "relative isolate overflow-hidden bg-gradient-to-b from-primary to-brand-night text-white",
          fullscreen ? "h-viewport flex flex-col rounded-none p-[3dvh]" : "rounded-4xl p-6 sm:p-10",
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

        <div className={cn(
          fullscreen
            ? "grid min-h-0 w-full flex-1 grid-cols-[auto_minmax(0,1fr)] grid-rows-[repeat(4,auto)_minmax(0,1fr)] content-center items-center gap-x-[5vw] gap-y-[2dvh] px-[3vw] pt-[7dvh] text-left portrait:grid-cols-1 portrait:justify-items-center portrait:text-center"
            : "mt-2 flex flex-col items-center gap-5 text-center",
        )}>
          <h2 className={cn("font-display font-bold", fullscreen ? "col-start-2 text-[clamp(2.5rem,7dvh,4.5rem)] leading-tight portrait:col-start-1" : "text-3xl")}>{title}</h2>
          <p className={cn("text-white/90", fullscreen ? "col-start-2 text-[clamp(1.25rem,3.4dvh,1.875rem)] portrait:col-start-1" : "text-lg")}>Scan to join the game</p>

          {/* QR in a viewfinder frame */}
          <div className={cn("relative", fullscreen ? "col-start-1 row-span-5 row-start-1 w-[min(74dvh,42vw)] portrait:row-span-1 portrait:row-start-auto portrait:w-[min(42dvh,80vw)]" : "w-full max-w-xs sm:max-w-sm")}>
            <span aria-hidden="true" className="absolute -inset-3 animate-ping-soft rounded-[2rem] border-2 border-brand-yellow/40 motion-reduce:hidden" />
            {["-left-3 -top-3 rounded-tl-3xl border-l-4 border-t-4", "-right-3 -top-3 rounded-tr-3xl border-r-4 border-t-4", "-bottom-3 -left-3 rounded-bl-3xl border-b-4 border-l-4", "-bottom-3 -right-3 rounded-br-3xl border-b-4 border-r-4"].map((c) => (
              <span key={c} aria-hidden="true" className={cn("absolute size-10 border-brand-yellow", c)} />
            ))}
            <div className="rounded-3xl bg-white p-4 shadow-pop">{qr}</div>
          </div>

          {/* Room code as tiles */}
          <div className={cn(fullscreen && "col-start-2 portrait:col-start-1")}>
            <p className={cn("mb-2 font-semibold uppercase tracking-widest text-white/80", fullscreen ? "text-[clamp(1rem,2.4dvh,1.25rem)]" : "text-sm")}>Room code</p>
            <p role="img" aria-label={`Room code ${code.split("").join(" ")}`} className={cn("flex gap-1.5 sm:gap-2", fullscreen ? "justify-start portrait:justify-center" : "justify-center")}>
              {code.split("").map((ch, i) => (
                <span key={i} aria-hidden="true" className={cn("grid place-items-center rounded-xl bg-white font-display font-bold text-primary shadow-pop", fullscreen ? "size-[min(6rem,11dvh)] text-[min(4.5rem,8dvh)]" : "size-11 text-3xl sm:size-14 sm:text-4xl")}>{ch}</span>
              ))}
            </p>
          </div>
          {fullscreen ? <p className="col-start-2 break-all font-mono text-[clamp(1rem,2.4dvh,1.25rem)] text-white/80 portrait:col-start-1">{joinUrl}</p> : null}

          {/* Players arriving (fullscreen: fills what is left of the screen; extra names are clipped, the count stays exact) */}
          <div className={cn("grid gap-3", fullscreen ? "col-start-2 min-h-0 self-stretch content-start justify-items-start overflow-hidden portrait:col-start-1 portrait:justify-items-center" : "justify-items-center")}>
            <p className={cn("font-display font-semibold", fullscreen ? "text-[clamp(1.5rem,4.4dvh,2.25rem)]" : "text-xl")} aria-live="polite">
              <span key={count} className="inline-block animate-pop-in text-brand-yellow">{count}</span> {count === 1 ? "player" : "players"} joined
            </p>
            {count > 0 ? (
              <ul className={cn("flex max-w-5xl flex-wrap gap-2", fullscreen ? "justify-start portrait:justify-center" : "justify-center")} aria-label="Players in the lobby">
                {chips.map((p) => (
                  <li key={p.id} className={cn("rounded-full bg-white/15 px-4 py-1.5 font-display font-semibold", fullscreen ? "px-5 py-1.5 text-[clamp(1.125rem,3dvh,1.875rem)]" : "text-base", !seen.current.has(p.id) && "animate-join-in motion-reduce:animate-none")}>{p.nickname}</li>
                ))}
                {!fullscreen && count > chips.length ? <li className="rounded-full bg-white/10 px-4 py-1.5 font-display font-semibold text-white/80">+{count - chips.length} more</li> : null}
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
              <span className="text-base font-semibold text-muted-foreground">{count} / {maxPlayers}</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            {count >= maxPlayers ? (
              <div role="status" className="rounded-2xl border border-brand-coral/40 bg-brand-coral/10 px-4 py-3 text-sm">
                <p className="font-semibold text-foreground">Player limit reached ({count}/{maxPlayers})</p>
                <p className="text-muted-foreground">New players can&apos;t join this room. Upgrade required for a bigger room: a higher Game Pass raises the limit right away.</p>
                <Link href="/dashboard/subscription#plans" className="mt-1 inline-block font-semibold text-primary underline underline-offset-4">Upgrade your Game Pass</Link>
              </div>
            ) : null}
            {count === 0 ? (
              <p className="rounded-2xl border-2 border-dashed border-primary/25 px-4 py-6 text-center text-muted-foreground">
                Waiting for players. Ask everyone to scan the QR code.
              </p>
            ) : (
              <ul className="grid max-h-60 gap-2 overflow-y-auto" aria-label="Joined players">
                {players.map((p) => (
                  <li key={p.id} className={cn("flex items-center justify-between gap-2 rounded-2xl bg-secondary px-4 py-1.5", !seen.current.has(p.id) && "animate-join-in motion-reduce:animate-none")}>
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
              onClick={() => act("start", "start_game", "Game started!")}
            >
              <Play aria-hidden="true" className="!size-7" /> {busy === "start" ? "Starting…" : "Start game"}
            </Button>
            {count === 0 ? <p className="-mt-2 text-center text-sm text-muted-foreground">You can start once someone has joined.</p> : null}
            <Button variant="ghost" className="text-destructive hover:bg-destructive/10" disabled={busy !== null} onClick={() => setConfirm({ kind: "cancel" })}>
              Cancel game
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between gap-3">
              <span>What players will bring</span>
              <Badge variant="secondary">{roundCount} {roundCount === 1 ? "round" : "rounds"}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="grid max-h-72 gap-2 overflow-y-auto" aria-label="Items to bring, in order">
              {items.map((it, i) => (
                <li key={i} className="flex items-center gap-3 rounded-2xl bg-secondary px-3 py-2">
                  <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-xl bg-brand-yellow font-display font-bold text-brand-night">{i + 1}</span>
                  <span className="min-w-0 break-words font-semibold text-secondary-foreground">{it}</span>
                </li>
              ))}
              {items.length === 0 ? <li className="text-muted-foreground">{roundCount} {roundCount === 1 ? "round" : "rounds"} ready.</li> : null}
            </ol>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Invite players</CardTitle></CardHeader>
          <CardContent className="grid gap-3">
            <CopyField value={joinUrl} label="Join link" />
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
        onConfirm={() => confirm?.kind === "kick" && act(confirm.player.id, "kick", `${confirm.player.nickname} removed`, confirm.player.id)}
      />
      <ConfirmDialog
        open={confirm?.kind === "cancel"} busy={busy !== null} title="Cancel this game?" confirmLabel="Cancel game"
        description="The lobby closes and players can no longer join. This can't be undone."
        onClose={() => setConfirm(null)} onConfirm={() => act("cancel", "cancel", "Game cancelled")}
      />
    </div>
  );
}
