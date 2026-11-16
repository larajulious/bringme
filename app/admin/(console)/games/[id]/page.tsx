import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { GAME_TYPE_LABEL, GameStatusBadge, formatDateTime } from "@/components/admin/game-badges";
import { RoomClose } from "@/components/admin/room-close";
import { BackBar, PageHeading } from "@/components/layout/dashboard-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getGameDetail } from "@/lib/admin/queries";
import { requireAdminPage } from "@/lib/auth/session";
import { formatElapsed } from "@/lib/game/timing";

export const metadata: Metadata = { title: "Game details" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <Card className="min-w-0">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-3">
        <CardTitle className="text-lg">{title}</CardTitle>
        {aside}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
      {items.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-sm text-muted-foreground">{k}</dt>
          <dd className="break-words font-semibold">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Table({ caption, head, children }: { caption: string; head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-2xl border">
      <table className="w-full min-w-[32rem] text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-secondary text-secondary-foreground">
          <tr>{head.map((h) => <th key={h} scope="col" className="px-3 py-2 font-display font-semibold">{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y">{children}</tbody>
      </table>
    </div>
  );
}

export default async function GameDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdminPage();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const detail = await getGameDetail(id);
  if (!detail) notFound();
  const { game, owner, players, rounds, board, claims } = detail;
  const nick = new Map(players.map((p) => [p.id, p.nickname]));
  const active = game.status === "lobby" || game.status === "live";
  const activePlayers = players.filter((p) => !p.kicked_at).length;

  return (
    <>
      <BackBar href="/admin/games" label="All games">{active ? <RoomClose gameId={game.id} title={game.title} /> : null}</BackBar>
      <PageHeading title={game.title} description={`${GAME_TYPE_LABEL[game.game_type]} · room code ${game.join_code}`} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Game" aside={<GameStatusBadge status={game.status} />}>
          <Facts items={[
            ["Type", GAME_TYPE_LABEL[game.game_type]],
            ["Room code", <span key="c" className="font-mono">{game.join_code}</span>],
            ["Phase", <span key="p" className="capitalize">{game.phase.replace(/_/g, " ")}</span>],
            ["Players", `${activePlayers} of ${game.max_players} max`],
            ["Created", formatDateTime(game.created_at)],
            ["Started", formatDateTime(game.started_at)],
            ["Ended", formatDateTime(game.finished_at)],
            ["Archived by host", game.archived_at ? formatDateTime(game.archived_at) : "No"],
          ]} />
        </Section>

        <Section title="Created by">
          {owner ? (
            <Facts items={[
              ["Name", owner.display_name ?? "—"],
              ["Email", owner.email ?? "—"],
              ["Subscriber", <Link key="s" href={`/admin/subscribers/${owner.id}`} className="text-primary underline-offset-4 hover:underline">View account</Link>],
              ["Other games", <Link key="g" href={`/admin/games?owner=${owner.id}`} className="text-primary underline-offset-4 hover:underline">All games by this host</Link>],
            ]} />
          ) : <p className="text-muted-foreground">This host&apos;s account no longer exists.</p>}
        </Section>

        {board ? (
          <Section title="Bingo card">
            <Facts items={[
              ["Board", `${board.board_size} × ${board.board_size}${board.free_space ? " with free space" : ""}`],
              ["Win mode", board.win_mode === "full_card" ? "Full card" : "Line (traditional)"],
              ["Winner rule", board.winner_rule === "first" ? "First valid claim" : "Ranked"],
              ["Hunt length", `${Math.round(board.duration_seconds / 60)} min`],
              ["Hunt started", formatDateTime(board.hunt_started_at)],
              ["Hunt ended", formatDateTime(board.hunt_ends_at)],
            ]} />
          </Section>
        ) : null}

        <Section title={`Players (${players.length})`}>
          {players.length ? (
            <Table caption="Players in this game" head={["Nickname", "Joined", "Status"]}>
              {players.map((p) => (
                <tr key={p.id}>
                  <td className="break-words px-3 py-2 font-semibold">{p.nickname}</td>
                  <td className="px-3 py-2">{formatDateTime(p.joined_at)}</td>
                  <td className="px-3 py-2">{p.kicked_at ? <Badge variant="coral">Removed</Badge> : <Badge variant="secondary">Joined</Badge>}</td>
                </tr>
              ))}
            </Table>
          ) : <p className="text-muted-foreground">Nobody joined this game.</p>}
        </Section>
      </div>

      {game.game_type === "bring_me" ? (
        <div className="mt-4">
          <Section title={`Rounds (${rounds.length})`}>
            {rounds.length ? (
              <Table caption="Rounds and winners" head={["#", "Item", "Status", "Winner", "Time"]}>
                {rounds.map((r) => (
                  <tr key={r.id}>
                    <td className="px-3 py-2 tabular-nums">{r.round_no}</td>
                    <td className="break-words px-3 py-2">{r.prompt}</td>
                    <td className="px-3 py-2 capitalize">{r.status}</td>
                    <td className="px-3 py-2 font-semibold">
                      {r.winner_player_id ? nick.get(r.winner_player_id) ?? "Removed player" : r.winner_confirmed_at ? <span className="font-normal text-muted-foreground">No winner</span> : "—"}
                    </td>
                    <td className="px-3 py-2 font-mono tabular-nums">{r.winner_rank_ms !== null ? formatElapsed(r.winner_rank_ms) : "—"}</td>
                  </tr>
                ))}
              </Table>
            ) : <p className="text-muted-foreground">No rounds were added.</p>}
          </Section>
        </div>
      ) : (
        <div className="mt-4">
          <Section title={`Bingo claims (${claims.length})`}>
            {claims.length ? (
              <Table caption="Bingo claims" head={["Player", "Attempt", "Pattern", "Status", "Submitted"]}>
                {claims.map((c) => (
                  <tr key={c.id}>
                    <td className="px-3 py-2 font-semibold">{nick.get(c.player_id) ?? "Removed player"}</td>
                    <td className="px-3 py-2 tabular-nums">{c.attempt_no}</td>
                    <td className="px-3 py-2 capitalize">{c.pattern.replace(/_/g, " ")}</td>
                    <td className="px-3 py-2">
                      <Badge variant={c.status === "verified" ? "success" : c.status === "rejected" ? "coral" : "yellow"}>{c.status}</Badge>
                    </td>
                    <td className="px-3 py-2">{formatDateTime(c.submitted_at)}</td>
                  </tr>
                ))}
              </Table>
            ) : <p className="text-muted-foreground">No bingo claims yet.</p>}
          </Section>
        </div>
      )}
    </>
  );
}
