"use client";

import { Ban, Clock, DoorClosed, Grid3x3, ListOrdered, Trophy, WifiOff } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { BingoMark } from "@/components/bingosnap/bingo-mark";
import { BoardPreview } from "@/components/bingosnap/board-preview";
import { ClaimPanel } from "@/components/bingosnap/claim-panel";
import { HuntBoard, LocalPhotosPanel } from "@/components/bingosnap/hunt-board";
import { Countdown } from "@/components/game/countdown";
import { PlayerCount } from "@/components/game/player-count";
import { useGameSync, useNow, type Conn } from "@/components/game/use-game-sync";
import { WaitingDots } from "@/components/game/waiting-dots";
import { Button } from "@/components/ui/button";
import { formatMinutes, modeText } from "@/lib/bingosnap/board";
import type { BingoPlayerSnapshot } from "@/lib/bingosnap/types";
import { secondsUntil, type FetchResult } from "@/lib/game/sync";
import { cn } from "@/lib/utils";

const connLabel: Record<Conn, { text: string; dot: string }> = {
  connecting: { text: "Connecting…", dot: "bg-brand-yellow" },
  live: { text: "Connected", dot: "bg-emerald-400" },
  basic: { text: "Connected (basic mode)", dot: "bg-brand-yellow" },
  reconnecting: { text: "Reconnecting…", dot: "bg-brand-yellow" },
  offline: { text: "You're offline", dot: "bg-brand-coral" },
};

async function fetchSnapshot(): Promise<FetchResult<BingoPlayerSnapshot>> {
  const r = await fetch("/api/play/bingosnap/state", { cache: "no-store" }).catch(() => null);
  if (!r) return { status: "error" };
  if (r.status === 401) return { status: "unauthorized" };
  if (!r.ok) return { status: "error" };
  return { status: "ok", state: (await r.json()) as BingoPlayerSnapshot };
}

const huntEnd = (s: BingoPlayerSnapshot) => s.board.huntEndsAt;

const clockText = (secs: number) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;

function Notice({ icon, title, text, code, children }: { icon: React.ReactNode; title: string; text: string; code?: string; children?: React.ReactNode }) {
  return (
    <div className="grid w-full justify-items-center">
      <div className="grid justify-items-center gap-4 rounded-4xl bg-card p-8 text-card-foreground shadow-card animate-pop-in short:gap-3 short:p-6" role="status">
        <span aria-hidden="true" className="grid size-16 place-items-center rounded-full bg-secondary text-primary [&_svg]:size-8">{icon}</span>
        <h1 className="font-display text-3xl font-bold text-primary">{title}</h1>
        <p className="text-muted-foreground">{text}</p>
        {code ? <Button asChild size="lg"><Link href={`/join/${code}`}>Back to the room</Link></Button> : null}
      </div>
      {children}
    </div>
  );
}

/**
 * A participant's BingoSnap screen, a pure function of their authoritative snapshot and the
 * server clock: waiting lobby → 3-2-1 → their own card (photos saved on this phone only) → time's
 * up. Realtime hints from the game channel move every connected phone on as soon as the host starts.
 */
