import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { BingoPresenterScreen } from "@/components/bingosnap/presenter-screen";
import { PresenterScreen } from "@/components/game/presenter-screen";
import { QrCode } from "@/components/game/qr-code";
import { isUuid } from "@/lib/api/http";
import { requireSubscriberPage } from "@/lib/auth/session";
import type { BingoHostSnapshot } from "@/lib/bingosnap/types";
import type { HostSnapshot } from "@/lib/game/types";
import { getSiteUrl, joinUrl } from "@/lib/site/url";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Presenter screen", robots: { index: false } };

/**
 * Audience-safe screen for the projector/TV. Same access as the host console: signed-in Game Master and
 * the owner check inside host_game_state() (another host's game is just "not found"). Deliberately loads no
 * item list — the room only ever sees what the round reveals.
 */
export default async function PresentPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSubscriberPage();
  const { id } = await params;
  if (!isUuid(id)) notFound();

  const supabase = await createClient();

  // BingoSnap games have their own snapshot and screen (same owner-only access, checked in SQL).
  const { data: kind } = await supabase.from("games").select("game_type").eq("id", id).maybeSingle();
  if (kind?.game_type === "bingosnap") {
    const { data, error } = await supabase.rpc("bingo_host_state", { p_game: id, p_view: "presenter" });
    if (error || !data) notFound();
    const b = data as unknown as BingoHostSnapshot;
    const bingoUrl = joinUrl(getSiteUrl().url, b.joinCode);
    return (
      <BingoPresenterScreen
        gameId={id} initial={b} joinUrl={bingoUrl}
        qr={<QrCode value={bingoUrl} label={`QR code to join ${b.title}. Room code ${b.joinCode}`} className="h-auto w-full" />}
      />
    );
  }

  const [{ data: game }, snapshot, players] = await Promise.all([
    supabase.from("games").select("id, title, join_code").eq("id", id).maybeSingle(),
    supabase.rpc("host_game_state", { p_game: id }),
    supabase.from("players").select("id, nickname").eq("game_id", id).is("kicked_at", null).order("joined_at", { ascending: true }),
  ]);
  if (!game || snapshot.error || !snapshot.data) notFound();

  const state = { ...(snapshot.data as unknown as HostSnapshot), joinCode: game.join_code };
  const url = joinUrl(getSiteUrl().url, game.join_code);

  return (
    <PresenterScreen
      gameId={game.id} initial={state} initialPlayers={players.data ?? []} joinUrl={url}
      qr={<QrCode value={url} label={`QR code to join ${game.title}. Room code ${game.join_code}`} className="h-auto w-full" />}
    />
  );
}
