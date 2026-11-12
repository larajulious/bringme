"use client";

import { Camera, Check, ChevronLeft, ChevronRight, Clock, Eraser, Eye, Grid3x3, ListOrdered, Pencil, Plus, Sparkles, Star, Trophy, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import {
  DURATION_PRESETS_MIN, EDITOR_ERRORS, MAX_DURATION_MIN, MIN_DURATION_MIN, boardProblems, centreIndex, clampMinutes,
  editablePositions, effectiveFree, emptyCells, fillWithIdeas, formatMinutes, longLabel, moveInGrid, nextEmpty, normalise,
  pasteLines, readyCount, reshapeBoard, shortLabel, stepEditable, suggestions, type SquareProblem,
} from "@/lib/bingosnap/board";
import { BOARD_SIZES, CHALLENGE_MAX_LENGTH, freeSpaceAllowed, type BoardSize, type WinMode, type WinnerRule } from "@/lib/bingosnap/types";
import { TITLE_MAX_LENGTH } from "@/lib/host/validation";
import { cn } from "@/lib/utils";

export type EditorInitial = {
  gameId: string;
  status: "draft" | "lobby";
  version: number;
  revision: number;
  joinCode: string;
  title: string;
  winMode: WinMode;
  winnerRule: WinnerRule;
  size: BoardSize;
  freeSpace: boolean;
  durationSeconds: number;
  cells: string[];
};

type Draft = { title: string; winMode: WinMode; winnerRule: WinnerRule; size: BoardSize; wantFree: boolean; minutes: number; cells: string[] };
type Pending = { title: string; description: string; confirm: string; apply: () => void; /** apply closes the dialog itself (async actions). */ selfClosing?: boolean };

const problemCopy: Record<SquareProblem, string> = {
  empty: "Needs a photo instruction.",
  too_long: `Keep it under ${CHALLENGE_MAX_LENGTH} characters.`,
  duplicate: "Already used on another square.",
};

const signature = (d: Draft) => JSON.stringify({
  t: normalise(d.title), m: d.winMode, r: d.winnerRule, s: d.size, f: effectiveFree(d.wantFree, d.size, d.winMode), d: d.minutes,
  c: d.cells.map(normalise),
});

/** A big, keyboard-accessible radio card (native radio input). */
function Choice({ name, value, checked, onChange, title, description, icon, disabled }: {
  name: string; value: string; checked: boolean; onChange: () => void; title: string; description?: string; icon?: React.ReactNode; disabled?: boolean;
}) {
  return (
    <label className={cn("relative block", disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer")}>
      <input type="radio" name={name} value={value} checked={checked} onChange={onChange} disabled={disabled} className="peer sr-only" />
      <span className="flex h-full items-start gap-3 rounded-3xl border-2 border-primary/15 bg-card p-3.5 transition-colors hover:border-primary/40 peer-checked:border-primary peer-checked:bg-secondary peer-focus-visible:ring-4 peer-focus-visible:ring-ring/40">
        {icon ? <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-2xl bg-brand-yellow text-brand-night [&_svg]:size-5">{icon}</span> : null}
        <span className="min-w-0">
          <span className="block font-display font-semibold leading-tight text-foreground">{title}</span>
          {description ? <span className="mt-0.5 block text-sm text-muted-foreground">{description}</span> : null}
        </span>
      </span>
    </label>
  );
}

function MiniGrid({ size }: { size: number }) {
  return (
    <span aria-hidden="true" className="grid w-10 gap-0.5" style={{ gridTemplateColumns: `repeat(${size}, minmax(0, 1fr))` }}>
      {Array.from({ length: size * size }, (_, i) => <span key={i} className="aspect-square rounded-[3px] bg-primary/70" />)}
    </span>
  );
}

/**
 * BingoSnap card editor: a clickable Bingo grid with a focused instruction editor,
 * board setup, rules, a player-view preview, draft saving and publishing.
 * Everything is re-validated by the API and the database (bingo_save_board); the
 * player cap comes from the host's Game Pass and is never chosen here.
 */
export function BoardEditor({ initial, maxPlayers }: { initial?: EditorInitial; maxPlayers: number | null }) {
  const router = useRouter();
  const { toast } = useToast();

  const start: Draft = useMemo(() => initial
    ? { title: initial.title === "BingoSnap" ? "" : initial.title, winMode: initial.winMode, winnerRule: initial.winnerRule, size: initial.size,
        wantFree: initial.freeSpace, minutes: Math.round(initial.durationSeconds / 60), cells: initial.cells }
    : { title: "", winMode: "traditional", winnerRule: "ranked", size: 3, wantFree: true, minutes: 20, cells: emptyCells(3) },
  [initial]);

  const [d, setD] = useState<Draft>(start);
  const [saved, setSaved] = useState(() => signature(start)); // a fresh board is pristine until the host changes something
  const [revision, setRevision] = useState(initial?.revision ?? 0);
  const [version, setVersion] = useState(initial?.version ?? 0);
  const [status, setStatus] = useState<"new" | "draft" | "lobby">(initial?.status ?? "new");
  const [minutesText, setMinutesText] = useState(String(start.minutes));
  const [selected, setSelected] = useState(() => nextEmpty(start.cells, { size: start.size, free: effectiveFree(start.wantFree, start.size, start.winMode) }) ?? 0);
  const [view, setView] = useState<"edit" | "preview">("edit");
  const [showProblems, setShowProblems] = useState(false);
  const [busy, setBusy] = useState<null | "save" | "publish" | "discard">(null);
  const [error, setError] = useState<{ text: string; validation: boolean } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  /** The square editor is a modal over the card, so what you type and the square stay together. */
  const [editing, setEditing] = useState(false);

  const cellRefs = useRef<(HTMLDivElement | null)[]>([]);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);

  const free = effectiveFree(d.wantFree, d.size, d.winMode);
  const shape = useMemo(() => ({ size: d.size, free }), [d.size, free]);
  const centre = centreIndex(d.size, free);
  const problems = useMemo(() => boardProblems(d.cells, shape), [d.cells, shape]);
  const ready = readyCount(d.cells, shape);
  const total = editablePositions(shape).length;
  const dirty = signature(d) !== saved;
  const freeAllowed = freeSpaceAllowed(d.size, d.winMode);
  const sel = Math.min(selected, d.size * d.size - 1);
  const selIsFree = sel === centre;
  const ideas = useMemo(() => suggestions(d.cells, 3, sel * 7), [d.cells, sel]);

  // Leaving with unsaved changes asks first (browser navigation / tab close).
  useEffect(() => {
    if (!dirty) return;
    const onLeave = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [dirty]);

  const setCell = useCallback((pos: number, text: string) => setD((cur) => ({ ...cur, cells: cur.cells.map((c, i) => (i === pos ? text : c)) })), []);
  // Squares are always rendered, so focus moves immediately (rapid arrow presses are never lost).
  const focusCell = (pos: number) => { setSelected(pos); cellRefs.current[pos]?.focus(); };
  const editCell = (pos: number, opts: { replaceWith?: string } = {}) => {
    // Open the editor modal for this square synchronously (Modal opens in a layout effect) and focus it
    // in the same event, so fast typing never lands on the grid while the editor is still appearing.
    flushSync(() => {
      setView("edit");
      setSelected(pos);
      setEditing(true);
      if (pos !== centre && opts.replaceWith !== undefined) setCell(pos, opts.replaceWith);
    });
    if (pos === centre) return;
    const el = editorRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  };
  /** Close the editor and put keyboard focus back on the square, now that the card is interactive again. */
  const closeEditor = () => {
    flushSync(() => setEditing(false));
    cellRefs.current[sel]?.focus({ preventScroll: true });
  };

  // ---- board shape changes (warn before removing instructions)
  const changeShape = (next: Partial<Pick<Draft, "size" | "winMode" | "wantFree">>) => {
    const to = { ...d, ...next };
    const res = reshapeBoard(d.cells, shape, { size: to.size, free: effectiveFree(to.wantFree, to.size, to.winMode) });
    const apply = () => { setD({ ...to, cells: res.cells }); setSelected((s) => Math.min(s, to.size * to.size - 1)); };
    if (res.dropped.length === 0) return apply();
    const list = res.dropped.slice(0, 3).map((t) => `“${t}”`).join(", ") + (res.dropped.length > 3 ? ` and ${res.dropped.length - 3} more` : "");
    const what = next.size && next.size !== d.size ? `Switch to ${next.size}×${next.size}?` : "Turn on the free centre?";
    setPending({
      title: what,
      description: `${res.dropped.length === 1 ? "This instruction doesn't" : `These ${res.dropped.length} instructions don't`} fit and will be removed: ${list}.`,
      confirm: `Remove ${res.dropped.length === 1 ? "it" : res.dropped.length}`,
      apply,
    });
  };

  const setMinutesFromText = (text: string) => {
    setMinutesText(text);
    const n = Number(text);
    if (text.trim() !== "" && Number.isFinite(n)) setD((cur) => ({ ...cur, minutes: clampMinutes(n) }));
  };
  const pickMinutes = (m: number) => { setD((cur) => ({ ...cur, minutes: m })); setMinutesText(String(m)); };

  // ---- grid keyboard
  const onCellKey = (pos: number, e: React.KeyboardEvent) => {
    const moved = moveInGrid(pos, d.size, e.key);
    if (moved !== pos || ["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      focusCell(moved);
      return;
    }
    if (e.key === "Enter" || e.key === "F2") { e.preventDefault(); editCell(pos); return; }
    if ((e.key === "Delete" || e.key === "Backspace") && pos !== centre) { e.preventDefault(); setCell(pos, ""); return; }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && pos !== centre && e.key !== " ") {
      e.preventDefault();
      editCell(pos, { replaceWith: e.key }); // typing replaces, like a spreadsheet
    }
  };

  // ---- editor keyboard
  const onEditorKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      const next = stepEditable(sel, shape, e.shiftKey ? -1 : 1);
      if (next !== null) editCell(next);
      else if (!e.shiftKey) { closeEditor(); toast(ready === total ? "Board complete!" : `${total - ready} square${total - ready === 1 ? "" : "s"} still empty.`, ready === total ? "success" : "info"); }
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeEditor();
    }
  };
  const onEditorPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const next = pasteLines(d.cells, sel, e.clipboardData.getData("text"), shape);
    if (!next) return;
    e.preventDefault();
    setD((cur) => ({ ...cur, cells: next }));
    toast("Pasted your list into the following squares.", "success");
  };

  // ---- saving
  const payload = (publish: boolean) => ({
    title: d.title, boardSize: d.size, winMode: d.winMode, freeSpace: free, winnerRule: d.winnerRule,
    durationSeconds: clampMinutes(Number(minutesText)) * 60, cells: d.cells.map((c, i) => (i === centre ? "" : normalise(c))), publish,
    ...(status === "new" ? {} : { expectedRevision: revision }),
  });

  const save = async (publish: boolean) => {
    setError(null);
    const needsComplete = publish || status === "lobby";
    if (needsComplete) {
      setShowProblems(true);
      const first = problems.findIndex(Boolean);
      if (first >= 0) {
        const n = problems.filter(Boolean).length;
        setError({ text: `${n} square${n === 1 ? "" : "s"} still need${n === 1 ? "s" : ""} attention before ${publish ? "publishing" : "saving"}.`, validation: true });
        setView("edit");
        editCell(first);
        return;
      }
    }
    const committed = clampMinutes(Number(minutesText));
    pickMinutes(committed);
    setBusy(publish ? "publish" : "save");
    const res = await fetch(status === "new" ? "/api/host/bingosnap" : `/api/host/bingosnap/${initial!.gameId}/board`, {
      method: status === "new" ? "POST" : "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload(publish)),
    }).catch(() => null);
    setBusy(null);
    if (!res?.ok) {
      const code = res ? ((await res.json().catch(() => ({}))) as { error?: string }).error : "network";
      setError({ text: code === "network" ? "You seem to be offline. Your changes are still here; try again when you're back online." : (EDITOR_ERRORS[code ?? ""] ?? "We couldn't save the board. Please try again."), validation: false });
      return;
    }
    const body = (await res.json()) as { id?: string; state: { gameId: string; status: string; version: number; boardRevision: number; joinCode: string } };
    setSaved(signature({ ...d, minutes: committed }));
    setRevision(body.state.boardRevision);
    setVersion(body.state.version);
    setStatus(body.state.status === "lobby" ? "lobby" : "draft");
    toast(publish ? `Board published! Players can join with code ${body.state.joinCode}.` : status === "lobby" ? "Changes saved." : "Draft saved.", "success");
    // A new board gets its own URL; publishing reloads the page header (status, room code).
    // A plain save keeps the editor as it is, so the host doesn't lose their place.
    if (status === "new") router.replace(`/dashboard/extra-fun/bingosnap/${body.state.gameId}`);
    else if (publish) router.refresh();
  };

  // Ctrl/Cmd+S saves (draft, or changes in the lobby).
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); if (!busy) void saveRef.current(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy]);

  const discard = async () => {
    if (!initial) return;
    setBusy("discard");
    const res = await fetch(`/api/host/bingosnap/${initial.gameId}/transition`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "cancel", expectedVersion: version }),
    }).catch(() => null);
    setBusy(null);
    setPending(null);
    if (res?.ok) { setSaved(signature(d)); toast(status === "lobby" ? "Game cancelled." : "Draft discarded.", "success"); router.push("/dashboard/extra-fun"); }
    else toast("We couldn't do that. Reload the page and try again.", "error");
  };

  const disabled = busy !== null;
  const titleText = normalise(d.title) || "BingoSnap";

  return (
    <div className="grid gap-6">
      {/* ------------------------------------------------ actions: sticky toolbar under the page header */}
      <div className="sticky -top-2 z-20 rounded-3xl border bg-card px-3 py-2.5 shadow-card sm:-top-5 sm:px-4 lg:-top-9 lg:short:-top-5">
        <div className="flex items-center gap-2">
          <p className="mr-auto min-w-0 truncate text-sm font-semibold" aria-live="polite">
            {busy === "save" ? "Saving…" : busy === "publish" ? "Publishing…" : dirty
              ? <span className="text-brand-coral">● Unsaved<span className="hidden sm:inline"> changes</span></span>
              : status === "new" ? <span className="text-muted-foreground">Not saved yet</span>
              : <span className="text-brand-success">✓ {status === "lobby" ? <>Published<span className="hidden sm:inline"> · all changes saved</span></> : "Draft saved"}</span>}
          </p>
          {status !== "lobby" ? (
            <Button type="button" variant="outline" size="sm" className="sm:h-11 sm:px-5 sm:text-base" disabled={disabled || (!dirty && status !== "new")} onClick={() => void save(false)}>
              {busy === "save" ? "Saving…" : "Save draft"}
            </Button>
          ) : null}
          {status === "lobby" ? (
            <Button type="button" size="sm" className="sm:h-11 sm:px-5 sm:text-base" disabled={disabled || !dirty} onClick={() => void save(false)}>{busy === "save" ? "Saving…" : "Save changes"}</Button>
          ) : (
            <Button type="button" size="sm" className="sm:h-11 sm:px-5 sm:text-base" disabled={disabled} onClick={() => void save(true)}>
              {busy === "publish" ? "Publishing…" : <><Check aria-hidden="true" /> Publish<span className="hidden sm:inline"> board</span></>}
            </Button>
          )}
        </div>
        {/* A validation message disappears by itself once every square is fixed. */}
        {error && !(error.validation && problems.every((x) => x === null)) ? <p role="alert" className="mt-2 rounded-2xl bg-destructive/10 px-3 py-2 text-sm font-semibold text-destructive">{error.text}</p> : null}
      </div>
      <div className="grid gap-6 xl:grid-cols-[20rem_minmax(0,1fr)] xl:grid-rows-[auto_1fr] xl:items-start">
        {/* ------------------------------------------------ setup */}
        <Card className="xl:col-start-1 xl:row-start-1">
          <CardHeader className="pb-4">
            <CardTitle>Board setup</CardTitle>
            <CardDescription>{status === "lobby" ? "You can still change everything until the game starts." : "Change anything while it's a draft."}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            <div className="grid gap-2">
              <Label htmlFor="bs-title">Title (optional)</Label>
              <Input id="bs-title" value={d.title} maxLength={TITLE_MAX_LENGTH} onChange={(e) => setD({ ...d, title: e.target.value })} placeholder="Office photo hunt" disabled={disabled} />
            </div>
            <fieldset className="grid gap-2" disabled={disabled}>
              <legend className="mb-2 font-semibold">How to win</legend>
              <Choice name="winMode" value="traditional" checked={d.winMode === "traditional"} onChange={() => changeShape({ winMode: "traditional" })}
                icon={<Grid3x3 />} title="Traditional Bingo" description="Any full row, column or diagonal." />
              <Choice name="winMode" value="full_card" checked={d.winMode === "full_card"} onChange={() => changeShape({ winMode: "full_card" })}
                icon={<Sparkles />} title="Full Card Challenge" description="Every square on the board." />
            </fieldset>
            <fieldset disabled={disabled}>
              <legend className="mb-2 font-semibold">Board size</legend>
              <div className="grid grid-cols-3 gap-2">
                {BOARD_SIZES.map((s) => (
                  <label key={s} className="relative block cursor-pointer">
                    <input type="radio" name="size" value={s} checked={d.size === s} onChange={() => changeShape({ size: s })} className="peer sr-only" />
                    <span className="flex flex-col items-center gap-1.5 rounded-2xl border-2 border-primary/15 bg-card px-1 py-3 transition-colors hover:border-primary/40 peer-checked:border-primary peer-checked:bg-secondary peer-focus-visible:ring-4 peer-focus-visible:ring-ring/40">
                      <MiniGrid size={s} />
                      <span className="font-display text-lg font-bold text-foreground">{s}×{s}</span>
                      <span className="text-xs text-muted-foreground">{s * s} squares</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className={cn("flex items-start gap-3 rounded-2xl bg-secondary/60 p-3.5", !freeAllowed && "opacity-70")}>
              <Checkbox id="bs-free" checked={free} disabled={!freeAllowed || disabled} onCheckedChange={(v) => changeShape({ wantFree: v === true })}
                className="mt-0.5 size-5" aria-describedby="bs-free-help" />
              <div>
                <Label htmlFor="bs-free" className={cn("flex items-center gap-1.5", freeAllowed ? "cursor-pointer" : "cursor-not-allowed")}>
                  <Star aria-hidden="true" className="size-4 fill-brand-yellow text-brand-yellow-deep" /> Free centre square
                </Label>
                <p id="bs-free-help" className="text-sm text-muted-foreground">
                  {freeAllowed ? "Needs no photo and counts as complete for everyone." : "Available on 3×3 and 5×5 boards in Traditional Bingo."}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* ------------------------------------------------ the board */}
        <section aria-labelledby="bs-board-h" className="grid min-w-0 gap-4 rounded-4xl border bg-card p-4 shadow-card sm:p-6 xl:sticky xl:top-12 xl:short:top-16 xl:col-start-2 xl:row-span-2 xl:row-start-1">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 id="bs-board-h" className="font-display text-2xl font-bold text-primary">Your card</h2>
              <p className="text-sm text-muted-foreground" aria-live="polite">{ready} of {total} squares ready{free ? " · free centre" : ""}</p>
            </div>
            <div role="radiogroup" aria-label="Card view" className="inline-flex rounded-full bg-secondary p-1">
              {([["edit", "Edit", Pencil], ["preview", "Player preview", Eye]] as const).map(([v, label, Icon]) => (
                <button key={v} type="button" role="radio" aria-checked={view === v} onClick={() => setView(v)}
                  className={cn("inline-flex min-h-10 items-center gap-1.5 rounded-full px-4 font-display text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/40",
                    view === v ? "bg-primary text-primary-foreground shadow-sm" : "text-primary hover:bg-white/60")}>
                  <Icon aria-hidden="true" className="size-4" /> {label}
                </button>
              ))}
            </div>
          </div>
          <div aria-hidden="true" className="h-2 overflow-hidden rounded-full bg-secondary">
            <div className="h-full origin-left rounded-full bg-brand-success transition-transform duration-300 motion-reduce:transition-none" style={{ transform: `scaleX(${total ? ready / total : 0})` }} />
          </div>

          {view === "edit" ? (
            <>
              <p id="bs-grid-help" className="sr-only">
                Arrow keys move between squares. Enter edits a square, typing replaces it, Delete clears it. In the editor, Enter goes to the next square, Shift+Enter to the previous one, and Escape returns to the card.
              </p>
              <div role="grid" aria-label={`Bingo card, ${d.size} by ${d.size}`} aria-describedby="bs-grid-help"
                className="mx-auto grid w-full max-w-[max(16rem,min(40rem,calc(100dvh-20rem)))] xl:max-w-[max(16rem,min(40rem,calc(100dvh-25rem)))] gap-1.5 rounded-3xl bg-primary p-2 sm:gap-2 sm:p-3"
                style={{ gridTemplateColumns: `repeat(${d.size}, minmax(0, 1fr))` }}>
                {Array.from({ length: d.size }, (_, r) => (
                  <div role="row" key={r} className="contents">
                    {Array.from({ length: d.size }, (_, c) => {
                      const pos = r * d.size + c;
                      const isFree = pos === centre;
                      const text = normalise(d.cells[pos] ?? "");
                      const problem = showProblems ? problems[pos] : null;
                      const label = shortLabel(pos, d.size);
                      return (
                        <div
                          role="gridcell"
                          key={pos}
                          ref={(el) => { cellRefs.current[pos] = el; }}
                          tabIndex={pos === sel ? 0 : -1}
                          aria-selected={pos === sel}
                          // The name starts with the visible text (label + content) so speech input ("click B2") works.
                          aria-label={`${label} ${isFree ? "Free" : text || "Add"}, ${longLabel(pos, d.size)}${isFree ? ", no photo needed" : text ? "" : ", empty"}${problem ? `. ${problemCopy[problem]}` : ""}`}
                          onClick={() => editCell(pos)}
                          onKeyDown={(e) => onCellKey(pos, e)}
                          className={cn(
                            "group relative flex aspect-square min-w-0 cursor-pointer select-none flex-col items-center justify-center overflow-hidden rounded-2xl p-1.5 text-center leading-tight outline-none transition-[transform,box-shadow,background-color] duration-150 motion-reduce:transition-none",
                            d.size === 5 ? "text-[10px] sm:text-xs" : d.size === 4 ? "text-[11px] sm:text-sm" : "text-xs sm:text-base",
                            isFree ? "bg-brand-yellow text-brand-night" : text ? "bg-card text-foreground" : "border-2 border-dashed border-white/35 bg-white/5 text-white/70 hover:bg-white/10",
                            problem && "ring-2 ring-inset ring-brand-coral",
                            pos === sel && "z-10 shadow-pop ring-4 ring-brand-yellow motion-safe:-translate-y-0.5",
                            "focus-visible:ring-4 focus-visible:ring-brand-yellow",
                          )}
                        >
                          <span aria-hidden="true" className={cn("absolute left-1.5 top-1 font-display text-[10px] font-bold sm:text-[11px]", isFree ? "text-brand-night/80" : text ? "text-primary/70" : "text-white/70",
                            d.size === 5 && "hidden sm:block")}>{label}</span>{" "}
                          {isFree ? (
                            <span aria-hidden="true" className="flex flex-col items-center gap-0.5 font-display font-bold uppercase">
                              <Star className="size-5 fill-current sm:size-6" /> Free
                            </span>
                          ) : text ? (
                            <span aria-hidden="true" className={cn("break-words px-0.5 font-semibold", d.size === 5 ? "line-clamp-3 sm:pt-2.5" : "line-clamp-3 pt-2.5 sm:line-clamp-4")}>{text}</span>
                          ) : (
                            <span aria-hidden="true" className="flex flex-col items-center gap-0.5 font-semibold">
                              <Plus className="size-4 sm:size-5" /><span className={cn(d.size === 5 && "hidden sm:inline")}>Add</span>
                            </span>
                          )}
                          {problem ? <span aria-hidden="true" className="absolute right-1 top-1 grid size-4 place-items-center rounded-full bg-brand-coral text-[10px] font-bold text-white">!</span> : null}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button type="button" disabled={disabled} onClick={() => editCell(nextEmpty(d.cells, shape) ?? (sel === centre ? (stepEditable(sel, shape, 1) ?? 0) : sel))}>
                  <Pencil aria-hidden="true" /> {ready === 0 ? "Fill in squares" : ready === total ? "Edit squares" : `Fill in squares (${total - ready} left)`}
                </Button>
                <Button type="button" variant="ghost" disabled={disabled || ready === total}
                  onClick={() => { setD({ ...d, cells: fillWithIdeas(d.cells, shape) }); toast("Filled the empty squares with ideas. Edit any of them.", "success"); }}>
                  <Sparkles aria-hidden="true" /> Fill empty with ideas
                </Button>
              </div>
              <p className="text-center text-sm text-muted-foreground">Tap a square to write its photo instruction.</p>
            </>
          ) : (
            <PlayerPreview title={titleText} size={d.size} cells={d.cells} centre={centre} minutes={d.minutes} winMode={d.winMode} />
          )}
        </section>

        {/* ------------------------------------------------ rules */}
        <Card className="xl:col-start-1 xl:row-start-2">
          <CardHeader className="pb-4">
            <CardTitle>Rules</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-5">
            <fieldset className="grid gap-2" disabled={disabled}>
              <legend className="mb-2 font-semibold">Winners</legend>
              <Choice name="winnerRule" value="ranked" checked={d.winnerRule === "ranked"} onChange={() => setD({ ...d, winnerRule: "ranked" })}
                icon={<ListOrdered />} title="Ranked list" description="Everyone you verify, in the order they called it." />
              <Choice name="winnerRule" value="first" checked={d.winnerRule === "first"} onChange={() => setD({ ...d, winnerRule: "first" })}
                icon={<Trophy />} title="First wins" description="Only the first verified Bingo takes the prize." />
            </fieldset>
            <fieldset disabled={disabled}>
              <legend className="mb-2 font-semibold">Timer</legend>
              <div className="grid grid-cols-4 gap-2">
                {DURATION_PRESETS_MIN.map((m) => (
                  <label key={m} className="block cursor-pointer">
                    <input type="radio" name="duration" value={m} checked={d.minutes === m && minutesText === String(m)} onChange={() => pickMinutes(m)} className="peer sr-only" />
                    <span className="flex min-h-10 items-center justify-center whitespace-nowrap rounded-full border-2 border-primary/15 bg-card px-2 font-display text-sm font-semibold text-primary transition-colors hover:border-primary/40 peer-checked:border-primary peer-checked:bg-primary peer-checked:text-primary-foreground peer-focus-visible:ring-4 peer-focus-visible:ring-ring/40">
                      {formatMinutes(m)}
                    </span>
                  </label>
                ))}
              </div>
              <div className="mt-3 flex items-end gap-3">
                <div className="grid gap-2">
                  <Label htmlFor="bs-minutes">Minutes</Label>
                  <Input id="bs-minutes" type="number" inputMode="numeric" min={MIN_DURATION_MIN} max={MAX_DURATION_MIN} step={1} className="w-24"
                    value={minutesText} onChange={(e) => setMinutesFromText(e.target.value)} onBlur={() => pickMinutes(clampMinutes(Number(minutesText)))} aria-describedby="bs-minutes-help" />
                </div>
                <p id="bs-minutes-help" className="pb-3 text-sm text-muted-foreground"><Clock aria-hidden="true" className="mr-1 inline size-4 align-[-3px]" />{MIN_DURATION_MIN}–{MAX_DURATION_MIN} min</p>
              </div>
            </fieldset>
            <p className="flex items-start gap-2 rounded-2xl bg-secondary/60 p-3 text-sm text-muted-foreground">
              <Users aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
              {maxPlayers ? `Up to ${maxPlayers} players can join, from your Game Pass (the same limit as Bring Me).` : "Your Game Pass isn't active: you can edit and save this draft, and publish it once you have a pass."}
            </p>
          </CardContent>
        </Card>
      </div>

      {status !== "new" ? (
        <div className="flex justify-end">
          <Button type="button" variant="ghost" size="sm" disabled={disabled}
            onClick={() => setPending({
              title: status === "lobby" ? "Cancel this game?" : "Discard this draft?",
              description: status === "lobby" ? "Nobody will be able to join or play it." : "The draft is removed from your open games. This can't be undone.",
              confirm: status === "lobby" ? "Cancel game" : "Discard draft",
              apply: () => void discard(),
              selfClosing: true,
            })}>
            {status === "lobby" ? "Cancel game" : "Discard draft"}
          </Button>
        </div>
      ) : null}

      {/* ------------------------------------------------ square editor (modal over the card) */}
      <Modal
        open={editing && view === "edit"} onClose={closeEditor}
        className="max-w-lg max-sm:mb-auto max-sm:mt-3"
        title={`Square ${shortLabel(sel, d.size)}`}
        description={longLabel(sel, d.size)}
        footer={
          <>
            <Button type="button" className="w-full sm:w-auto" onClick={closeEditor}>
              <Check aria-hidden="true" /> Done
            </Button>
            <div className="grid grid-cols-2 gap-2 sm:mr-auto sm:flex">
              <Button type="button" variant="outline" disabled={disabled || stepEditable(sel, shape, -1) === null} onClick={() => editCell(stepEditable(sel, shape, -1)!)}>
                <ChevronLeft aria-hidden="true" /> Previous
              </Button>
              <Button type="button" variant="outline" disabled={disabled || stepEditable(sel, shape, 1) === null} onClick={() => editCell(stepEditable(sel, shape, 1)!)}>
                Next <ChevronRight aria-hidden="true" />
              </Button>
            </div>
          </>
        }
      >
        <div className="grid gap-4">
          {/* Where am I + how it will look: the square updates live as you type. */}
          <div className="flex items-center gap-4">
            <div aria-hidden="true"
              className={cn("grid size-24 shrink-0 place-items-center overflow-hidden rounded-2xl p-1.5 text-center text-xs font-semibold leading-tight shadow-pop ring-4 ring-brand-yellow",
                selIsFree ? "bg-brand-yellow text-brand-night" : normalise(d.cells[sel] ?? "") ? "bg-card text-foreground" : "border-2 border-dashed border-primary/30 bg-secondary text-muted-foreground")}>
              {selIsFree ? <span className="flex flex-col items-center font-display font-bold uppercase"><Star className="size-5 fill-current" /> Free</span>
                : <span className="line-clamp-5 break-words">{normalise(d.cells[sel] ?? "") || "Your instruction appears here"}</span>}
            </div>
            <div className="grid min-w-0 gap-2">
              <div role="group" aria-label="Jump to a square" className="grid w-fit gap-1" style={{ gridTemplateColumns: `repeat(${d.size}, minmax(0, 1fr))` }}>
                {Array.from({ length: d.size * d.size }, (_, pos) => {
                  const filled = pos === centre || normalise(d.cells[pos] ?? "") !== "";
                  const bad = showProblems && problems[pos];
                  return (
                    <button key={pos} type="button" disabled={disabled || pos === centre} onClick={() => editCell(pos)}
                      aria-label={`Square ${shortLabel(pos, d.size)}${pos === centre ? ", free" : filled ? ", done" : ", empty"}`} aria-current={pos === sel ? "true" : undefined}
                      className={cn("size-6 rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:size-7",
                        pos === sel ? "bg-brand-yellow ring-2 ring-primary" : pos === centre ? "bg-brand-yellow/50" : bad ? "bg-brand-coral" : filled ? "bg-primary" : "border-2 border-dashed border-primary/30 bg-card")} />
                  );
                })}
              </div>
              <p className="text-sm text-muted-foreground">{ready} of {total} ready</p>
            </div>
          </div>

          {selIsFree ? (
            <p className="text-muted-foreground">
              <Star aria-hidden="true" className="mr-1 inline size-4 fill-brand-yellow align-[-2px] text-brand-yellow-deep" />
              No photo needed: this square is complete for every player. Turn off the free centre in Board setup to use it as a challenge.
            </p>
          ) : (
            <div className="grid gap-1.5">
              <Label htmlFor="bs-edit">Photo instruction</Label>
              <textarea
                id="bs-edit"
                ref={editorRef}
                rows={3}
                value={d.cells[sel] ?? ""}
                maxLength={CHALLENGE_MAX_LENGTH}
                onChange={(e) => setCell(sel, e.target.value.replace(/\n/g, " "))}
                onKeyDown={onEditorKey}
                onPaste={onEditorPaste}
                enterKeyHint="next"
                placeholder={`e.g. ${suggestions([], 1, sel)[0] ?? "Take a photo of red shoes"}`}
                aria-describedby="bs-edit-count bs-edit-err"
                aria-invalid={showProblems && problems[sel] ? true : undefined}
                disabled={disabled}
                className="block min-h-[5.5rem] w-full resize-none rounded-2xl border-2 border-input bg-card px-4 py-3 text-base text-foreground transition-colors placeholder:text-muted-foreground/70 hover:border-primary/40 focus-visible:border-primary focus-visible:outline-none aria-[invalid=true]:border-destructive"
              />
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <p id="bs-edit-err" className="font-semibold text-destructive">{showProblems && problems[sel] ? problemCopy[problems[sel]!] : null}</p>
                <div className="flex items-center gap-2">
                  {(d.cells[sel] ?? "") ? (
                    <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => { setCell(sel, ""); editCell(sel); }}>
                      <Eraser aria-hidden="true" /> Clear
                    </Button>
                  ) : null}
                  <p id="bs-edit-count" className={cn("tabular-nums", (d.cells[sel] ?? "").length >= CHALLENGE_MAX_LENGTH - 20 ? "font-semibold text-brand-coral" : "text-muted-foreground")}
                    aria-live={(d.cells[sel] ?? "").length >= CHALLENGE_MAX_LENGTH - 20 ? "polite" : "off"}>
                    {(d.cells[sel] ?? "").length}/{CHALLENGE_MAX_LENGTH}
                  </p>
                </div>
              </div>
              {ideas.length ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-muted-foreground">Try:</span>
                  {ideas.map((idea) => (
                    <button key={idea} type="button" disabled={disabled} onClick={() => { setCell(sel, idea); editCell(sel); }}
                      className="min-h-11 rounded-full bg-secondary px-3 text-left text-sm font-semibold text-primary transition-colors hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/40">
                      {idea}
                    </button>
                  ))}
                </div>
              ) : null}
              <p className="hidden text-xs text-muted-foreground sm:block">
                <kbd className="rounded bg-secondary px-1.5 py-0.5 font-sans">Enter</kbd> next square · <kbd className="rounded bg-secondary px-1.5 py-0.5 font-sans">Shift+Enter</kbd> previous ·{" "}
                <kbd className="rounded bg-secondary px-1.5 py-0.5 font-sans">Esc</kbd> back to the card · paste a list to fill several squares
              </p>
            </div>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        open={pending !== null}
        title={pending?.title ?? ""}
        description={pending?.description ?? ""}
        confirmLabel={pending?.confirm ?? "Confirm"}
        busy={busy === "discard"}
        onConfirm={() => { if (!pending) return; pending.apply(); if (!pending.selfClosing) setPending(null); }}
        onClose={() => setPending(null)}
      />
    </div>
  );
}

/** What a player's phone will show (their order is shuffled; the free centre stays in the middle). */
function PlayerPreview({ title, size, cells, centre, minutes, winMode }: { title: string; size: number; cells: string[]; centre: number | null; minutes: number; winMode: WinMode }) {
  return (
    <div className="grid gap-3">
      <div className="mx-auto w-full max-w-sm rounded-[2.5rem] bg-brand-night p-3 shadow-card">
        <div className="rounded-[2rem] bg-primary p-3 text-white sm:p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <p className="min-w-0 truncate font-display text-lg font-bold">{title}</p>
            <span className="shrink-0 rounded-full bg-white/15 px-3 py-1 font-display text-sm font-bold tabular-nums">{String(minutes).padStart(2, "0")}:00</span>
          </div>
          <p className="mb-3 text-xs text-white/75">{winMode === "traditional" ? "Snap a full row, column or diagonal, then call Bingo!" : "Snap every square, then call Bingo!"}</p>
          <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${size}, minmax(0, 1fr))` }}>
            {cells.map((raw, i) => {
              const text = normalise(raw);
              return i === centre ? (
                <div key={i} className="flex aspect-square flex-col items-center justify-center rounded-xl bg-brand-yellow font-display text-[10px] font-bold uppercase text-brand-night">
                  <Star aria-hidden="true" className="size-4 fill-current" /> Free
                </div>
              ) : (
                <div key={i} className={cn("flex aspect-square flex-col items-center justify-center gap-1 overflow-hidden rounded-xl p-1 text-center leading-tight", text ? "bg-white text-foreground" : "border border-dashed border-white/40 text-white/60")}>
                  <Camera aria-hidden="true" className={cn("shrink-0", size === 5 ? "size-3" : "size-4", text ? "text-brand-coral" : "")} />
                  <span className={cn("break-words font-semibold", size === 5 ? "line-clamp-2 text-[8px]" : size === 4 ? "line-clamp-3 text-[9px]" : "line-clamp-3 text-[11px]")}>{text || "Empty"}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <p className="text-center text-sm text-muted-foreground">Each player gets these squares in their own shuffled order. Photos stay on their phones.</p>
    </div>
  );
}
