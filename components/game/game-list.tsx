"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { formatDate } from "@/components/subscription/access-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { gameHref } from "@/lib/game/links";
import type { Game } from "@/lib/supabase/database.types";

export type GameListItem = Pick<Game, "id" | "title" | "status" | "join_code" | "created_at"> & Partial<Pick<Game, "game_type">>;

const statusBadge: Record<Game["status"], { label: string; variant: "yellow" | "coral" | "success" | "secondary" }> = {
  draft: { label: "Draft", variant: "secondary" },
  lobby: { label: "In lobby", variant: "yellow" },
  live: { label: "Live", variant: "coral" },
  finished: { label: "Finished", variant: "success" },
  canceled: { label: "Cancelled", variant: "secondary" },
};

export const GAMES_PER_PAGE = 5;

/** Compact, link-per-row list of games, paginated client-side beyond GAMES_PER_PAGE. */
export function GameList({ games, label, pageSize = GAMES_PER_PAGE }: { games: GameListItem[]; label: string; pageSize?: number }) {
  const [requested, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(games.length / pageSize));
  const page = Math.min(requested, pages - 1); // the list can shrink (a game finishes) while a later page is open
  const visible = games.slice(page * pageSize, (page + 1) * pageSize);
  return (
    <div>
      <ul aria-label={label} className="grid gap-3">
      {visible.map((g) => {
        const b = statusBadge[g.status];
        return (
          <li key={g.id}>
            <Link
              href={gameHref(g)}
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-3xl border bg-card px-4 py-3.5 shadow-card sm:px-5 sm:py-4 transition-transform motion-safe:hover:-translate-y-0.5"
            >
              <span className="min-w-0">
                <span className="block truncate font-display text-lg font-semibold text-foreground">{g.title}</span>
                <span className="text-sm text-muted-foreground">
                  Code <span className="font-mono font-semibold">{g.join_code}</span> · {formatDate(g.created_at)}
                </span>
              </span>
              <span className="flex flex-wrap items-center gap-2">
                {g.game_type === "bingosnap" ? <Badge variant="outline">BingoSnap</Badge> : null}
                <Badge variant={b.variant}>{b.label}</Badge>
              </span>
            </Link>
          </li>
        );
      })}
      </ul>
      {pages > 1 ? (
        <nav aria-label={`${label} pages`} className="mt-4 flex items-center justify-between gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setPage(page - 1)} disabled={page === 0} aria-label="Previous page">
            <ChevronLeft aria-hidden="true" /> <span className="hidden sm:inline">Previous</span>
          </Button>
          <p className="text-center text-sm text-muted-foreground" aria-live="polite">
            Page {page + 1} of {pages}<span className="hidden sm:inline"> · {games.length} games</span>
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => setPage(page + 1)} disabled={page >= pages - 1} aria-label="Next page">
            <span className="hidden sm:inline">Next</span> <ChevronRight aria-hidden="true" />
          </Button>
        </nav>
      ) : null}
    </div>
  );
}
