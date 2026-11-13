"use client";

import { DoorClosed, Star, Users } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

import { Backdrop } from "@/components/brand/backdrop";
import { Logo } from "@/components/brand/logo";
import { Mascot } from "@/components/brand/mascot";
import { Confetti } from "@/components/game/confetti";
import { Countdown } from "@/components/game/countdown";
import { PresenterControls } from "@/components/game/presenter-controls";
import { useChrome } from "@/components/game/presenter-screen";
import { TrophyIllustration } from "@/components/game/trophy";
import { useGameSync, useNow } from "@/components/game/use-game-sync";
import { modeText } from "@/lib/bingosnap/board";
import { patternLabel } from "@/lib/bingosnap/completion";
import type { BingoHostSnapshot } from "@/lib/bingosnap/types";
import { secondsUntil, type FetchResult } from "@/lib/game/sync";
import { cn } from "@/lib/utils";

async function fetchPresenterSnapshot(gameId: string): Promise<FetchResult<BingoHostSnapshot>> {
  const r = await fetch(`/api/host/bingosnap/${gameId}?view=presenter`, { cache: "no-store" }).catch(() => null);
  if (!r) return { status: "error" };
  if (r.status === 401) return { status: "unauthorized" };
  if (!r.ok) return { status: "error" };
  return { status: "ok", state: (await r.json()) as BingoHostSnapshot };
}

const clockText = (secs: number) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;

/**
 * Audience-safe BingoSnap screen for the projector / TV (/present/[id]). Display only. It reads the
 * server's presenter snapshot (no rejection reasons, no claimed squares, challenges only after the hunt
 * starts) and follows lobby → 3-2-1 → hunt → results on its own.
 */
export function BingoPresenterScreen({ gameId, initial, qr, joinUrl }: {
  gameId: string; initial: BingoHostSnapshot; qr: ReactNode; joinUrl: string;
}) {
  const { state: s, conn, offsetMs } = useGameSync<BingoHostSnapshot>({
    gameId, role: "host", initial, fetchSnapshot: () => fetchPresenterSnapshot(gameId), deadlineOf: (x) => x.board.huntEndsAt,
  });
  const chrome = useChrome();
  const b = s.board;
  const live = s.status === "active";
  const now = useNow(live, 250);
  const beforeHunt = live && (!b.huntStartedAt || Date.parse(b.huntStartedAt) > now + offsetMs);
  const left = secondsUntil(b.huntEndsAt, now, offsetMs);
  const over = live && !beforeHunt && (b.huntOver || left === 0 || s.phase !== "active");

  let body: ReactNode;
  if (s.status === "cancelled") body = <Ended title={s.title} />;
  else if (s.status === "completed" || b.resultsAt) body = <Results s={s} />;
  else if (s.status !== "active") body = <Lobby s={s} qr={qr} joinUrl={joinUrl} />;
  else if (beforeHunt) body = <Starting s={s} left={secondsUntil(s.countdownEndsAt ?? b.huntStartedAt, now, offsetMs)} />;
  else body = <Hunt s={s} left={left} over={over} />;

  return (
    <div className={cn("relative h-viewport overflow-hidden bg-brand-night text-white", chrome.idle && "cursor-none")}>
      {body}
      <PresenterControls
        conn={conn} idle={chrome.idle} fullscreen={chrome.fullscreen} onToggleFullscreen={chrome.toggleFullscreen}
        joinUrl={joinUrl} joinCode={s.joinCode} qr={qr} title={s.title}
      />
    </div>
  );
}

