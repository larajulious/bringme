import type { Metadata } from "next";
import { Suspense } from "react";

import { BingoPresenterScreen } from "@/components/bingosnap/presenter-screen";
import { LinkEnded, PresenterScreen } from "@/components/game/presenter-screen";
import { QrCode } from "@/components/game/qr-code";
import type { BingoHostSnapshot } from "@/lib/bingosnap/types";
import type { HostSnapshot } from "@/lib/game/types";
import { normalizeScreenToken } from "@/lib/screen/token";
import { getScreenState } from "@/lib/screen/server";
import { getSiteUrl, joinUrl } from "@/lib/site/url";
import { createAdminClient } from "@/lib/supabase/admin";

// The token is in the URL: keep it out of search engines and out of Referer headers.
export const metadata: Metadata = { title: "TV screen", robots: { index: false, follow: false }, referrer: "no-referrer" };

/**
 * TV link: the audience-safe presenter screen for any smart-TV browser, no sign-in. The secret token in the path is
 * the only credential (the host can reset it). Shows exactly what /present/[id] shows: never the item list, timings,
 * reviews or any photo except an official winner's.
 */
export default function TvPage({ params }: { params: Promise<{ token: string }> }) {
  return (
    <Suspense fallback={<div className="h-viewport bg-brand-night" aria-busy="true" />}>
      <TvContent params={params} />
    </Suspense>
  );
}

async function TvContent({ params }: { params: Promise<{ token: string }> }) {
  const token = normalizeScreenToken((await params).token);
  const state = token ? await getScreenState(token) : null;
  if (!token || !state) {
    return <div className="h-viewport overflow-hidden bg-brand-night text-white"><LinkEnded /></div>;
  }

  const gameId = state.gameId as string;
  if (state.gameType === "bingosnap") {
    const b = state as unknown as BingoHostSnapshot;
    const url = joinUrl(getSiteUrl().url, b.joinCode);
    return (
      <BingoPresenterScreen
        gameId={gameId} initial={b} joinUrl={url} screenToken={token}
        qr={<QrCode value={url} label={`QR code to join ${b.title}. Room code ${b.joinCode}`} className="h-auto w-full" />}
      />
    );
  }

  const s = state as unknown as HostSnapshot;
  const code = s.joinCode ?? "";
  const url = joinUrl(getSiteUrl().url, code);
  // Scoped to the game this token resolved to (service role, after the token check above).
  const { data: players } = await createAdminClient().from("players").select("id, nickname")
    .eq("game_id", gameId).is("kicked_at", null).order("joined_at", { ascending: true });
  return (
    <PresenterScreen
      gameId={gameId} initial={s} initialPlayers={players ?? []} joinUrl={url} screenToken={token}
      qr={<QrCode value={url} label={`QR code to join ${s.title}. Room code ${code}`} className="h-auto w-full" />}
    />
  );
}
