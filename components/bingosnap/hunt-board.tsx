"use client";

import { Download, Grid3x3, List, PartyPopper, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { PhotoBoard, PhotoList } from "@/components/bingosnap/photo-board";
import type { ExistingPhoto } from "@/components/bingosnap/photo-capture";
import { WaitingDots } from "@/components/game/waiting-dots";
import { Confetti } from "@/components/game/confetti";
import { useCellPhotos } from "@/components/bingosnap/use-cell-photos";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { lockedCellIds } from "@/lib/bingosnap/board";
import { evaluateCard, patternLabel, type CardEvaluation } from "@/lib/bingosnap/completion";
import type { BingoLayoutCell, BingoPlayerSubmission, WinMode } from "@/lib/bingosnap/types";
import { photoFileName, savePhotoCopies } from "@/lib/photos/export";
import { cn } from "@/lib/utils";
import type { CapturedPhoto } from "@/lib/photos/process";

const copyNote = { shared: "Copies shared.", downloaded: "Copies downloaded.", cancelled: null } as const;

// The camera (getUserMedia, canvas encoding, the capture UI) loads on demand, not with the card.
const loadCapture = () => import("@/components/bingosnap/photo-capture");
const PhotoCapture = dynamic(() => loadCapture().then((m) => m.PhotoCapture), {
  ssr: false,
  loading: () => (
    <div className="fixed inset-0 z-50 grid place-items-center bg-brand-night text-white" role="status">
      <div className="grid justify-items-center gap-2"><WaitingDots /><p>Opening the camera…</p></div>
    </div>
  ),
});

type View = "card" | "list";
const VIEW_KEY = "bingosnap:view";
function useView(): [View, (v: View) => void] {
  const [view, setView] = useState<View>("card");
  useEffect(() => {
    try { if (localStorage.getItem(VIEW_KEY) === "list") setView("list"); } catch { /* storage blocked: default view */ }
  }, []);
  const set = useCallback((v: View) => {
    setView(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* not remembered */ }
  }, []);
  return [view, set];
}

/** Copies of the player's own photos, on an explicit tap only. */
function useSaveCopies(title: string, getImage: (cellId: string) => Promise<Blob | null>) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (cells: { cellId: string; label: string }[]) => {
    setBusy(true);
    setNote(null);
    try {
      const items: { blob: Blob; name: string }[] = [];
      for (const [i, c] of cells.entries()) {
        const blob = await getImage(c.cellId).catch(() => null);
        if (blob) items.push({ blob, name: photoFileName(title, c.label, cells.length > 1 ? i + 1 : undefined) });
      }
      setNote(items.length ? copyNote[await savePhotoCopies(items, title)] : "No photos to save.");
    } catch {
      setNote("We couldn't save copies on this device.");
    } finally {
      setBusy(false);
    }
  }, [title, getImage]);
  return { run, note, busy };
}

/**
 * The hunt: the player's own card with local photos. Tap a square → camera → review → save to
 * this phone (IndexedDB). Saved squares show their photo and can be reviewed or retaken until
 * they are part of a claim the host is checking. Nothing here is uploaded.
 */
