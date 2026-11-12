import { Clock, Grid3x3, UsersRound } from "lucide-react";

import { BingoMark } from "@/components/bingosnap/bingo-mark";
import { JoinForm } from "@/components/game/join-form";
import { formatMinutes } from "@/lib/bingosnap/board";
import type { BingoRoomInfo } from "@/lib/bingosnap/types";

type Room = Extract<BingoRoomInfo, { gameType: "bingosnap" }>;

/** The BingoSnap invitation behind the QR code: title, how to win, headcount, and the existing name form. */
export function BingoJoinInvite({ code, room }: { code: string; room: Room }) {
  const b = room.board;
  return (
    <div className="relative my-auto mt-20 animate-rise short:mt-14 tiny:mt-10">
      <BingoMark className="absolute -top-[4.5rem] left-1/2 w-28 -translate-x-1/2 short:-top-[3.5rem] short:w-20 tiny:-top-[2.75rem] tiny:w-16" />
      <div className="grid gap-6 rounded-4xl bg-card px-6 pb-7 pt-14 shadow-card sm:px-8 short:gap-4 short:pb-5 short:pt-10 tiny:gap-2.5 tiny:pb-3 tiny:pt-8">
        <div className="text-center">
          <p className="inline-block rounded-full bg-secondary px-4 py-1 text-sm font-bold uppercase tracking-widest text-secondary-foreground">BingoSnap invite</p>
          <h1 className="mt-3 break-words font-display text-4xl font-bold leading-tight text-primary short:mt-2 short:text-3xl tiny:text-2xl">{room.title}</h1>
          {b ? (
            <ul className="mt-3 flex flex-wrap justify-center gap-2 text-sm font-bold short:mt-2" aria-label="Game rules">
              <li className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-1 text-primary-foreground">
                <Grid3x3 aria-hidden="true" className="size-4" />
                {b.winMode === "traditional" ? "Traditional Bingo" : "Full Card"} · {b.size}×{b.size}
              </li>
              <li className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-3 py-1 text-secondary-foreground">
                <Clock aria-hidden="true" className="size-4" />{formatMinutes(Math.round(b.durationSeconds / 60))}
              </li>
            </ul>
          ) : null}
          <p className="mt-3 inline-flex items-center gap-2 rounded-full bg-brand-yellow/35 px-4 py-1.5 text-sm font-bold text-brand-night short:mt-2">
            <UsersRound className="size-4" aria-hidden="true" />
            {room.playerCount === 0 ? "Be the first one in!" : `${room.playerCount} ${room.playerCount === 1 ? "player" : "players"} waiting`}
          </p>
        </div>
        <JoinForm code={code} />
        <p className="text-center text-sm text-muted-foreground tiny:text-xs">No account needed. Photos you take stay on your phone.</p>
      </div>
    </div>
  );
}
