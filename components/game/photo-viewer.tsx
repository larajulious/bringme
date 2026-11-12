"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

import { ReviewButtons, flagText, type Decision, type LiveSubmission } from "@/components/game/review-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { statusLabel } from "@/lib/game/review";
import { formatElapsed } from "@/lib/game/timing";

/**
 * Large photo review. For a close finish it shows the two contenders side by
 * side so the Game Master can decide from the photos, not from milliseconds.
 */
export function PhotoViewer({
  row, rows, locked, busy, prompt, onClose, onReview, onNavigate,
}: {
  row: LiveSubmission | null;
  rows: LiveSubmission[];
  locked: boolean;
  busy: boolean;
  prompt: string | null;
  onClose: () => void;
  onReview: (id: string, d: Decision) => void;
  onNavigate: (r: LiveSubmission) => void;
}) {
  const index = row ? rows.findIndex((r) => r.submissionId === row.submissionId) : -1;
  // closest other contender when this is a close finish
  const rival = row?.nearTie ? rows.filter((r) => r.submissionId !== row.submissionId && r.status !== "rejected").sort((a, b) => Math.abs(a.rankMs - row.rankMs) - Math.abs(b.rankMs - row.rankMs))[0] : undefined;
  const live = row ? rows.find((r) => r.submissionId === row.submissionId) ?? row : null; // always the freshest decision

  return (
    <Modal open={row !== null} onClose={onClose} title={live ? `${live.nickname}: ${formatElapsed(live.rankMs)}` : "Photo"} description={prompt ? `Does it show: ${prompt}?` : undefined} className="max-w-4xl">
      {live ? (
        <div className="grid gap-4">
          <div className={rival ? "grid gap-3 sm:grid-cols-2" : "grid"}>
            {[live, rival].filter((r): r is LiveSubmission => Boolean(r)).map((r) => (
              <figure key={r.submissionId} className="grid gap-2">
                {r.photoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={r.photoUrl} alt={`Photo from ${r.nickname}`} className="max-h-[60vh] w-full rounded-2xl bg-black object-contain" />
                ) : <div className="grid h-48 place-items-center rounded-2xl bg-muted">No photo</div>}
                <figcaption className="flex flex-wrap items-center gap-2">
                  <strong className="font-display text-lg">{r.nickname}</strong>
                  <span className="font-mono font-bold tabular-nums text-primary">{formatElapsed(r.rankMs)}</span>
                  <Badge variant={r.status === "approved" ? "success" : r.status === "rejected" ? "destructive" : "yellow"}>{statusLabel[r.status]}</Badge>
                  {r.timing === "flagged" ? <Badge variant="coral" title={r.flags.map((f) => flagText[f] ?? f).join("; ")}>server time used</Badge> : null}
                </figcaption>
                {rival && !locked ? <ReviewButtons row={r} disabled={busy} onReview={onReview} /> : null}
              </figure>
            ))}
          </div>
          {rival ? <p className="rounded-2xl bg-brand-yellow/30 px-4 py-2 text-sm font-semibold text-brand-night">Close finish: only {Math.abs(live.rankMs - rival.rankMs)} ms apart. Decide from the photos.</p> : null}
          {!rival && !locked ? <ReviewButtons row={live} disabled={busy} onReview={onReview} size="default" /> : null}
          <div className="flex items-center justify-between gap-2">
            <Button variant="outline" size="sm" disabled={index <= 0} onClick={() => onNavigate(rows[index - 1])}><ChevronLeft aria-hidden="true" /> Faster</Button>
            <span className="text-sm text-muted-foreground">{index + 1} of {rows.length}</span>
            <Button variant="outline" size="sm" disabled={index < 0 || index >= rows.length - 1} onClick={() => onNavigate(rows[index + 1])}>Slower <ChevronRight aria-hidden="true" /></Button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
