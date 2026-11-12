import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PresenterScreen } from "@/components/game/presenter-screen";
import { QrCode } from "@/components/game/qr-code";
import { isUuid } from "@/lib/api/http";
import { requireSubscriberPage } from "@/lib/auth/session";
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
