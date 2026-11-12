"use client";

import { DoorClosed, Expand, Minimize, Users } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { Backdrop } from "@/components/brand/backdrop";
import { Logo } from "@/components/brand/logo";
import { Mascot } from "@/components/brand/mascot";
import { Confetti } from "@/components/game/confetti";
import { fetchHostSnapshot, fetchRoster } from "@/components/game/host-api";
import { ProjectorStage } from "@/components/game/projector-stage";
import { TrophyIllustration } from "@/components/game/trophy";
import { useGameSync, type Conn } from "@/components/game/use-game-sync";
import { Button } from "@/components/ui/button";
import { formatElapsed } from "@/lib/game/timing";
import type { HostSnapshot } from "@/lib/game/types";
import { cn } from "@/lib/utils";

type Player = { id: string; nickname: string };
type Row = { nickname: string; playerId: string; photoUrl: string | null };

const connText: Record<Conn, string> = { connecting: "Connecting…", live: "Live", basic: "Live (basic)", reconnecting: "Reconnecting…", offline: "Offline" };
const IDLE_MS = 2_500;

/**
 * Audience-safe presenter screen for the projector / TV (/present/[id]). Display only — the Game Master runs the
 * game from their private console. It never shows the item list, upcoming items, host controls or any photo other
 * than an official winner's. It follows every phase on its own (lobby → rounds → final results) through the same
 * realtime sync as the console. Controls fade out when the mouse is idle; the screen is kept awake if supported.
 */
