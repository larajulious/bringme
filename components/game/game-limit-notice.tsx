import Link from "next/link";
import { AlertTriangle, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { gameHref } from "@/lib/game/links";
import type { Game } from "@/lib/supabase/database.types";

export type OpenGame = Pick<Game, "id" | "title" | "status"> & Partial<Pick<Game, "game_type">>;

const ORDER: Record<string, number> = { live: 0, lobby: 1, draft: 2 };
const action = (status: Game["status"]) => (status === "live" ? "Continue game" : status === "lobby" ? "Go to lobby" : "Open draft");

/**
 * Shown when the host already has as many open games as their pass allows (server still enforces it).
 * Links straight into the open game(s) so the host can get back to their lobby / console.
 */
export function GameLimitNotice({ active, max, games = [] }: { active: number; max: number; games?: OpenGame[] }) {
  const open = [...games].sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9));
  const one = open.length === 1 ? open[0] : null;
  return (
    <Card role="status" className="border-brand-coral/60" aria-labelledby="game-limit-h">
      <CardContent className="grid gap-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-[15rem] flex-1 items-start gap-3">
            <AlertTriangle aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-brand-coral" />
            <div>
              <p id="game-limit-h" className="font-bold text-foreground">Game limit reached ({active} of {max} open)</p>
              <p className="text-sm text-muted-foreground">
                Your Game Pass allows {max} open {max === 1 ? "game" : "games"} at once. Drafts, Bring Me and BingoSnap games all count.
                Finish, cancel or discard one to create another.
              </p>
            </div>
          </div>
          {one ? (
            <Button asChild variant="outline">
              <Link href={gameHref(one)}>{action(one.status)}<span className="sr-only">: {one.title}</span> <ChevronRight aria-hidden="true" /></Link>
            </Button>
          ) : open.length === 0 ? (
            <Button asChild variant="outline"><Link href="/dashboard#active-h">View open games</Link></Button>
          ) : null}
        </div>
        {open.length > 1 ? (
          <ul aria-label="Your open games" className="grid gap-2 sm:grid-cols-2">
            {open.map((g) => (
              <li key={g.id}>
                <Link href={gameHref(g)} className="flex items-center justify-between gap-3 rounded-2xl border bg-card px-4 py-2.5 font-semibold text-primary transition-colors hover:bg-accent">
                  <span className="min-w-0 truncate">{g.title}</span>
                  <span className="flex shrink-0 items-center gap-1 text-sm">{action(g.status)} <ChevronRight aria-hidden="true" className="size-4" /></span>
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}
