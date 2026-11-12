import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { Ban, DoorClosed, SearchX, UsersRound } from "lucide-react";

import { BingoJoinInvite } from "@/components/bingosnap/join-invite";
import { Mascot } from "@/components/brand/mascot";
import { JoinForm } from "@/components/game/join-form";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Loading } from "@/components/ui/loading";
import { PLAYER_COOKIE, getPlayerState } from "@/lib/players/session";
import { getRoomInfo } from "@/lib/players/room";
import type { BingoRoomInfo } from "@/lib/bingosnap/types";
import { ROOM_CODE } from "@/lib/site/url";
import { findBingoSession, getBingoRoomInfo } from "@/lib/bingosnap/server";

/**
 * Landing page for the QR code. Server-validates the room before showing the
 * form, and sends returning players (valid cookie for THIS room) straight to the lobby.
 */
export default function JoinPage({ params }: { params: Promise<{ code: string }> }) {
  return (
    <Suspense fallback={<Loading className="min-h-[40vh] rounded-3xl bg-card" />}>
      <JoinContent params={params} />
    </Suspense>
  );
}

async function JoinContent({ params }: { params: Promise<{ code: string }> }) {
  const code = (await params).code.toUpperCase();
  if (!ROOM_CODE.test(code)) notFound();

  const token = (await cookies()).get(PLAYER_COOKIE)?.value;
  // BingoSnap rooms share the join code, cookie and join API; only the screens differ.
  const bingo = await getBingoRoomInfo(code);
  if (bingo?.gameType === "bingosnap") return <BingoJoin code={code} token={token} room={bingo} />;

  const mine = await getPlayerState(token);
  if (mine && mine.joinCode === code) {
    if (!mine.me.kicked) redirect(`/join/${code}/lobby`);
    return <Notice icon={<Ban />} title="You were removed from this game" text="The Game Master took you out of this room." />;
  }

  const room = await getRoomInfo(code);
  if (!room) return <Notice icon={<SearchX />} title="We can't find that room" text="Check the code and try again, or scan the QR code once more." />;
  if (room.status === "finished" || room.status === "canceled") {
    return <Notice icon={<DoorClosed />} title="This game has ended" text="Ask your Game Master to start a new one." />;
  }
  if (room.status === "live") return <Notice icon={<DoorClosed />} title="This game already started" text="New players can only join before the Game Master starts. Ask them to open a new lobby." />;
  if (room.status === "draft") return <Notice icon={<DoorClosed />} title="This room isn't open yet" text="Hang on, the Game Master is still setting up." />;
  if (room.playerCount >= room.maxPlayers) return <Notice icon={<UsersRound />} title="Player limit reached" text="This room is full. Ask your Game Master to make room for you." />;

  return (
    <div className="relative my-auto mt-24 animate-rise short:mt-16 tiny:mt-12">
      <Mascot mood="happy" className="absolute -top-[5.75rem] left-1/2 w-32 -translate-x-1/2 short:-top-[4.25rem] short:w-24 tiny:-top-[3.4rem] tiny:w-20" />
      <div className="grid gap-6 rounded-4xl bg-card px-6 pb-7 pt-14 shadow-card sm:px-8 short:gap-4 short:pb-5 short:pt-10 tiny:gap-2.5 tiny:pb-3 tiny:pt-8">
        <div className="text-center">
          <p className="inline-block rounded-full bg-secondary px-4 py-1 text-sm font-bold uppercase tracking-widest text-secondary-foreground">You&apos;re invited</p>
          <h1 className="mt-3 break-words font-display text-4xl font-bold leading-tight text-primary short:mt-2 short:text-3xl tiny:text-2xl">{room.title}</h1>
          <p className="mt-3 short:mt-2 inline-flex items-center gap-2 rounded-full bg-brand-yellow/35 px-4 py-1.5 text-sm font-bold text-brand-night">
            <UsersRound className="size-4" aria-hidden="true" />
            {room.playerCount === 0 ? "Be the first one in!" : `${room.playerCount} ${room.playerCount === 1 ? "player" : "players"} waiting`}
          </p>
        </div>
        <JoinForm code={code} />
        <p className="text-center text-sm text-muted-foreground tiny:text-xs">No account needed. You&apos;ll use your phone camera to play.</p>
      </div>
    </div>
  );
}

async function BingoJoin({ code, token, room }: { code: string; token: string | undefined; room: Extract<BingoRoomInfo, { gameType: "bingosnap" }> }) {
  const mine = await findBingoSession(token, code);
  if (mine) {
    if (mine.me.state !== "removed") redirect(`/join/${code}/lobby`);
    return <Notice icon={<Ban />} title="You were removed from this game" text="The Game Master took you out of this room." />;
  }
  if (room.status === "finished" || room.status === "canceled") {
    return <Notice icon={<DoorClosed />} title="This game has ended" text="Ask your Game Master to start a new one." />;
  }
  if (room.status === "live") return <Notice icon={<DoorClosed />} title="This game already started" text="New players can only join before the Game Master starts. Ask them to open a new lobby." />;
  if (room.status === "draft" || !room.board) return <Notice icon={<DoorClosed />} title="This room isn't open yet" text="Hang on, the Game Master is still setting up the card." />;
  if (room.playerCount >= room.maxPlayers) return <Notice icon={<UsersRound />} title="Player limit reached" text="This room is full. Ask your Game Master to make room for you." />;
  return <BingoJoinInvite code={code} room={room} />;
}

function Notice({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="my-auto">
      <EmptyState icon={icon} title={title} description={text}
        action={<Button asChild variant="outline"><Link href="/play">Enter a different code</Link></Button>} />
    </div>
  );
}
