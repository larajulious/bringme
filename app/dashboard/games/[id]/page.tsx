import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { CircleCheck, MonitorPlay } from "lucide-react";

import { FinishedResults } from "@/components/game/finished-results";
import { HostConsole } from "@/components/game/host-console";
import { HostJoinTools } from "@/components/game/host-join-tools";
import { LobbyView } from "@/components/game/lobby-view";
import { QrCode } from "@/components/game/qr-code";
import { TvLinkButton } from "@/components/game/tv-link-button";
import { BackBar, PageHeading } from "@/components/layout/dashboard-shell";
import { formatDate } from "@/components/subscription/access-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { isUuid } from "@/lib/api/http";
import { getMyEntitlement, requireSubscriberPage } from "@/lib/auth/session";
import type { HostSnapshot } from "@/lib/game/types";
import { getSiteUrl, joinUrl } from "@/lib/site/url";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Game", robots: { index: false } };

export default async function GamePage({ params }: { params: Promise<{ id: string }> }) {
  await requireSubscriberPage();
  const { id } = await params;
  if (!isUuid(id)) notFound();

  const supabase = await createClient();
  // RLS + an owner check inside host_game_state(): another host's id is just "not found".
  const [{ data: game }, snapshot, players, rounds] = await Promise.all([
    supabase.from("games").select("id, title, status, join_code, max_players, created_at, game_type").eq("id", id).maybeSingle(),
    supabase.rpc("host_game_state", { p_game: id }),
    supabase.from("players").select("id, nickname").eq("game_id", id).is("kicked_at", null).order("joined_at", { ascending: true }),
    supabase.from("game_rounds").select("round_no, prompt, status").eq("game_id", id).order("round_no", { ascending: true }),
  ]);
  if (game?.game_type === "bingosnap") redirect(`/dashboard/extra-fun/bingosnap/${game.id}`);
  if (!game || snapshot.error || !snapshot.data) notFound();
  if (players.error) throw new Error("Could not load players");
  const state = { ...(snapshot.data as unknown as HostSnapshot), joinCode: game.join_code };
  const roster = players.data ?? [];

  const presentable = game.status === "lobby" || game.status === "live" || game.status === "finished";
  const joinable = game.status === "lobby" || game.status === "live";
  const site = getSiteUrl();
  const url = joinUrl(site.url, game.join_code);
  const back = (
    <BackBar href="/dashboard" label="Dashboard">
      {joinable ? (
        <HostJoinTools
          joinUrl={url} joinCode={game.join_code} title={game.title}
          qr={<QrCode value={url} label={`QR code to join ${game.title}. Room code ${game.join_code}`} className="h-auto w-full" />}
        />
      ) : null}
      {presentable ? (
        <>
          <span className="hidden text-sm text-muted-foreground md:inline">Projecting? Players only see what they should.</span>
          <TvLinkButton gameId={game.id} />
          <Button asChild size="sm" variant="secondary">
            <Link href={`/present/${game.id}`} target="_blank" rel="noopener">
              <MonitorPlay aria-hidden="true" /> Presenter screen<span className="sr-only"> (opens in a new window)</span>
            </Link>
          </Button>
        </>
      ) : null}
    </BackBar>
  );

  if (game.status === "lobby") {
    return (
      <>
        {back}
        <LobbyView
          gameId={game.id} code={game.join_code} joinUrl={url}
          maxPlayers={game.max_players} roundCount={state.totalRounds} items={(rounds.data ?? []).map((r) => r.prompt)} players={roster}
          siteUrlConfigured={site.configured} initialState={state}
        />
      </>
    );
  }

  if (game.status === "live") {
    const maxRounds = Math.min(200, (await getMyEntitlement())?.max_rounds_per_game ?? 0);
    return (
      <>
        {back}
        <PageHeading className="max-sm:sr-only" title="Game on" description="One button runs each step. Players follow along on their phones." />
        <HostConsole gameId={game.id} initial={state} initialPlayers={roster} initialRounds={rounds.data ?? []} maxRounds={maxRounds} />
      </>
    );
  }

  if (game.status === "finished" || game.status === "canceled") {
    return (
      <>
        {back}
        <PageHeading title={game.title} description={`Room code ${game.join_code} · created ${formatDate(game.created_at)}`} />
        <FinishedResults gameId={game.id} initial={state} />
      </>
    );
  }

  return (
    <>
      {back}
      <PageHeading title={game.title} description={`Room code ${game.join_code} · created ${formatDate(game.created_at)}`} />
      <EmptyState icon={<CircleCheck />}
        title="This game hasn't opened yet"
        description={`${state.totalRounds} ${state.totalRounds === 1 ? "round" : "rounds"} · ${roster.length} ${roster.length === 1 ? "player" : "players"}`}
        action={<Badge variant="secondary">{game.status}</Badge>} />
    </>
  );
}
