"use client";

import { Ban, DoorClosed, WifiOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";

import { Mascot } from "@/components/brand/mascot";
import { CameraGate } from "@/components/game/camera-gate";
import { CameraStage } from "@/components/game/camera-stage";
import { CameraProvider, useCamera } from "@/components/game/camera-context";
import { Confetti } from "@/components/game/confetti";
import { Countdown } from "@/components/game/countdown";
import { ITEM_WRAP } from "@/components/game/item-text";
import { PlayerCount } from "@/components/game/player-count";
import { WaitingDots } from "@/components/game/waiting-dots";
import { TrophyIllustration } from "@/components/game/trophy";
import { WinnerStage } from "@/components/game/winner-stage";
import { useGameSync, useNow, type Conn } from "@/components/game/use-game-sync";
import { Button } from "@/components/ui/button";
import type { FetchResult } from "@/lib/game/sync";
import { secondsUntil } from "@/lib/game/sync";
import { formatElapsed } from "@/lib/game/timing";
import type { PlayerSnapshot } from "@/lib/game/types";
import { cn } from "@/lib/utils";

const connLabel: Record<Conn, { text: string; dot: string }> = {
  connecting: { text: "Connecting…", dot: "bg-brand-yellow" },
  live: { text: "Connected", dot: "bg-emerald-400" },
  basic: { text: "Connected (basic mode)", dot: "bg-brand-yellow" },
  reconnecting: { text: "Reconnecting…", dot: "bg-brand-yellow" },
  offline: { text: "You're offline", dot: "bg-brand-coral" },
};

async function fetchSnapshot(): Promise<FetchResult<PlayerSnapshot>> {
  const r = await fetch("/api/play/state", { cache: "no-store" }).catch(() => null);
  if (!r) return { status: "error" };
  if (r.status === 401) return { status: "unauthorized" };
  if (!r.ok) return { status: "error" };
  return { status: "ok", state: (await r.json()) as PlayerSnapshot };
}

function Card({ icon, title, text, children }: { icon: React.ReactNode; title: string; text?: string; children?: React.ReactNode }) {
  return (
    <div className="grid justify-items-center gap-4 rounded-4xl bg-card p-8 text-card-foreground shadow-card animate-pop-in short:gap-3 short:p-6" role="status">
      <span aria-hidden="true" className="grid size-16 place-items-center rounded-full bg-secondary text-primary [&_svg]:size-8">{icon}</span>
      <h1 className="font-display text-3xl font-bold text-primary">{title}</h1>
      {text ? <p className="text-muted-foreground">{text}</p> : null}
      {children}
    </div>
  );
}

/**
 * The player's whole game experience, driven by ONE authoritative snapshot.
 * The screen is a pure function of that snapshot + the (offset-corrected)
 * server clock, so refreshing the page or switching devices always lands on the
 * right screen.
 */
export function PlayerGame({ code, initial }: { code: string; initial: PlayerSnapshot }) {
  return (
    <CameraProvider>
      <PlayerGameInner code={code} initial={initial} />
    </CameraProvider>
  );
}

function PlayerGameInner({ code, initial }: { code: string; initial: PlayerSnapshot }) {
  const cam = useCamera();
  const { state: s, conn, offsetMs, unauthorized, clock: clockSync, syncBurst } = useGameSync<PlayerSnapshot>({
    gameId: initial.gameId, role: "guest", initial, fetchSnapshot,
  });

  const timed = s.phase === "countdown" || s.phase === "active";
  const now = useNow(timed, 100);
  const clock = now + offsetMs;

  const over = s.me.kicked || unauthorized || s.status === "finished" || s.status === "canceled";

  // Camera: frames flow only around rounds; released when the game is over.
  const roundLive = s.phase === "countdown" || (s.phase === "active" && s.round?.status !== "closed");
  useEffect(() => { cam.setActive(roundLive); }, [cam, roundLive, cam.stream]);
  useEffect(() => { if (over) cam.stop(); }, [over, cam]);
  // Fresh clock samples as soon as a countdown starts, so the capture timer starts from a good estimate.
  const burstFor = useRef<string | null>(null);
  useEffect(() => {
    const key = s.phase === "countdown" ? `${s.round?.id ?? s.version}` : null;
    if (key && burstFor.current !== key) { burstFor.current = key; void syncBurst(); }
  }, [s.phase, s.round?.id, s.version, syncBurst]);
  const roundNo = s.round?.no ?? s.totalRounds - s.roundsRemaining + (s.phase === "lobby" && s.status === "live" ? 1 : 0);
  const header = `Round ${Math.min(roundNo, s.totalRounds)} of ${s.totalRounds}`;

  // The winner's photo is fetched only while the announcement is showing (the server refuses at any other time).
  const [winnerPhoto, setWinnerPhoto] = useState<{ round: string; url: string } | null>(null);
  const announcing = s.phase === "winner_announced" && s.round?.decided && s.round.winnerName;
  const roundKey = s.round?.id ?? "";
  useEffect(() => {
    if (!announcing || !roundKey) return;
    let live = true;
    const load = async (attempt: number) => {
      const r = await fetch("/api/play/winner-photo", { cache: "no-store" }).catch(() => null);
      const url = r?.ok ? ((await r.json()) as { url: string | null }).url : null;
      if (!live) return;
      if (url) setWinnerPhoto({ round: roundKey, url });
      else if (attempt < 3) setTimeout(() => void load(attempt + 1), 1200);
    };
    void load(0);
    return () => { live = false; };
  }, [announcing, roundKey]);

  let body: React.ReactNode;

  if (s.me.kicked) {
    body = <Card icon={<Ban />} title="You were removed" text="The Game Master took you out of this game."><Button asChild size="lg"><Link href={`/join/${code}`}>Back to the room</Link></Button></Card>;
  } else if (unauthorized) {
    body = <Card icon={<WifiOff />} title="Your session ended" text="Join again to get back in."><Button asChild size="lg"><Link href={`/join/${code}`}>Back to the room</Link></Button></Card>;
  } else if (s.status === "finished") {
    const results = s.results ?? [];
    const myWins = results.filter((r) => r.isMe).length;
    body = (
      <div className="relative flex min-h-0 w-full flex-col gap-4 text-left short:gap-3">
        {myWins > 0 ? <Confetti pieces={30} /> : null}
        <div className="relative z-10 grid shrink-0 justify-items-center gap-2 text-center short:gap-1">
          <TrophyIllustration className="w-28 short:w-20 tiny:w-14" dim={myWins === 0} />
          <h1 className="animate-bounce-in font-display text-5xl font-bold text-brand-yellow short:text-4xl tiny:text-3xl">That&apos;s a wrap!</h1>
          <p className="text-lg text-white/90">{myWins > 0 ? `You won ${myWins} round${myWins === 1 ? "" : "s"}!` : "Thanks for playing."}</p>
        </div>
        <ol className="relative z-10 grid min-h-0 content-start gap-2 overflow-y-auto overscroll-contain rounded-3xl" aria-label="Winners by round" tabIndex={0}>
          {results.map((r) => (
            <li key={r.no} className={cn("flex items-center gap-3 rounded-3xl p-3", r.isMe ? "bg-brand-yellow text-brand-night" : "bg-white/12")}>
              <span className={cn("grid size-10 shrink-0 place-items-center rounded-2xl font-display font-bold", r.isMe ? "bg-brand-night text-brand-yellow" : "bg-brand-yellow text-brand-night")}>{r.no}</span>
              <span className="min-w-0 flex-1">
                <span className={cn("block text-sm", ITEM_WRAP, r.isMe ? "text-brand-night/80" : "text-white/75")}>{r.prompt}</span>
                <span className="block truncate font-display text-xl font-bold">{r.winnerName ? (r.isMe ? "You!" : r.winnerName) : "No winner"}</span>
              </span>
              {r.winnerMs !== null ? <span className="font-mono text-lg font-bold tabular-nums">{formatElapsed(r.winnerMs)}</span> : null}
            </li>
          ))}
        </ol>
        <div className="relative z-10 flex shrink-0 justify-center"><Button asChild variant="outline-light"><Link href="/play">Join another game</Link></Button></div>
      </div>
    );
  } else if (s.status === "canceled") {
    body = (
      <Card icon={<DoorClosed />} title="Game cancelled" text="The Game Master closed this room.">
        <Button asChild variant="outline"><Link href="/play">Join another game</Link></Button>
      </Card>
    );
  } else if (s.phase === "countdown" || (s.phase === "active" && s.round && clock < Date.parse(s.round.openedAt ?? "0"))) {
    // 3-2-1 against the SERVER's timestamps. For "active" we keep counting until the official start.
    const end = s.phase === "countdown" ? s.countdownEndsAt : s.round?.openedAt ?? null;
    const left = secondsUntil(end, now, offsetMs);
    body = (
      <div className="grid justify-items-center gap-3 short:gap-2">
        <h1 className="sr-only">{left > 0 ? `${header} starts in ${left}` : s.phase === "countdown" ? `${header}: waiting for the Game Master to reveal the item` : `${header}: go!`}</h1>
        <p className="inline-block rounded-full bg-white/12 px-4 py-1.5 text-sm font-bold uppercase tracking-widest text-white/90">{header}</p>
        <p className="text-lg text-white/80 tiny:text-base">{left > 0 ? "Get ready…" : s.phase === "countdown" ? "Hold tight…" : "Bring it!"}</p>
        <Countdown left={left} holdAtZero={s.phase === "countdown"} />
        {left === 0 && s.phase === "countdown" ? <p className="text-lg text-white/80">The Game Master will reveal the item in a moment.</p> : null}
        {cam.status !== "ready" ? <div className="mt-2 short:mt-0"><CameraGate compact /></div> : null}
      </div>
    );
  } else if (s.phase === "active" && s.round) {
    body = <CameraStage snapshot={s} clock={clockSync} offsetMs={offsetMs} connection={connLabel[conn].text} />;
  } else if (s.phase === "reviewing") {
    body = (
      <div className="grid justify-items-center gap-3 short:gap-2">
        <p className="inline-block rounded-full bg-white/12 px-4 py-1.5 text-sm font-bold uppercase tracking-widest text-white/90">{header}</p>
        <Mascot mood="judging" className="w-32 short:w-24 tiny:w-16" />
        <h1 className="animate-bounce-in font-display text-5xl font-bold short:text-4xl text-brand-yellow [text-shadow:0_4px_0_hsl(var(--brand-yellow-deep))]">Judging time!</h1>
        <p className="text-lg text-white/90">The Game Master is deciding who wins.</p>
        <div className="mt-2"><WaitingDots /></div>
      </div>
    );
  } else if (s.phase === "winner_announced" && s.round) {
    const r = s.round;
    const more = s.roundsRemaining > 0;
    const mine = s.me.submission;
    body = (
      <div className="flex min-h-0 w-full flex-col gap-4 short:gap-2">
        <WinnerStage
          roundLabel={header}
          prompt={r.prompt}
          winnerName={r.winnerName}
          timeMs={r.winnerMs}
          photoUrl={winnerPhoto?.round === r.id ? winnerPhoto.url : null}
          headline={s.me.isWinner ? "You won!" : undefined}
          heading="h1"
          celebrate
          sublineShortHidden
          subline={s.me.isWinner ? "Everyone is looking at your photo right now." : r.winnerName ? `${r.winnerName} wins this round!` : null}
        />
        <div className="shrink-0 rounded-4xl bg-white/12 p-4 text-center short:p-2" role="status">
          {mine ? (
            <>
              <p className="text-sm font-bold uppercase tracking-widest text-white/75">Your time</p>
              <p className="font-mono text-4xl font-bold tabular-nums text-brand-yellow short:text-3xl tiny:text-2xl">{formatElapsed(mine.rankMs)}</p>
              {mine.timing === "flagged" ? <p className="mt-1 text-sm text-white/75">Adjusted to the server&apos;s own measurement.</p> : null}
              {mine.review === "rejected" ? <p className="mt-2 font-semibold text-brand-coral">Your photo was disqualified this round.</p> : null}
            </>
          ) : (
            <p className="text-white/85">You didn&apos;t send a photo this round. Next one!</p>
          )}
        </div>
        <p className="shrink-0 text-white/80 tiny:text-sm">{more ? "Next round coming up…" : "That was the last round! Final results next."}</p>
      </div>
    );
  } else {
    // waiting: before the game starts, or between rounds
    const started = s.status === "live";
    // Two columns on short landscape screens (phone on its side), one column otherwise.
    body = (
      <div className="grid justify-items-center gap-4 short:gap-2.5 tiny:gap-1.5 landscape:tiny:grid-cols-2 landscape:tiny:items-center landscape:tiny:gap-x-8">
        <div className="grid justify-items-center gap-4 short:gap-2.5 tiny:gap-1.5">
        <Mascot mood="waiting" className="w-28 short:w-20 tiny:w-12" />
        {started ? (
          <div>
            <h1 className="animate-bounce-in font-display text-5xl font-bold text-brand-yellow [text-shadow:0_4px_0_hsl(var(--brand-yellow-deep))] short:text-4xl tiny:text-3xl">Game on!</h1>
            <p className="mt-2 text-xl text-white/90 short:mt-1 short:text-lg">{header} is up next</p>
          </div>
        ) : (
          <div>
            <h1 className="animate-bounce-in font-display text-6xl font-bold text-brand-yellow [text-shadow:0_4px_0_hsl(var(--brand-yellow-deep))] sm:text-7xl short:text-5xl tiny:text-4xl">You&apos;re In!</h1>
            <p className="mt-2 text-xl text-white/90 short:mt-1 short:text-lg">Welcome,</p>
          </div>
        )}
        <p className="max-w-full break-words rounded-full bg-white px-6 py-2 font-display text-3xl font-bold text-primary shadow-pop-purple animate-pop-in short:py-1.5 short:text-2xl">{s.me.nickname}</p>
        </div>
        <div className="grid justify-items-center gap-4 short:gap-2.5 tiny:gap-1.5">
        <PlayerCount count={s.playerCount} />
        <p className="-mt-1 text-white/75">{s.title}</p>
        <CameraGate />
        <div className="mt-2 flex flex-col items-center gap-3 short:mt-0 short:gap-2" role="status">
          <WaitingDots />
          <p className="text-lg font-semibold short:text-base">{started ? "Waiting for the Game Master to start the next round…" : "Waiting for the Game Master to start…"}</p>
        </div>
        </div>
      </div>
    );
  }

  const status = connLabel[conn];
  // Screens built to shrink into the space left (results list, winner photo) get a height-bounded
  // chain; everything else keeps its natural size so overflow scrolls inside <main> and never overlaps.
  const fills = !over ? s.phase === "winner_announced" && !!s.round : s.status === "finished" && !s.me.kicked && !unauthorized;
  return (
    <div className={cn("relative my-auto flex w-full flex-col items-center text-center text-white", fills && "max-h-full min-h-0")}>
      <div className={cn("relative z-10 flex w-full flex-col items-center", fills ? "min-h-0" : "shrink-0")}>{body}</div>
      {!over && !(s.phase === "active" && s.round) ? (
        <p className="relative z-10 mt-10 inline-flex shrink-0 items-center gap-2 rounded-full bg-white/15 px-4 py-2 text-sm font-semibold short:mt-4 short:py-1.5 tiny:mt-2" role="status">
          <span aria-hidden="true" className={cn("size-2.5 rounded-full", status.dot, conn === "live" && "animate-pulse motion-reduce:animate-none")} />
          {status.text}
        </p>
      ) : null}
    </div>
  );
}
