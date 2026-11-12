import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { BoardEditor } from "@/components/bingosnap/board-editor";
import { BackBar, PageHeading } from "@/components/layout/dashboard-shell";
import { Badge } from "@/components/ui/badge";
import { isUuid } from "@/lib/api/http";
import { getMyEntitlement, requireSubscriberPage } from "@/lib/auth/session";
import { editorInitialFrom } from "@/lib/bingosnap/board";
import type { BingoHostSnapshot } from "@/lib/bingosnap/types";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Edit BingoSnap card", robots: { index: false } };

/** Editing a published card while players wait in the lobby. Drafts are edited on the game page; started games are locked. */
export default async function EditBingoCardPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSubscriberPage();
  const { id } = await params;
  if (!isUuid(id)) notFound();

  const supabase = await createClient();
  const [{ data, error }, entitlement] = await Promise.all([supabase.rpc("bingo_host_state", { p_game: id }), getMyEntitlement()]);
  if (error || !data) notFound();
  const s = data as unknown as BingoHostSnapshot;
  if (s.status !== "lobby") redirect(`/dashboard/extra-fun/bingosnap/${id}`);

  return (
    <>
      <BackBar href={`/dashboard/extra-fun/bingosnap/${id}`} label="Back to the lobby" />
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Badge variant="outline">BingoSnap</Badge>
        <Badge variant="yellow">In lobby</Badge>
      </div>
      <PageHeading
        title={s.title}
        description={`Room code ${s.joinCode} · ${s.playerCount} of ${s.maxPlayers} players waiting. Changes apply as soon as you save; the card locks when the game starts.`}
      />
      <BoardEditor key={`${s.gameId}:${s.status}`} initial={editorInitialFrom({ ...s, status: "lobby" })} maxPlayers={entitlement?.max_players_per_game ?? null} />
    </>
  );
}