export function HuntBoard({
  gameId, playerId, title, size, mode, modeName, layout, submissions, readOnly, renderClaim,
}: {
  gameId: string;
  playerId: string;
  title: string;
  size: number;
  mode: WinMode;
  modeName: string;
  layout: BingoLayoutCell[];
  submissions: BingoPlayerSubmission[];
  /** The hunt is over: view only. */
  readOnly: boolean;
  /** Submit / claim status, rendered under the card (kept out of this file: it has no network code). */
  renderClaim?: (e: CardEvaluation) => ReactNode;
}) {
  const owner = useMemo(() => ({ gameId, playerId }), [gameId, playerId]);
  const cellIds = useMemo(() => layout.filter((c) => !c.isFree).map((c) => c.cellId), [layout]);
  const ph = useCellPhotos(owner, cellIds);
  const locked = useMemo(() => lockedCellIds(submissions), [submissions]);
  const snapped = useMemo(() => new Set(Object.entries(ph.photos).filter(([, p]) => !p.broken).map(([id]) => id)), [ph.photos]);
  // Recalculated whenever a photo is saved, replaced, removed, found broken or restored after a refresh.
  const result = useMemo(() => (layout.length === size * size ? evaluateCard({ size, mode, cells: layout, done: snapped }) : null), [layout, size, mode, snapped]);
  const progress = { done: result?.completed ?? 0, total: result?.required ?? 0 };

  // Celebrate the moment a winning pattern appears (not when a refresh restores one).
  const [burst, setBurst] = useState(0);
  const wasEligible = useRef<boolean | null>(null);
  const eligible = !!result?.eligible;
  useEffect(() => {
    if (!ph.ready) return;
    if (wasEligible.current === false && eligible && !readOnly) setBurst((n) => n + 1);
    wasEligible.current = eligible;
  }, [eligible, ph.ready, readOnly]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [captureLoaded, setCaptureLoaded] = useState(false);
  const [view, setView] = useView();
  const [said, setSaid] = useState("");
  const onOpen = useCallback((c: BingoLayoutCell) => { setCaptureLoaded(true); setOpenId(c.cellId); }, []);
  // Warm the camera code once the card is on screen and the browser is idle.
  useEffect(() => {
    if (readOnly) return;
    const w = window as Window & { requestIdleCallback?: (cb: () => void) => number; cancelIdleCallback?: (id: number) => void };
    const run = () => void loadCapture().catch(() => undefined);
    const id = w.requestIdleCallback ? w.requestIdleCallback(run) : window.setTimeout(run, 1500);
    return () => (w.cancelIdleCallback ? w.cancelIdleCallback(id) : clearTimeout(id));
  }, [readOnly]);

  // The squares of the last rejected claim, until each is retaken: "check these".
  const flagged = useMemo(() => {
    if (submissions.some((x) => x.status !== "rejected")) return new Set<string>();
    const last = [...submissions].reverse().find((x) => x.status === "rejected");
    if (!last) return new Set<string>();
    const at = Date.parse(last.validatedAt ?? last.submittedAt);
    return new Set(last.cellIds.filter((id) => !(ph.photos[id] && ph.photos[id].savedAt > at)));
  }, [submissions, ph.photos]);
  const cell = openId ? layout.find((c) => c.cellId === openId) ?? null : null;
  const saved = cell ? ph.photos[cell.cellId] : undefined;
  const copies = useSaveCopies(title, ph.getImage);

  const { getImage, save } = ph;
  const existing = useMemo<ExistingPhoto | null>(
    () => (cell && saved ? {
      load: () => getImage(cell.cellId),
      takenAt: saved.takenAt,
      broken: saved.broken,
      lockedText: locked.has(cell.cellId) ? "In your claim: the Game Master is checking it" : null,
    } : null),
    // Rebuild only when a different photo is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cell?.cellId, saved?.savedAt, saved?.broken, locked, getImage],
  );
  const onSave = useCallback(async (photo: CapturedPhoto) => {
    if (!cell) throw new Error("no_cell");
    await save(cell.cellId, photo);
    const n = progress.done + (ph.photos[cell.cellId] && !ph.photos[cell.cellId].broken ? 0 : 1);
    setSaid(`Saved: ${cell.challenge ?? "photo"}. ${Math.min(n, progress.total)} of ${progress.total} snapped.`);
  }, [cell, save, progress.done, progress.total, ph.photos]);
  const claimFirst = eligible || submissions.length > 0;
  const claim = result && renderClaim ? renderClaim(result) : null;
  const boardProps = {
    size, layout, photos: ph.photos, locked, readOnly, winning: result?.winningPositions, flagged, celebrate: burst, onOpen, onBroken: ph.markBroken,
  };

  return (
    <div className="grid w-full gap-3">
      <p className="sr-only" role="status" aria-live="polite">{said}</p>
      <div className="grid gap-1.5">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <p className="text-sm font-semibold">
            <span className="font-display text-lg">{progress.done}</span> of {progress.total} snapped
            <span className="text-white/75"> · {result?.percent ?? 0}%</span>
          </p>
          <div className="flex items-center gap-2">
            <p className="rounded-full bg-white/15 px-3 py-0.5 text-xs font-bold uppercase tracking-wide">{modeName}</p>
            <div className="flex rounded-full bg-white/15 p-0.5" role="group" aria-label="Show the card as">
              {([["card", Grid3x3, "Card"], ["list", List, "List"]] as const).map(([v, Icon, label]) => (
                <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}
                  className={cn("inline-flex min-h-11 items-center gap-1 rounded-full px-3 text-xs font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-yellow", view === v ? "bg-white text-primary" : "text-white/85 hover:text-white")}>
                  <Icon aria-hidden="true" className="size-4" />{label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <span
          role="progressbar" aria-label="Card progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={result?.percent ?? 0}
          className="block h-2 overflow-hidden rounded-full bg-white/15"
        >
          <span className="block h-full origin-left rounded-full bg-brand-yellow transition-transform duration-500 motion-reduce:transition-none" style={{ transform: `scaleX(${(result?.percent ?? 0) / 100})` }} />
        </span>
      </div>

      {eligible && result && !submissions.some((x) => x.status !== "rejected") ? (
        <div className="relative overflow-hidden rounded-3xl bg-brand-yellow px-4 py-3 text-brand-night shadow-pop" role="status">
          {burst > 0 ? <Confetti key={burst} pieces={22} once /> : null}
          <p key={`b${burst}`} className="relative flex items-center justify-center gap-2 font-display text-2xl font-bold animate-bounce-in motion-reduce:animate-none">
            <PartyPopper aria-hidden="true" className="size-6" />
            {mode === "full_card" ? "Full card!" : "BINGO!"}
          </p>
          <p className="relative text-center text-sm font-semibold">
            {mode === "full_card"
              ? "Every square has a photo."
              : result.lines.length > 1
                ? `${result.lines.length} lines complete: ${result.lines.map((l) => patternLabel(l.pattern)).join(", ")}.`
                : `${patternLabel(result.lines[0].pattern)} complete.`}
          </p>
        </div>
      ) : null}

      {claimFirst ? claim : null}

      {layout.length ? (view === "list" ? <PhotoList {...boardProps} /> : <PhotoBoard {...boardProps} />) : null}

      {!claimFirst ? claim : null}

      {!ph.persistent || ph.loadFailed ? (
        <p className="flex items-start gap-2 rounded-2xl bg-brand-coral/25 px-4 py-3 text-left text-sm font-semibold ring-1 ring-brand-coral/60" role="alert">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {ph.loadFailed
            ? "We couldn't read your saved photos from this browser. Keep this page open; photos you take now may not be kept."
            : "This browser can't keep photos (private browsing?). They'll disappear if this page reloads or closes, so keep it open until the Game Master has checked your card."}
        </p>
      ) : (
        <p className="flex items-start gap-2 rounded-2xl bg-white/10 px-4 py-3 text-left text-sm text-white/90">
          <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-emerald-300" />
          <span>
            Your photos stay on this phone and are never uploaded. <strong className="font-semibold text-white">Don&apos;t clear this browser&apos;s data, switch browsers or use another phone</strong> until the Game Master has checked your card.
          </span>
        </p>
      )}

      {progress.done > 0 ? (
        <div className="grid justify-items-center gap-1">
          <Button variant="outline-light" size="sm" disabled={copies.busy}
            onClick={() => void copies.run(layout.filter((c) => snapped.has(c.cellId)).map((c) => ({ cellId: c.cellId, label: c.challenge ?? "photo" })))}>
            <Download aria-hidden="true" /> {copies.busy ? "Preparing…" : "Save copies of my photos"}
          </Button>
          <p className="text-xs text-white/70" role="status">{copies.note ?? "Optional: keeps a copy outside the browser. You choose where."}</p>
        </div>
      ) : null}

      {captureLoaded ? <PhotoCapture
        open={!!cell}
        title={cell?.challenge ?? ""}
        eyebrow="Snap this"
        existing={existing}
        readOnly={readOnly}
        readOnlyText="Time's up: no new photos."
        saveLabel="Save to card"
        onSave={onSave}
        onSaveCopy={(blob) => void savePhotoCopies([{ blob, name: photoFileName(title, cell?.challenge ?? "photo") }], title)}
        onClose={() => setOpenId(null)}
      /> : null}
    </div>
  );
}

/**
 * After the game (finished, cancelled, or the player was removed): the photos still on this phone,
 * with "Save copies" and "Delete from this phone". Never deleted automatically for this game.
 */
export function LocalPhotosPanel({ gameId, playerId, title, layout }: { gameId: string; playerId: string; title: string; layout?: BingoLayoutCell[] | null }) {
  const owner = useMemo(() => ({ gameId, playerId }), [gameId, playerId]);
  const ph = useCellPhotos(owner, null);
  const ids = Object.keys(ph.photos);
  const copies = useSaveCopies(title, ph.getImage);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  if (!ph.ready || (!ids.length && !note)) return null;
  return (
    <section aria-labelledby="local-photos-h" className="mt-4 grid w-full justify-items-center gap-2 rounded-4xl bg-white/10 p-4 text-sm ring-1 ring-white/15">
      <h2 id="local-photos-h" className="font-display text-lg font-semibold">Your photos</h2>
      {ids.length ? (
        <>
          <p className="text-white/85">{ids.length === 1 ? "1 photo is" : `${ids.length} photos are`} still saved in this browser, only on this phone.</p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="outline-light" size="sm" disabled={copies.busy || busy} onClick={() => void copies.run(ids.map((id, i) => ({ cellId: id, label: layout?.find((c) => c.cellId === id)?.challenge ?? `photo-${i + 1}` })))}>
              <Download aria-hidden="true" /> {copies.busy ? "Preparing…" : "Save copies"}
            </Button>
            <Button variant="outline-light" size="sm" disabled={busy} onClick={() => setConfirm(true)}><Trash2 aria-hidden="true" /> Delete from this phone</Button>
          </div>
        </>
      ) : null}
      <p className="text-xs text-white/70" role="status">{note ?? copies.note ?? " "}</p>
      <ConfirmDialog
        open={confirm} busy={busy} title="Delete your photos?" confirmLabel="Delete photos"
        description="They're removed from this browser for good. Save copies first if you want to keep them."
        onClose={() => setConfirm(false)}
        onConfirm={async () => {
          setBusy(true);
          try { await ph.clearAll(); setNote("Your photos were deleted from this phone."); } catch { setNote("We couldn't delete them. Try again."); }
          setBusy(false);
          setConfirm(false);
        }}
      />
    </section>
  );
}
