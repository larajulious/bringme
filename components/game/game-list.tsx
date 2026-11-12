import Link from "next/link";

import { formatDate } from "@/components/subscription/access-badge";
import { Badge } from "@/components/ui/badge";
import type { Game } from "@/lib/supabase/database.types";

export type GameListItem = Pick<Game, "id" | "title" | "status" | "join_code" | "created_at"> & Partial<Pick<Game, "game_type">>;

/** Each game type has its own host screen. */
const gameHref = (g: GameListItem) => (g.game_type === "bingosnap" ? `/dashboard/extra-fun/bingosnap/${g.id}` : `/dashboard/games/${g.id}`);

const statusBadge: Record<Game["status"], { label: string; variant: "yellow" | "coral" | "success" | "secondary" }> = {
  draft: { label: "Draft", variant: "secondary" },
  lobby: { label: "In lobby", variant: "yellow" },
  live: { label: "Live", variant: "coral" },
  finished: { label: "Finished", variant: "success" },
  canceled: { label: "Cancelled", variant: "secondary" },
};

/** Compact, link-per-row list of games. */
export function GameList({ games, label }: { games: GameListItem[]; label: string }) {
  return (
    <ul aria-label={label} className="grid gap-3">
      {games.map((g) => {
        const b = statusBadge[g.status];
        return (
          <li key={g.id}>
            <Link
              href={gameHref(g)}
              className="flex flex-wrap items-center justify-between gap-3 rounded-3xl border bg-card px-5 py-4 shadow-card transition-transform motion-safe:hover:-translate-y-0.5"
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
  );
}
