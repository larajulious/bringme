"use client";

import { Ban, Camera, Check, Crown, TriangleAlert, Undo2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { statusLabel, type ReviewRow } from "@/lib/game/review";
import { formatElapsed } from "@/lib/game/timing";
import { cn } from "@/lib/utils";

export type LiveSubmission = ReviewRow & {
  rank: number;
  claimedMs: number;
  serverMs: number;
  flags: string[];
  photoUrl: string | null;
};

export type Decision = "approve" | "disqualify" | "reset";

export const flagText: Record<string, string> = {
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

const statusBadge: Record<ReviewRow["status"], "yellow" | "success" | "destructive"> = {
  pending: "yellow", approved: "success", rejected: "destructive",
};

/** Review controls for one photo; shared by the list and the large viewer. */
export function ReviewButtons({ row, disabled, onReview, size = "sm" }: { row: LiveSubmission; disabled: boolean; onReview: (id: string, d: Decision) => void; size?: "sm" | "default" }) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button size={size} variant={row.status === "approved" ? "secondary" : "outline"} disabled={disabled || row.status === "approved"} onClick={() => onReview(row.submissionId, "approve")}>
        <Check aria-hidden="true" /> {row.status === "approved" ? "Approved" : "Approve"}
      </Button>
      <Button size={size} variant="destructive" disabled={disabled || row.status === "rejected"} onClick={() => onReview(row.submissionId, "disqualify")}>
        <Ban aria-hidden="true" /> {row.status === "rejected" ? "Disqualified" : "Disqualify"}
      </Button>
      {row.status !== "pending" ? (
        <Button size={size} variant="ghost" disabled={disabled} onClick={() => onReview(row.submissionId, "reset")}>
          <Undo2 aria-hidden="true" /> Undo
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Live, ranked submissions for the Game Master: photo, player, SS.mmm time and
 * review status. Order = the ranking policy (TIMING.md); the "Would win" tag
 * marks the fastest APPROVED photo, which is who the server will announce.
 */
export function ReviewPanel({
  rows, counts, locked, busyId, error, onReview, onOpen,
}: {
  rows: LiveSubmission[] | null;
  counts: { pending: number; approved: number; rejected: number } | null;
  /** true once the winner is official: decisions are final. */
  locked: boolean;
  busyId: string | null;
  error: boolean;
  onReview: (submissionId: string, decision: Decision) => void;
  onOpen: (row: LiveSubmission) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-2"><Camera aria-hidden="true" className="size-5 text-primary" /> Submissions ({rows?.length ?? 0})</span>
          {counts ? (
            <span className="flex flex-wrap gap-1.5 text-sm font-semibold">
              <Badge variant="yellow">{counts.pending} to review</Badge>
              <Badge variant="success">{counts.approved} approved</Badge>
              <Badge variant="destructive">{counts.rejected} disqualified</Badge>
            </span>
          ) : null}
        </CardTitle>
        <p className="text-sm text-muted-foreground">Fastest first. Times are estimates; results within 150 ms are marked as a close finish. {locked ? "The winner is official: decisions are locked." : "Tap a photo to see it larger."}</p>
      </CardHeader>
      <CardContent>
        {error ? <p role="alert" className="mb-3 text-destructive">Couldn&apos;t load photos. They will retry on the next update.</p> : null}
        {rows === null ? <p className="text-muted-foreground">Loading submissions…</p> : null}
        {rows && rows.length === 0 ? <p className="rounded-2xl border-2 border-dashed border-primary/25 px-4 py-8 text-center text-muted-foreground">No photos yet. They appear here the moment players capture them.</p> : null}
        <ol className="grid gap-3" aria-label="Submissions, fastest first">
          {rows?.map((r) => (
            <li
              key={r.submissionId}
              className={cn(
                "grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-x-3 gap-y-3 rounded-2xl p-3 lg:grid-cols-[6rem_minmax(0,1fr)_auto]",
                r.isLeader ? "bg-brand-yellow/25 ring-2 ring-brand-yellow" : "bg-secondary",
                r.status === "rejected" && "opacity-70",
              )}
            >
              <button type="button" onClick={() => onOpen(r)} aria-label={`Open ${r.nickname}'s photo`} className="overflow-hidden rounded-xl">
                {r.photoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={r.photoUrl} alt={`Photo from ${r.nickname}`} loading="lazy" className="size-24 bg-black object-cover" />
                ) : <span className="grid size-24 place-items-center bg-muted text-xs">no photo</span>}
              </button>
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-display text-lg font-semibold text-secondary-foreground">
                  <span className="truncate">#{r.rank} {r.nickname}</span>
                  {r.isLeader ? <Badge variant="default"><Crown aria-hidden="true" className="size-3" /> Would win</Badge> : null}
                </p>
                <p className="font-mono text-2xl font-bold tabular-nums text-primary" aria-label="Time">{formatElapsed(r.rankMs)}</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  <Badge variant={statusBadge[r.status]}>{statusLabel[r.status]}</Badge>
                  {r.nearTie ? <Badge variant="outline">close finish</Badge> : null}
                  {r.timing === "flagged" ? (
                    <Badge variant="coral" title={r.flags.map((f) => flagText[f] ?? f).join("; ")}>
                      <TriangleAlert aria-hidden="true" className="size-3" /> server time used
                    </Badge>
                  ) : null}
                </div>
              </div>
              {!locked ? (
                <div className="col-span-2 lg:col-span-1">
                  <ReviewButtons row={r} disabled={busyId === r.submissionId} onReview={onReview} />
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
