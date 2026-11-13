"use client";

import { Ban, Check, Crown, PartyPopper, TriangleAlert, Undo2 } from "lucide-react";
import { useState } from "react";

import { flagText, type Decision, type LiveSubmission } from "@/components/game/review-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatElapsed } from "@/lib/game/timing";
import { cn } from "@/lib/utils";

type Filter = "pending" | "approved" | "rejected" | "all";
const filterLabel: Record<Filter, string> = { pending: "To review", approved: "Approved", rejected: "Disqualified", all: "All" };

/**
 * Photo review for many submissions at once (the Submissions modal): a grid of large photos with one-tap
 * decisions, filter tabs that start on "To review" (decided photos leave the view, inbox-style), progress,
 * and a hint as soon as slower photos can no longer change the winner.
 */
export function PhotoReviewGrid({
  rows, locked, busyId, error, onReview, onOpen, onPhotoError,
}: {
  rows: LiveSubmission[] | null;
  locked: boolean;
  busyId: string | null;
  error: boolean;
  onReview: (submissionId: string, decision: Decision) => void;
  onOpen: (row: LiveSubmission) => void;
  /** A picture failed to load (e.g. its signed URL expired): the caller fetches a fresh one. */
  onPhotoError?: (row: LiveSubmission) => void;
}) {
  const all = rows ?? [];
  const count = (f: Filter) => (f === "all" ? all.length : all.filter((r) => r.status === f).length);
  const pending = count("pending");
  const [picked, setPicked] = useState<Filter | null>(null);
  // Until the host picks a tab: "To review" while anything is waiting, otherwise everything.
  const filter: Filter = picked ?? (pending > 0 && !locked ? "pending" : "all");
  const shown = filter === "all" ? all : all.filter((r) => r.status === filter);
  const checked = all.length - pending;

  // Rows are ranked fastest first, and only the fastest APPROVED photo wins: once nothing faster than the
  // current leader is still waiting, the remaining (slower) photos can't change the result.
  const leaderIndex = all.findIndex((r) => r.isLeader);
  const fasterWaiting = leaderIndex < 0 ? pending : all.slice(0, leaderIndex).filter((r) => r.status === "pending").length;
  const canStopEarly = !locked && leaderIndex >= 0 && fasterWaiting === 0 && pending > 0;

  if (error && rows === null) return <p role="alert" className="text-destructive">Couldn&apos;t load photos. They will retry on the next update.</p>;
  if (rows === null) return <p className="text-muted-foreground">Loading photos…</p>;
  if (all.length === 0) {
    return <p className="rounded-2xl border-2 border-dashed border-primary/25 px-4 py-8 text-center text-muted-foreground">No photos yet. They appear here the moment players capture them.</p>;
  }

  return (
    <div className="grid gap-3">
      {/* Progress + filters stay at the top while the grid scrolls. */}
      <div className="sticky top-0 z-10 -mx-6 grid gap-2 bg-card px-6 pb-2 pt-1">
        {!locked ? (
          <div className="grid gap-1">
            <p className="flex items-center justify-between text-sm font-semibold">
              <span>{checked} of {all.length} checked</span>
              {pending === 0 ? <span className="text-brand-success">All done</span> : <span className="text-muted-foreground">{pending} left</span>}
            </p>
            <div className="h-2 overflow-hidden rounded-full bg-secondary" role="progressbar" aria-label="Photos checked" aria-valuemin={0} aria-valuemax={all.length} aria-valuenow={checked}>
              <div className="h-full rounded-full bg-primary transition-transform duration-300 motion-reduce:transition-none" style={{ width: "100%", transform: `translateX(-${100 - (checked / all.length) * 100}%)` }} />
            </div>
          </div>
        ) : <p className="text-sm font-semibold text-muted-foreground">The winner is official: decisions are locked.</p>}
        <div role="group" aria-label="Show photos" className="flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none]">
          {(["pending", "approved", "rejected", "all"] as Filter[]).map((f) => (
            <button key={f} type="button" aria-pressed={filter === f} onClick={() => setPicked(f)}
              className={cn("min-h-11 shrink-0 rounded-full px-4 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                filter === f ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground hover:bg-accent")}>
              {filterLabel[f]} ({count(f)})
            </button>
          ))}
        </div>
      </div>

      {canStopEarly ? (
        <p role="status" className="flex items-start gap-2 rounded-2xl bg-brand-success/10 px-4 py-3 text-sm font-semibold text-foreground">
          <Crown aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-brand-success" />
          <span>{all[leaderIndex].nickname} is the fastest approved photo. The {pending} photo{pending === 1 ? "" : "s"} left {pending === 1 ? "is" : "are"} slower and can&apos;t win, so you can announce now.</span>
        </p>
      ) : null}

      {shown.length === 0 ? (
        <div className="grid justify-items-center gap-2 rounded-2xl bg-secondary px-4 py-8 text-center">
          <PartyPopper aria-hidden="true" className="size-8 text-primary" />
          <p className="font-display text-lg font-semibold">{filter === "pending" ? "All photos checked!" : `No ${filterLabel[filter].toLowerCase()} photos.`}</p>
          {filter === "pending" ? <p className="text-sm text-muted-foreground">Announce the winner below, or open “All” to change a decision.</p> : null}
        </div>
      ) : (
        <ol className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" aria-label={`${filterLabel[filter]} photos, fastest first`}>
          {shown.map((r) => (
            <li key={r.submissionId}
              className={cn("grid content-start overflow-hidden rounded-2xl bg-secondary",
                r.isLeader && "ring-4 ring-brand-yellow", r.status === "rejected" && "opacity-70")}>
              <button type="button" onClick={() => onOpen(r)} aria-label={`Open ${r.nickname}'s photo larger`}
                className="relative block aspect-square w-full bg-black focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-ring">
                {r.photoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img onError={() => onPhotoError?.(r)} src={r.photoUrl} alt={`Photo from ${r.nickname}`} loading="lazy" className="size-full object-cover" />
                ) : <span className="grid size-full place-items-center text-xs text-white/70">no photo</span>}
                <span className="absolute left-1.5 top-1.5 rounded-lg bg-brand-night/80 px-2 py-0.5 font-display text-sm font-bold text-white">#{r.rank}</span>
                {r.isLeader ? <span className="absolute right-1.5 top-1.5"><Badge variant="default"><Crown aria-hidden="true" className="size-3" /> Would win</Badge></span> : null}
                {r.status !== "pending" ? (
                  <span className={cn("absolute bottom-1.5 left-1.5 grid size-8 place-items-center rounded-full text-white", r.status === "approved" ? "bg-brand-success" : "bg-destructive")}>
                    {r.status === "approved" ? <Check aria-hidden="true" className="size-5" /> : <Ban aria-hidden="true" className="size-4" />}
                    <span className="sr-only">{r.status === "approved" ? "Approved" : "Disqualified"}</span>
                  </span>
                ) : null}
              </button>
              <div className="grid gap-0.5 px-2.5 pt-2">
                <p className="truncate font-display font-semibold text-secondary-foreground" title={r.nickname}>{r.nickname}</p>
                <p className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-lg font-bold tabular-nums text-primary">{formatElapsed(r.rankMs)}</span>
                  {r.nearTie ? <Badge variant="outline">close</Badge> : null}
                  {r.timing === "flagged" ? (
                    <Badge variant="coral" title={r.flags.map((f) => flagText[f] ?? f).join("; ")}><TriangleAlert aria-hidden="true" className="size-3" /> server time</Badge>
                  ) : null}
                </p>
              </div>
              {!locked ? (
                <div className="p-2.5">
                  {r.status === "pending" ? (
                    <div className="grid grid-cols-2 gap-2">
                      <Button size="icon" variant="success" className="w-full" disabled={busyId === r.submissionId} onClick={() => onReview(r.submissionId, "approve")} aria-label={`Approve ${r.nickname}`} title="Approve">
                        <Check aria-hidden="true" /><span className="hidden sm:inline">Approve</span>
                      </Button>
                      <Button size="icon" variant="destructive" className="w-full" disabled={busyId === r.submissionId} onClick={() => onReview(r.submissionId, "disqualify")} aria-label={`Disqualify ${r.nickname}`} title="Disqualify">
                        <Ban aria-hidden="true" /><span className="hidden sm:inline">Reject</span>
                      </Button>
                    </div>
                  ) : (
                    <Button variant="ghost" className="h-11 w-full" disabled={busyId === r.submissionId} onClick={() => onReview(r.submissionId, "reset")} aria-label={`Undo decision for ${r.nickname}`}>
                      <Undo2 aria-hidden="true" /> Undo
                    </Button>
                  )}
                </div>
              ) : <div className="h-2.5" />}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
