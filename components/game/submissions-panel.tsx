"use client";

import { Camera, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatElapsed } from "@/lib/game/timing";

type Row = {
  rank: number; playerId: string; nickname: string; rankMs: number; claimedMs: number; serverMs: number;
  timing: "consistent" | "flagged"; flags: string[]; nearTie: boolean; photoUrl: string | null;
};

const flagText: Record<string, string> = {
  elapsed_negative: "claimed a time before the round started",
  intent_before_capture: "claimed a time later than the server's own receipt",
  intent_lag_high: "claimed a time more than 1 s earlier than the server heard about it",
  intent_lag_elevated: "slow network between the tap and the server",
  elapsed_exceeds_limit: "claimed more than the time limit",
  sync_unknown: "no clock-sync data",
  sync_rtt_high: "poor connection when syncing the clock",
  sync_stale: "clock sync was out of date",
  upload_slow: "slow upload",
};

/**
 * Ranked photos for the current round. Times are shown as SS.mmm but are
 * estimates: results closer than 150 ms are marked "too close to call" so the
 * Game Master decides by looking at the photos (see TIMING.md).
 */
export function SubmissionsPanel({ gameId, version, enabled, onPick, picked }: {
  gameId: string; version: number; enabled: boolean; onPick?: (playerId: string) => void; picked?: string | null;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    fetch(`/api/host/games/${gameId}/submissions`, { cache: "no-store" })
      .then(async (r) => (r.ok ? ((await r.json()) as { submissions: Row[] }).submissions : Promise.reject(new Error("failed"))))
      .then((s) => { if (live) { setRows(s); setError(false); } })
      .catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, [gameId, version, enabled]);

  if (!enabled) return null;
  const top = rows?.[0];
  const closeCall = rows && rows.length > 1 && rows[0].nearTie && rows[1].nearTie && Math.abs(rows[0].rankMs - rows[1].rankMs) < 150;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Camera aria-hidden="true" className="size-5 text-primary" /> Photos ({rows?.length ?? 0})</CardTitle>
        {top ? (
          <p className="text-sm text-muted-foreground">
            {closeCall ? "Top results are too close to call by the clock. Check the photos." : `Fastest: ${top.nickname}`} Times are estimates.
          </p>
        ) : null}
      </CardHeader>
      <CardContent>
        {error ? <p role="alert" className="text-destructive">Couldn&apos;t load photos. They will retry on the next update.</p> : null}
        {rows && rows.length === 0 ? <p className="text-muted-foreground">No photos yet.</p> : null}
        <ol className="grid gap-3">
          {rows?.map((r) => (
            <li key={r.playerId} className="flex items-center gap-3 rounded-2xl bg-secondary p-3">
              {r.photoUrl ? (
                <a href={r.photoUrl} target="_blank" rel="noreferrer" aria-label={`Open ${r.nickname}'s photo`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={r.photoUrl} alt={`Photo from ${r.nickname}`} loading="lazy" className="size-20 rounded-xl bg-black object-cover" />
                </a>
              ) : <span className="grid size-20 place-items-center rounded-xl bg-muted text-xs">no photo</span>}
              <div className="min-w-0 flex-1">
                <p className="truncate font-display text-lg font-semibold text-secondary-foreground">#{r.rank} {r.nickname}</p>
                <p className="font-mono text-xl font-bold tabular-nums text-primary">{formatElapsed(r.rankMs)}</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {r.nearTie ? <Badge variant="yellow">too close to call</Badge> : null}
                  {r.timing === "flagged" ? (
                    <Badge variant="coral" title={r.flags.map((f) => flagText[f] ?? f).join("; ")}>
                      <TriangleAlert aria-hidden="true" className="size-3" /> server time used
                    </Badge>
                  ) : null}
                </div>
              </div>
              {onPick ? (
                <Button size="sm" variant={picked === r.playerId ? "default" : "outline"} onClick={() => onPick(r.playerId)}>
                  {picked === r.playerId ? "Picked" : "Pick"}
                </Button>
              ) : null}
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
