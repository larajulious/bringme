"use client";

import { Play, Users, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { fetchHostSnapshot, fetchRoster, phaseKey, runAction } from "@/components/game/host-api";
import { OnScreenNow, bringMeOnScreen } from "@/components/game/on-screen-now";
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
  gameId, code, joinUrl, maxPlayers, roundCount, items, players: initialPlayers, siteUrlConfigured, initialState,
}: {
  gameId: string; code: string; joinUrl: string; maxPlayers: number; roundCount: number; items: string[];
  players: LobbyPlayer[]; siteUrlConfigured: boolean; initialState: HostSnapshot;
}) {
  const router = useRouter();
  const { toast } = useToast();
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

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <OnScreenNow screen={bringMeOnScreen({ ...state, joinCode: code, playerCount: count })} />

      {/* Host controls */}
      <div className="grid grid-cols-[minmax(0,1fr)] content-start gap-6 lg:grid-cols-[repeat(2,minmax(0,1fr))] lg:items-start">
        <Card className="lg:row-span-2">
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
                Waiting for players. Ask everyone to scan the QR code on the presenter screen.
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