export function PresenterScreen({ gameId, initial, initialPlayers, qr, joinUrl }: {
  gameId: string; initial: HostSnapshot; initialPlayers: Player[]; qr: ReactNode; joinUrl: string;
}) {
  const { state: s, conn, offsetMs } = useGameSync<HostSnapshot>({ gameId, role: "host", initial, fetchSnapshot: () => fetchHostSnapshot(gameId) });
  const [players, setPlayers] = useState(initialPlayers);
  const [rows, setRows] = useState<Row[]>([]);
  const [photos, setPhotos] = useState<{ no: number; photoUrl: string | null }[]>([]);
  const chrome = useChrome();

  // Roster for the lobby wall (re-read on every state change; joins bump the version).
  useEffect(() => {
    let live = true;
    void fetchRoster(gameId).then((r) => { if (live && r) setPlayers(r); });
    return () => { live = false; };
  }, [gameId, s.version]);

  // During a round: who has submitted (names only on screen) and, once official, the winner's photo.
  const inRound = (s.phase === "active" || s.phase === "reviewing" || s.phase === "winner_announced") && Boolean(s.round);
  useEffect(() => {
    if (!inRound) { setRows([]); return; }
    let live = true;
    fetch(`/api/host/games/${gameId}/submissions`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
      .then((d: { submissions: Row[] }) => { if (live) setRows(d.submissions); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [gameId, inRound, s.version, s.round?.id]);

  useEffect(() => {
    if (s.status !== "finished") return;
    let live = true;
    fetch(`/api/host/games/${gameId}/results`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
      .then((d: { rounds: { no: number; photoUrl: string | null }[] }) => { if (live) setPhotos(d.rounds); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [gameId, s.status]);

  const r = s.round;
  const winnerPhoto = s.phase === "winner_announced" && r?.decided && r.winnerPlayerId ? rows.find((x) => x.playerId === r.winnerPlayerId)?.photoUrl ?? null : null;

  let body: ReactNode;
  if (s.status === "finished" || s.status === "canceled") body = <FinalScreen s={s} photos={photos} />;
  else if (s.phase === "lobby" && s.status === "lobby") body = <LobbyWall s={s} players={players} qr={qr} joinUrl={joinUrl} />;
  else body = <ProjectorStage presenter s={s} offsetMs={offsetMs} submittedNames={rows.map((x) => x.nickname)} winnerPhotoUrl={winnerPhoto} actions={null} />;

  return (
    <div className={cn("relative h-viewport overflow-hidden bg-brand-night text-white", chrome.idle && "cursor-none")}>
      {body}
      <div
        className={cn(
          "absolute bottom-[2dvh] right-[2vw] z-30 flex items-center gap-3 transition-opacity duration-300",
          chrome.idle ? "pointer-events-none opacity-0" : "opacity-100",
        )}
      >
        <span className="inline-flex items-center gap-2 rounded-full bg-black/40 px-3 py-1.5 text-sm font-semibold" role="status">
          <span aria-hidden="true" className={cn("size-2.5 rounded-full", conn === "live" ? "bg-emerald-500" : conn === "offline" ? "bg-brand-coral" : "bg-brand-yellow")} />
          {connText[conn]}
        </span>
        <Button type="button" variant="outline-light" size="sm" onClick={chrome.toggleFullscreen}>
          {chrome.fullscreen ? <Minimize aria-hidden="true" /> : <Expand aria-hidden="true" />}
          {chrome.fullscreen ? "Exit fullscreen" : "Fullscreen"} <kbd className="ml-1 rounded bg-white/15 px-1.5 font-mono text-xs">F</kbd>
        </Button>
      </div>
    </div>
  );
}

/** Fullscreen (button or "F"), idle-hiding controls/cursor, and a screen wake lock while presenting. */
function useChrome() {
  const [idle, setIdle] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch { /* not available: the window still works */ }
  }, []);

  useEffect(() => {
    const wake = () => {
      setIdle(false);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setIdle(true), IDLE_MS);
    };
    const onKey = (e: KeyboardEvent) => {
      wake();
      if ((e.key === "f" || e.key === "F") && !e.metaKey && !e.ctrlKey && !e.altKey) void toggleFullscreen();
    };
    const onFs = () => setFullscreen(Boolean(document.fullscreenElement));
    wake();
    window.addEventListener("pointermove", wake);
    window.addEventListener("pointerdown", wake);
    window.addEventListener("keydown", onKey);
    document.addEventListener("fullscreenchange", onFs);

    // Keep the projector from sleeping mid-game (best effort; re-acquired when the tab is shown again).
    let lock: { release: () => Promise<void> } | null = null;
    const acquire = async () => {
      try {
        const nav = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } };
        if (document.visibilityState === "visible" && nav.wakeLock) lock = await nav.wakeLock.request("screen");
      } catch { /* not supported or denied */ }
    };
    void acquire();
    document.addEventListener("visibilitychange", acquire);

    return () => {
      window.clearTimeout(timer.current);
      window.removeEventListener("pointermove", wake);
      window.removeEventListener("pointerdown", wake);
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("fullscreenchange", onFs);
      document.removeEventListener("visibilitychange", acquire);
      void lock?.release().catch(() => undefined);
    };
  }, [toggleFullscreen]);

  return { idle, fullscreen, toggleFullscreen };
}

/** Lobby: big QR, room code and the wall of players arriving. No items, no settings. */
function LobbyWall({ s, players, qr, joinUrl }: { s: HostSnapshot; players: Player[]; qr: ReactNode; joinUrl: string }) {
  const seen = useRef(new Set(players.map((p) => p.id)));
  useEffect(() => { for (const p of players) seen.current.add(p.id); }, [players]);
  const code = s.joinCode ?? "";

  return (
    <div className="relative isolate grid h-full grid-cols-[auto_minmax(0,1fr)] items-center gap-x-[5vw] px-[5vw] py-[5dvh] portrait:grid-cols-1 portrait:content-center portrait:justify-items-center portrait:gap-y-[3dvh] portrait:text-center">
      <Backdrop />
      <div className="relative w-[min(70dvh,40vw)] portrait:w-[min(40dvh,75vw)]">
        <span aria-hidden="true" className="absolute -inset-3 animate-ping-soft rounded-[2rem] border-2 border-brand-yellow/40 motion-reduce:hidden" />
        <div className="relative overflow-hidden rounded-[1.75rem] bg-white p-[1.5dvh] shadow-card">{qr}</div>
      </div>

      <div className="grid min-h-0 content-center gap-[2.2dvh]">
        <div className="flex items-center gap-4 portrait:justify-center">
          <Logo size="md" tone="light" />
          <Mascot mood="cheer" className="w-[min(5.5rem,9dvh)]" />
        </div>
        <h1 className="font-display text-[clamp(2.25rem,7dvh,4.5rem)] font-bold leading-tight">{s.title}</h1>
        <p className="text-[clamp(1.25rem,3.6dvh,2rem)] text-white/90">Scan the code or go to <span className="font-mono font-bold text-brand-yellow">{joinUrl.replace(/^https?:\/\//, "")}</span></p>
        <div>
          <p className="mb-2 text-[clamp(0.9rem,2.2dvh,1.25rem)] font-semibold uppercase tracking-widest text-white/75">Room code</p>
          <p role="img" aria-label={`Room code ${code.split("").join(" ")}`} className="flex gap-[0.6vw] portrait:justify-center">
            {code.split("").map((ch, i) => (
              <span key={i} aria-hidden="true" className="grid size-[min(6.5rem,11dvh)] place-items-center rounded-2xl bg-white font-display text-[min(4.75rem,8dvh)] font-bold text-primary shadow-pop">{ch}</span>
            ))}
          </p>
        </div>
        <div className="grid min-h-0 gap-3">
          <p className="flex items-center gap-2 font-display text-[clamp(1.5rem,4.4dvh,2.5rem)] font-semibold portrait:justify-center" aria-live="polite">
            <Users aria-hidden="true" className="size-[1em] text-brand-yellow" />
            <span key={players.length} className="inline-block animate-pop-in text-brand-yellow">{players.length}</span>
            <span className="text-white/70">/ {s.maxPlayers} players</span>
          </p>
          {players.length ? (
            <ul className="flex max-h-[26dvh] flex-wrap gap-2 overflow-hidden portrait:justify-center" aria-label="Players in the lobby">
              {players.map((p) => (
                <li key={p.id} className={cn("rounded-full bg-white/15 px-5 py-1.5 font-display text-[clamp(1.125rem,3dvh,1.875rem)] font-semibold", !seen.current.has(p.id) && "animate-join-in motion-reduce:animate-none")}>{p.nickname}</li>
              ))}
            </ul>
          ) : (
            <p className="text-[clamp(1.125rem,3dvh,1.75rem)] text-white/75">Waiting for the first player… be brave!</p>
          )}
        </div>
      </div>
    </div>
  );
}

/** Final results: champion(s), every round's winner and the winning photos. */
function FinalScreen({ s, photos }: { s: HostSnapshot; photos: { no: number; photoUrl: string | null }[] }) {
  if (s.status === "canceled") {
    return (
      <div className="relative isolate grid h-full place-items-center content-center gap-4 text-center">
        <Backdrop />
        <DoorClosed aria-hidden="true" className="size-24 text-brand-yellow" />
        <h1 className="font-display text-[clamp(2.5rem,8dvh,4.5rem)] font-bold">Game ended</h1>
        <p className="text-[clamp(1.125rem,3.4dvh,1.875rem)] text-white/85">Thanks for playing {s.title}!</p>
      </div>
    );
  }
  const results = s.results ?? [];
  const wins = new Map<string, number>();
  for (const r of results) if (r.winnerName) wins.set(r.winnerName, (wins.get(r.winnerName) ?? 0) + 1);
  const top = Math.max(0, ...wins.values());
  const champions = [...wins.entries()].filter(([, c]) => c === top && top > 0).map(([n]) => n);

  return (
    <div className="relative isolate flex h-full flex-col gap-[2dvh] bg-gradient-to-b from-primary to-brand-night px-[4vw] py-[3dvh]">
      <Backdrop />
      <Confetti pieces={40} />
      <div className="relative z-10 grid shrink-0 justify-items-center gap-[1dvh] text-center">
        <TrophyIllustration className="w-[min(9rem,15dvh)] animate-drop-in motion-reduce:animate-none" />
        <h1 className="font-display text-[clamp(2.5rem,8dvh,5rem)] font-bold leading-tight text-brand-yellow">That&apos;s a wrap!</h1>
        <p className="text-[clamp(1.125rem,3.6dvh,2rem)]">
          {champions.length ? (
            <>{champions.length > 1 ? "Champions" : "Champion"}: <strong className="font-display text-brand-yellow">{champions.join(" & ")}</strong> · {top} {top === 1 ? "round" : "rounds"} won</>
          ) : `${s.title} · thanks for playing!`}
        </p>
      </div>
      <ol className="relative z-10 grid min-h-0 flex-1 content-start gap-[1.5dvh] overflow-hidden xl:grid-cols-2" aria-label="Winners by round">
        {results.map((r, i) => {
          const photo = photos.find((p) => p.no === r.no)?.photoUrl ?? null;
          return (
            <li key={r.no} className="flex animate-rise items-center gap-[2vw] rounded-3xl bg-white/10 p-[1.5dvh] motion-reduce:animate-none" style={{ animationDelay: `${300 + i * 120}ms` }}>
              <span className="grid size-[min(3.5rem,7dvh)] shrink-0 place-items-center rounded-2xl bg-brand-yellow font-display text-[min(1.75rem,3.5dvh)] font-bold text-brand-night">{r.no}</span>
              {photo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={photo} alt={`Winning photo, round ${r.no}`} className="size-[min(7rem,10dvh)] -rotate-2 rounded-xl border-4 border-white bg-black object-cover shadow-card" />
              ) : null}
              <div className="min-w-0 flex-1">
                <p className="truncate text-[clamp(1rem,2.8dvh,1.5rem)] text-white/80">{r.prompt}</p>
                <p className="truncate font-display text-[clamp(1.5rem,4.5dvh,3rem)] font-bold text-brand-yellow">{r.winnerName ?? "No winner"}</p>
              </div>
              {r.winnerMs !== null ? <p className="font-mono text-[clamp(1.5rem,4.5dvh,3rem)] font-bold tabular-nums">{formatElapsed(r.winnerMs)}</p> : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