export function BingoPlayerScreen({ code, initial }: { code: string; initial: BingoPlayerSnapshot }) {
  const { state: s, conn, offsetMs, unauthorized, applyState, resync } = useGameSync<BingoPlayerSnapshot>({
    gameId: initial.gameId, role: "guest", initial, fetchSnapshot, tokenUrl: "/api/play/bingosnap/realtime-token",
    deadlineOf: huntEnd,
  });
  const b = s.board;
  const running = s.status === "active" && s.phase === "active";
  const clientNow = useNow(running, 250);
  const serverNow = clientNow + offsetMs;
  const beforeHunt = running && (!b.huntStartedAt || Date.parse(b.huntStartedAt) > serverNow);
  const left = beforeHunt ? secondsUntil(s.countdownEndsAt ?? b.huntStartedAt, clientNow, offsetMs) : 0;
  const huntLeft = secondsUntil(b.huntEndsAt, clientNow, offsetMs);
  const removed = s.me.state === "removed";
  const over = removed || unauthorized || s.status === "cancelled" || s.status === "completed";
  const mode = modeText(b.winMode);
  const photos = <LocalPhotosPanel gameId={s.gameId} playerId={s.me.id} title={s.title} layout={s.me.layout} />;
  const hunting = running && !beforeHunt && !b.huntOver && huntLeft > 0;
  const urgent = hunting && huntLeft <= 60;
  // Spoken once each: the last minute, the last ten seconds, time's up.
  const [spoken, setSpoken] = useState("");
  const said = useRef(new Set<string>());
  useEffect(() => {
    const say = (k: string, text: string) => { if (!said.current.has(k)) { said.current.add(k); setSpoken(text); } };
    if (hunting && huntLeft <= 10) say("10", "10 seconds left");
    else if (hunting && huntLeft <= 60) say("60", "1 minute left");
    else if (running && !beforeHunt && (b.huntOver || huntLeft === 0) && said.current.size) say("up", "Time's up");
  }, [hunting, huntLeft, running, beforeHunt, b.huntOver]);
  const header = (
    <div className="flex items-center justify-between gap-3">
      <h1 className="min-w-0 truncate text-left font-display text-2xl font-bold short:text-xl">{s.title}</h1>
      <p className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 font-mono text-lg font-bold tabular-nums transition-colors", urgent ? "bg-brand-coral text-white" : "bg-brand-yellow text-brand-night")} role="timer" aria-label={`Time left ${clockText(huntLeft)}`}>
        <Clock aria-hidden="true" className="size-4" />{clockText(huntLeft)}
      </p>
    </div>
  );

  let body: React.ReactNode;
  if (removed) {
    body = <Notice icon={<Ban />} title="You were removed" text="The Game Master took you out of this game." code={code}>{photos}</Notice>;
  } else if (unauthorized) {
    body = <Notice icon={<WifiOff />} title="Your session ended" text="Join again to get back in." code={code} />;
  } else if (s.status === "cancelled") {
    body = <Notice icon={<DoorClosed />} title="Game cancelled" text="The Game Master cancelled this game. Thanks for dropping by!">{photos}</Notice>;
  } else if (s.status === "completed") {
    body = <Notice icon={<Trophy />} title="That's a wrap!" text="The game is over. Thanks for playing!">{photos}</Notice>;
  } else if (s.status === "lobby") {
    body = (
      <div className="grid w-full justify-items-center gap-3 short:gap-2 tiny:gap-1.5">
        <BingoMark className="w-16 short:hidden" />
        <h1 className="animate-bounce-in font-display text-5xl font-bold text-brand-yellow [text-shadow:0_4px_0_hsl(var(--brand-yellow-deep))] short:text-4xl tiny:text-3xl">You&apos;re In!</h1>
        <p className="max-w-full break-words rounded-full bg-white px-6 py-1.5 font-display text-2xl font-bold text-primary shadow-pop-purple animate-pop-in tiny:text-xl">
          <span className="sr-only">Welcome, </span>{s.me.nickname}
        </p>
        <PlayerCount count={s.playerCount} />

        <section aria-labelledby="game-h" className="grid w-full gap-2.5 rounded-4xl bg-white/10 p-4 text-left ring-1 ring-white/15 short:p-3">
          <h2 id="game-h" className="break-words text-center font-display text-2xl font-bold short:text-xl">{s.title}</h2>
          <ul className="flex flex-wrap justify-center gap-1.5 text-sm font-semibold" aria-label="Game rules">
            <li className="inline-flex items-center gap-1.5 rounded-full bg-brand-yellow px-3 py-1 text-brand-night"><Grid3x3 aria-hidden="true" className="size-4" />{mode.name}</li>
            <li className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1"><Clock aria-hidden="true" className="size-4" />{formatMinutes(Math.round(b.durationSeconds / 60))}</li>
            <li className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1">
              {b.winnerRule === "ranked" ? <ListOrdered aria-hidden="true" className="size-4" /> : <Trophy aria-hidden="true" className="size-4" />}
              {b.winnerRule === "ranked" ? "Ranked winners" : "First Bingo wins"}
            </li>
          </ul>
          <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-3 tiny:grid-cols-1">
            <BoardPreview
              size={b.size}
              label="Your card"
              compact
              className="rounded-2xl p-1.5 ring-2 ring-white/15 sm:gap-1.5 sm:p-2 tiny:hidden"
              cells={Array.from({ length: b.size * b.size }, (_, i) => ({
                challenge: null, placeholder: " ", isFree: b.freeSpace && b.size % 2 === 1 && i === (b.size * b.size - 1) / 2,
              }))}
            />
            <div className="grid gap-1 text-sm">
              <p className="font-semibold">{mode.goal}.</p>
              <p className="text-white/80">Your challenges appear when the game starts. Everyone gets them in a different order.</p>
            </div>
          </div>
        </section>

        <div className="flex flex-col items-center gap-2" role="status">
          <WaitingDots />
          <p className="text-lg font-semibold short:text-base">Waiting for the Game Master to start…</p>
        </div>
      </div>
    );
  } else if (beforeHunt) {
    body = (
      <div className="grid justify-items-center gap-4">
        <p className="font-display text-2xl font-bold">Get ready to hunt!</p>
        <Countdown left={left} />
      </div>
    );
  } else if (running && !b.huntOver && huntLeft > 0) {
    const layout = s.me.layout ?? [];
    body = (
      <div className="grid w-full gap-3 short:gap-2.5">
        {header}
        <p className="text-left text-white/85">{mode.goal}, then submit. Tap a square to snap it.</p>
        {layout.length ? (
          <HuntBoard gameId={s.gameId} playerId={s.me.id} title={s.title} size={b.size} mode={b.winMode} modeName={mode.name} layout={layout} submissions={s.me.submissions} readOnly={false}
            renderClaim={(result) => <ClaimPanel result={result} me={s.me} huntActive onState={(next) => (next ? applyState(next) : resync())} />} />
        ) : (
          <div className="grid justify-items-center gap-3 py-8" role="status"><WaitingDots /><p>Loading your card…</p></div>
        )}
      </div>
    );
  } else {
    const layout = s.me.layout ?? [];
    body = (
      <div className="grid w-full gap-3">
        <div className="grid justify-items-center gap-2" role="status">
          <BingoMark className="w-16 short:hidden" />
          <h1 className="font-display text-5xl font-bold text-brand-yellow [text-shadow:0_4px_0_hsl(var(--brand-yellow-deep))] short:text-4xl">Time&apos;s up!</h1>
          <p className="text-lg text-white/90">Keep your photos ready: the Game Master may ask to see them.</p>
        </div>
        {layout.length ? (
          <HuntBoard gameId={s.gameId} playerId={s.me.id} title={s.title} size={b.size} mode={b.winMode} modeName={mode.name} layout={layout} submissions={s.me.submissions} readOnly
            renderClaim={(result) => <ClaimPanel result={result} me={s.me} huntActive={false} onState={(next) => (next ? applyState(next) : resync())} />} />
        ) : null}
      </div>
    );
  }

  const status = connLabel[conn];
  return (
    <div className="relative my-auto flex w-full flex-col items-center text-center text-white">
      <p className="sr-only" role="status" aria-live="assertive">{spoken}</p>
      <div className="relative z-10 flex w-full shrink-0 flex-col items-center">{body}</div>
      {!over ? (
        <p className="relative z-10 mt-6 inline-flex shrink-0 items-center gap-2 rounded-full bg-white/15 px-4 py-2 text-sm font-semibold short:mt-4 short:py-1.5 tiny:mt-2" role="status">
          <span aria-hidden="true" className={cn("size-2.5 rounded-full", status.dot, conn === "live" && "animate-pulse motion-reduce:animate-none")} />
          {status.text}
        </p>
      ) : null}
    </div>
  );
}
