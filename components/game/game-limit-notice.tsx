import Link from "next/link";
import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

/** Shown when the host already has as many open games as their pass allows (server still enforces it). */
export function GameLimitNotice({ active, max, showLink = true }: { active: number; max: number; showLink?: boolean }) {
  return (
    <Card role="status" className="border-brand-coral/60" aria-labelledby="game-limit-h">
      <CardContent className="flex flex-wrap items-center justify-between gap-4 p-5">
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
        {showLink ? <Button asChild variant="outline"><Link href="/dashboard#active-h">View open games</Link></Button> : null}
      </CardContent>
    </Card>
  );
}
