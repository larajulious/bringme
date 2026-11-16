import type { Metadata } from "next";
import Link from "next/link";
import { Gamepad2 } from "lucide-react";

import { GAME_TYPE_LABEL, GameStatusBadge, formatDateTime } from "@/components/admin/game-badges";
import { GameFilters } from "@/components/admin/game-filters";
import { Pagination } from "@/components/admin/pagination";
import { BackBar, PageHeading } from "@/components/layout/dashboard-shell";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { listGames } from "@/lib/admin/queries";
import { PAGE_SIZE, parseGameListParams } from "@/lib/admin/validation";
import { requireAdminPage } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Games" };

export default async function GamesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; type?: string; owner?: string; page?: string }>;
}) {
  await requireAdminPage();
  const params = parseGameListParams(await searchParams);
  const { q, status, type, owner, page } = params;
  const { rows, total } = await listGames({ ...params, pageSize: PAGE_SIZE });
  const filtered = Boolean(q || status || type || owner);

  return (
    <>
      <BackBar href="/admin/dashboard" label="Dashboard" />
      <PageHeading title="Games" description="Every game created on BringMe!, who created it and how it went." />
      <GameFilters q={q} status={status} type={type} owner={owner} />
      {owner && rows[0]?.owner ? (
        <p className="mb-4 text-sm text-muted-foreground">Showing games by <strong className="text-foreground">{rows[0].owner.display_name ?? rows[0].owner.email}</strong>.</p>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          icon={<Gamepad2 />}
          title={filtered ? "No games match" : "No games yet"}
          description={filtered ? "Try a different search or filter." : "Games appear here as soon as a host creates one."}
          action={filtered ? <Button asChild variant="outline"><Link href="/admin/games">Clear filters</Link></Button> : undefined}
        />
      ) : (
        <>
          <p className="mb-3 text-sm text-muted-foreground"><strong className="tabular-nums text-foreground">{total.toLocaleString("en-US")}</strong> {total === 1 ? "game" : "games"}</p>
          <div className="overflow-x-auto rounded-3xl border bg-card shadow-card">
            <table className="w-full min-w-[56rem] text-left text-sm">
              <caption className="sr-only">Games, their hosts and status</caption>
              <thead className="bg-secondary text-secondary-foreground">
                <tr>
                  {["Game", "Status", "Created by", "Players", "Created", "Ended"].map((h) => (
                    <th key={h} scope="col" className="px-4 py-3 font-display font-semibold">{h}</th>
                  ))}
                  <th scope="col" className="px-4 py-3"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((g) => (
                  <tr key={g.id}>
                    <td className="px-4 py-3">
                      <div className="break-words font-semibold">{g.title}</div>
                      <div className="text-muted-foreground">{GAME_TYPE_LABEL[g.game_type]} · <span className="font-mono">{g.join_code}</span></div>
                    </td>
                    <td className="px-4 py-3"><GameStatusBadge status={g.status} /></td>
                    <td className="px-4 py-3">
                      {g.owner ? (
                        <>
                          <Link href={`/admin/subscribers/${g.owner_id}`} className="font-semibold text-primary underline-offset-4 hover:underline">{g.owner.display_name ?? g.owner.email}</Link>
                          {g.owner.display_name ? <div className="text-muted-foreground">{g.owner.email}</div> : null}
                        </>
                      ) : <span className="text-muted-foreground">Unknown host</span>}
                    </td>
                    <td className="px-4 py-3 tabular-nums">{g.players} / {g.max_players}</td>
                    <td className="px-4 py-3">{formatDateTime(g.created_at)}</td>
                    <td className="px-4 py-3">{formatDateTime(g.finished_at)}</td>
                    <td className="px-4 py-3 text-right">
                      <Button asChild size="sm" variant="outline">
                        <Link href={`/admin/games/${g.id}`}>View<span className="sr-only"> {g.title}</span></Link>
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination basePath="/admin/games" params={{ q, status, type, owner }} page={page} pageSize={PAGE_SIZE} total={total} />
        </>
      )}
    </>
  );
}
