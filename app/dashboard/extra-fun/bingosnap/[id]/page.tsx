import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Clock, Grid3x3, ListOrdered, MonitorPlay, Trophy, Users } from "lucide-react";

import { BoardPreview } from "@/components/bingosnap/board-preview";
import { BoardEditor } from "@/components/bingosnap/board-editor";
import { BingoHostDashboard } from "@/components/bingosnap/host-dashboard";
import { BingoHostLobby } from "@/components/bingosnap/host-lobby";
import { BackBar, PageHeading } from "@/components/layout/dashboard-shell";
import { formatDate } from "@/components/subscription/access-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { isUuid } from "@/lib/api/http";
import { getMyEntitlement, requireSubscriberPage } from "@/lib/auth/session";
import { editorInitialFrom, formatMinutes } from "@/lib/bingosnap/board";
import type { BingoHostSnapshot, BingoStatus } from "@/lib/bingosnap/types";
import { getSiteUrl, joinUrl } from "@/lib/site/url";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "BingoSnap game", robots: { index: false } };

const statusBadge: Record<BingoStatus, { label: string; variant: "yellow" | "coral" | "success" | "secondary" }> = {
  draft: { label: "Draft", variant: "secondary" },
  lobby: { label: "In lobby", variant: "yellow" },
  active: { label: "Live", variant: "coral" },
  completed: { label: "Completed", variant: "success" },
  cancelled: { label: "Cancelled", variant: "secondary" },
};

export default async function BingoSnapGamePage({ params }: { params: Promise<{ id: string }> }) {
  await requireSubscriberPage();
  const { id } = await params;
  if (!isUuid(id)) notFound();

  const supabase = await createClient();
  // Ownership is checked inside bingo_host_state(): another host's game (or a Bring Me game) is "not found".
  const [{ data, error }, created, entitlement] = await Promise.all([
    supabase.rpc("bingo_host_state", { p_game: id }),
    supabase.from("games").select("created_at").eq("id", id).maybeSingle(),
    getMyEntitlement(),
  ]);
  if (error || !data) notFound();
  const s = data as unknown as BingoHostSnapshot;
  const b = s.board;
  const badge = statusBadge[s.status];
  const closed = s.status === "completed" || s.status === "cancelled";

  // A draft is edited here; once published, this page is the waiting lobby (the card stays editable at /edit).
  if (s.status === "draft") {
    return (
      <>
        <BackLink />
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Badge variant="outline">BingoSnap</Badge>
          <Badge variant={badge.variant}>{badge.label}</Badge>
        </div>
        <PageHeading title={s.title} description="Draft. Tap a square to write what players must photograph, then publish when every square is ready." />
        {/* key: publishing changes the status; the page then shows the lobby */}
        <BoardEditor key={`${s.gameId}:${s.status}`} initial={editorInitialFrom({ ...s, status: "draft" })} maxPlayers={entitlement?.max_players_per_game ?? null} />
      </>
    );
  }

  if (s.status === "lobby") {
    const site = getSiteUrl();
    const url = joinUrl(site.url, s.joinCode);
    return (
      <>
        <BackLink presentId={s.gameId} />
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Badge variant="outline">BingoSnap</Badge>
          <Badge variant={badge.variant}>{badge.label}</Badge>
        </div>
        <PageHeading title={s.title} description="Your lobby is open. Players join by scanning the QR code or entering the room code. Start when everyone is in." />
        <BingoHostLobby
          initial={s} joinUrl={url} siteUrlConfigured={site.configured}
        />
      </>
    );
  }

  return (
    <>
      <BackLink presentId={s.gameId} />
      {s.status === "active" || (s.status === "completed" && s.submissions.length) ? <BingoHostDashboard initial={s} /> : null}
      {s.status === "active" ? null : (
        <>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Badge variant="outline">BingoSnap</Badge>
        <Badge variant={badge.variant}>{badge.label}</Badge>
      </div>
      <PageHeading
        title={s.title}
        description={created.data ? `Created ${formatDate(created.data.created_at)}.` : undefined}
      />

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <section aria-labelledby="board-h" className="min-w-0">
          <h2 id="board-h" className="mb-1 text-xl font-bold text-primary">Your board</h2>
          <p className="mb-4 text-muted-foreground">Each player gets these challenges in their own order.</p>
          <BoardPreview
            size={b.size}
            className="max-w-xl"
            cells={(s.cells ?? []).map((c) => ({ challenge: c.challenge, isFree: c.isFree }))}
          />
        </section>

        <aside aria-label="Game settings" className="grid gap-4">
          {!closed ? (
            <div className="rounded-3xl border bg-card p-5 text-center shadow-card">
              <p className="text-sm font-semibold text-muted-foreground">Room code</p>
              <p className="mt-1 font-mono text-4xl font-bold tracking-[0.2em] text-primary" aria-label={`Room code ${s.joinCode.split("").join(" ")}`}>{s.joinCode}</p>
              <p className="mt-3 text-sm text-muted-foreground">The board is locked now that the game has started.</p>
            </div>
          ) : null}
          <dl className="grid gap-3 rounded-3xl border bg-card p-5 shadow-card">
            <div className="flex items-center justify-between gap-3">
              <dt className="flex items-center gap-2 text-muted-foreground"><Grid3x3 aria-hidden="true" className="size-4" /> Mode</dt>
              <dd className="font-semibold">{b.winMode === "traditional" ? "Traditional Bingo" : "Full Card"}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="flex items-center gap-2 text-muted-foreground">{b.winnerRule === "ranked" ? <ListOrdered aria-hidden="true" className="size-4" /> : <Trophy aria-hidden="true" className="size-4" />} Winners</dt>
              <dd className="font-semibold">{b.winnerRule === "ranked" ? "Ranked list" : "First wins"}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="flex items-center gap-2 text-muted-foreground"><Grid3x3 aria-hidden="true" className="size-4" /> Board</dt>
              <dd className="font-semibold">{b.size}×{b.size}{b.freeSpace ? " · free centre" : ""}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="flex items-center gap-2 text-muted-foreground"><Clock aria-hidden="true" className="size-4" /> Timer</dt>
              <dd className="font-semibold">{formatMinutes(Math.round(b.durationSeconds / 60))}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="flex items-center gap-2 text-muted-foreground"><Users aria-hidden="true" className="size-4" /> Players</dt>
              <dd className="font-semibold">{s.playerCount} / {s.maxPlayers}</dd>
            </div>
          </dl>
        </aside>
      </div>
        </>
      )}
    </>
  );
}

function BackLink({ presentId }: { presentId?: string }) {
  return (
    <BackBar href="/dashboard/extra-fun" label="Extra Fun">
      {presentId ? (
        <Button asChild size="sm" variant="secondary">
          <Link href={`/present/${presentId}`} target="_blank" rel="noopener">
            <MonitorPlay aria-hidden="true" /> Presenter screen<span className="sr-only"> (opens in a new window)</span>
          </Link>
        </Button>
      ) : null}
    </BackBar>
  );
}