function Lobby({ s, qr, joinUrl }: { s: BingoHostSnapshot; qr: ReactNode; joinUrl: string }) {
  const players = s.players.filter((p) => p.state === "active");
  const seen = useRef(new Set(players.map((p) => p.id)));
  useEffect(() => { for (const p of players) seen.current.add(p.id); });
  const mode = modeText(s.board.winMode);
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
        <p className="text-[clamp(1.125rem,3.2dvh,1.875rem)] text-white/90">
          BingoSnap · {mode.name} · {s.board.size}×{s.board.size} · scan or go to <span className="font-mono font-bold text-brand-yellow">{joinUrl.replace(/^https?:\/\//, "")}</span>
        </p>
        <div>
          <p className="mb-2 text-[clamp(0.9rem,2.2dvh,1.25rem)] font-semibold uppercase tracking-widest text-white/75">Room code</p>
          <p role="img" aria-label={`Room code ${s.joinCode.split("").join(" ")}`} className="flex gap-[0.6vw] portrait:justify-center">
            {s.joinCode.split("").map((ch, i) => (
              <span key={i} aria-hidden="true" className="grid size-[min(6.5rem,11dvh)] place-items-center rounded-2xl bg-white font-display text-[min(4.75rem,8dvh)] font-bold text-primary shadow-pop">{ch}</span>
            ))}
          </p>
        </div>
        <div className="grid min-h-0 gap-3">
          <p className="flex items-center gap-2 font-display text-[clamp(1.5rem,4.4dvh,2.5rem)] font-semibold portrait:justify-center" aria-live="polite">
            <Users aria-hidden="true" className="size-[1em] text-brand-yellow" />
            <span key={players.length} className="inline-block animate-pop-in text-brand-yellow motion-reduce:animate-none">{players.length}</span>
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

function Starting({ s, left }: { s: BingoHostSnapshot; left: number }) {
  return (
    <div className="relative isolate grid h-full place-items-center content-center gap-[2dvh] text-center">
      <Backdrop />
      <h1 className="relative font-display text-[clamp(2rem,6dvh,3.5rem)] font-bold">{s.title}</h1>
      <Countdown left={left} large flash="absolute" />
      <p className="relative text-[clamp(1.125rem,3.2dvh,1.875rem)] text-white/90">Get your cameras ready!</p>
    </div>
  );
}

/** The hunt: timer, the challenges (same for everyone, in any order), who has Bingo so far. */
function Hunt({ s, left, over }: { s: BingoHostSnapshot; left: number; over: boolean }) {
  const b = s.board;
  const cells = s.cells ?? [];
  const verified = s.submissions.filter((x) => x.status === "verified").sort((a, c) => (a.rank ?? 99) - (c.rank ?? 99));
  // Who should come forward to the Game Master, in the order the claims were received.
  // (First Bingo wins + a verified winner: nobody else needs to come forward.)
  const line = b.winnerRule === "first" && verified.length ? []
    : s.submissions.filter((x) => x.status === "pending").sort((a, c) => Date.parse(a.submittedAt) - Date.parse(c.submittedAt));
  const CALL = 6;
  const dense = b.size >= 5;
  return (
    <div className="relative isolate grid h-full grid-cols-[minmax(0,1fr)_minmax(0,22rem)] gap-x-[3vw] px-[3vw] py-[3dvh] portrait:grid-cols-1 portrait:grid-rows-[auto_1fr_auto] portrait:gap-y-[2dvh]">
      <Backdrop />
      <div className="relative grid min-h-0 content-center justify-items-center gap-[2dvh]">
        <h1 className="font-display text-[clamp(1.5rem,4.5dvh,3rem)] font-bold">{s.title}</h1>
        <div
          role="list" aria-label="Photo challenges"
          className="grid aspect-square w-[min(72dvh,100%)] gap-[1dvh] rounded-3xl bg-primary p-[1.2dvh] shadow-card"
          style={{ gridTemplateColumns: `repeat(${b.size}, minmax(0, 1fr))` }}
        >
          {cells.map((c) => (
            <div key={c.id} role="listitem" className={cn(
              "flex min-w-0 items-center justify-center overflow-hidden rounded-2xl p-[0.8dvh] text-center font-semibold leading-tight",
              dense ? "text-[clamp(0.6rem,1.9dvh,1.1rem)]" : "text-[clamp(0.8rem,2.6dvh,1.5rem)]",
              c.isFree ? "bg-brand-yellow font-display font-bold uppercase text-brand-night" : "bg-card text-foreground",
            )}>
              {c.isFree ? <span className="flex flex-col items-center"><Star aria-hidden="true" className="size-[1.4em] fill-current" />Free</span> : c.challenge}
            </div>
          ))}
        </div>
      </div>
      <div className="relative grid min-h-0 content-center gap-[3dvh] text-center">
        {over ? (
          <p className="font-display text-[clamp(1.75rem,5dvh,3rem)] font-bold text-brand-yellow">Time&apos;s up!<span className="mt-1 block text-[clamp(1rem,2.6dvh,1.5rem)] font-semibold text-white/85">Checking the claims…</span></p>
        ) : (
          <p role="timer" aria-label={`Time left ${clockText(left)}`} className={cn("mx-auto rounded-3xl bg-brand-yellow px-[2vw] py-[1.5dvh] font-mono text-[clamp(2.5rem,10dvh,6rem)] font-bold tabular-nums text-brand-night", left <= 30 && "animate-pulse motion-reduce:animate-none")}>
            {clockText(left)}
          </p>
        )}
        <div className="rounded-3xl bg-white/10 p-[2dvh]">
          <p className="font-display text-[clamp(1.125rem,3dvh,1.75rem)] font-semibold">
            {s.submissions.length ? <><span className="text-brand-yellow">{s.submissions.length}</span> {s.submissions.length === 1 ? "Bingo claim" : "Bingo claims"} in</> : "Be the first to shout BINGO!"}
          </p>
          {line.length ? (
            <div className="mt-[1.5dvh] grid gap-[1dvh] text-left">
              <p className="text-center text-[clamp(0.875rem,2.2dvh,1.25rem)] font-bold uppercase tracking-widest text-brand-yellow">Come forward with your phone</p>
              <ol className="grid gap-[0.8dvh]" aria-label="Claims waiting to be checked, in order">
                {line.slice(0, CALL).map((x, i) => (
                  <li key={x.id} className={cn("flex animate-pop-in items-center gap-3 rounded-2xl px-4 py-[0.8dvh] motion-reduce:animate-none", i === 0 ? "bg-brand-yellow text-brand-night" : "bg-white/10")}>
                    <span className={cn("grid size-[3dvh] min-w-7 place-items-center rounded-full font-display text-[clamp(0.875rem,2dvh,1.125rem)] font-bold", i === 0 ? "bg-brand-night text-brand-yellow" : "bg-white/20")}>{i + 1}</span>
                    <span className="truncate font-display text-[clamp(1rem,2.6dvh,1.5rem)] font-semibold">{x.nickname}</span>
                  </li>
                ))}
              </ol>
              {line.length > CALL ? <p className="text-center text-[clamp(0.875rem,2.2dvh,1.25rem)] text-white/80">+{line.length - CALL} more in line</p> : null}
            </div>
          ) : null}
          {verified.length ? (
            <ol className="mt-[1.5dvh] grid gap-[1dvh]" aria-label="Verified Bingos">
              {verified.slice(0, line.length ? 3 : 5).map((v) => (
                <li key={v.id} className="flex animate-pop-in items-center gap-3 rounded-2xl bg-white/15 px-4 py-[1dvh] text-left motion-reduce:animate-none">
                  <span className="grid size-[3.5dvh] min-w-8 place-items-center rounded-full bg-brand-yellow font-display font-bold text-brand-night">{v.rank ?? "•"}</span>
                  <span className="truncate font-display text-[clamp(1.125rem,3dvh,1.75rem)] font-semibold">{v.nickname}</span>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Official results: champion(s) in order. Falls back to verified claims if the host skipped "announce". */
function Results({ s }: { s: BingoHostSnapshot }) {
  const entries = s.board.resultsAt && s.results
    ? s.results.entries
    : s.submissions.filter((x) => x.status === "verified").sort((a, c) => (a.rank ?? 99) - (c.rank ?? 99))
        .map((x) => ({ rank: x.rank ?? 0, playerId: x.playerId, nickname: x.nickname, submittedAt: x.submittedAt, pattern: x.pattern }));
  const first = s.board.winnerRule === "first";
  const shown = first ? entries.slice(0, 1) : entries.slice(0, 8);
  return (
    <div className="relative isolate flex h-full flex-col items-center gap-[2.5dvh] bg-gradient-to-b from-primary to-brand-night px-[4vw] py-[4dvh] text-center">
      <Backdrop />
      <Confetti pieces={40} />
      <TrophyIllustration className="relative z-10 w-[min(9rem,15dvh)] animate-drop-in motion-reduce:animate-none" />
      <h1 className="relative z-10 font-display text-[clamp(2.5rem,8dvh,5rem)] font-bold leading-tight text-brand-yellow">{shown.length ? (first ? "BINGO!" : "Final results") : "That's a wrap!"}</h1>
      {shown.length ? (
        <ol className="relative z-10 grid w-full max-w-3xl gap-[1.5dvh]" aria-label="Winners">
          {shown.map((e, i) => (
            <li key={e.playerId} className="flex animate-rise items-center gap-[2vw] rounded-3xl bg-white/10 px-[2vw] py-[1.5dvh] text-left motion-reduce:animate-none" style={{ animationDelay: `${300 + i * 120}ms` }}>
              {first ? null : <span className="grid size-[min(3.5rem,7dvh)] shrink-0 place-items-center rounded-2xl bg-brand-yellow font-display text-[min(1.75rem,3.5dvh)] font-bold text-brand-night">{e.rank}</span>}
              <span className="min-w-0 flex-1 truncate font-display text-[clamp(1.75rem,5.5dvh,3.5rem)] font-bold text-brand-yellow">{e.nickname}</span>
              <span className="shrink-0 text-[clamp(0.9rem,2.4dvh,1.375rem)] text-white/80">{patternLabel(e.pattern)}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="relative z-10 text-[clamp(1.125rem,3.4dvh,1.875rem)] text-white/85">No Bingo this time. Thanks for playing {s.title}!</p>
      )}
    </div>
  );
}

function Ended({ title }: { title: string }) {
  return (
    <div className="relative isolate grid h-full place-items-center content-center gap-4 text-center">
      <Backdrop />
      <DoorClosed aria-hidden="true" className="size-24 text-brand-yellow" />
      <h1 className="font-display text-[clamp(2.5rem,8dvh,4.5rem)] font-bold">Game ended</h1>
      <p className="text-[clamp(1.125rem,3.4dvh,1.875rem)] text-white/85">Thanks for playing {title}!</p>
    </div>
  );
}
