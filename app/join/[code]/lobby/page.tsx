import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";

import { Loading } from "@/components/ui/loading";
import { BingoPlayerScreen } from "@/components/bingosnap/player-screen";
import { PlayerGame } from "@/components/game/player-game";
import { findBingoSession, getBingoRoomInfo } from "@/lib/bingosnap/server";
import { PLAYER_COOKIE, getPlayerState } from "@/lib/players/session";
import { ROOM_CODE } from "@/lib/site/url";

/**
 * The player's game screen (waiting room → countdown → rounds → winner).
 * Server-renders the authoritative snapshot, so a refresh restores the exact
 * current state. Authorized by the HttpOnly cookie, and only for the player's own room.
 */
export default function LobbyPage({ params }: { params: Promise<{ code: string }> }) {
  return (
    <Suspense fallback={<Loading className="min-h-[40vh] rounded-3xl bg-card" />}>
      <LobbyContent params={params} />
    </Suspense>
  );
}

async function LobbyContent({ params }: { params: Promise<{ code: string }> }) {
  const code = (await params).code.toUpperCase();
  if (!ROOM_CODE.test(code)) notFound();

  const token = (await cookies()).get(PLAYER_COOKIE)?.value;
  // A BingoSnap room: the participant's own BingoSnap screen (same cookie session).
  if ((await getBingoRoomInfo(code))?.gameType === "bingosnap") {
    const mine = await findBingoSession(token, code);
    if (!mine) redirect(`/join/${code}`);
    return <BingoPlayerScreen code={code} initial={mine} />;
  }

  const state = await getPlayerState(token);
  if (!state || state.joinCode !== code) redirect(`/join/${code}`);

  return <PlayerGame code={code} initial={state} />;
}
