"use client";

import { Archive, DoorClosed, Expand, Minimize } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { Confetti } from "@/components/game/confetti";
import { fetchHostSnapshot, phaseKey, runAction } from "@/components/game/host-api";
import { TrophyIllustration } from "@/components/game/trophy";
import { useGameSync } from "@/components/game/use-game-sync";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { formatElapsed } from "@/lib/game/timing";
import type { HostSnapshot } from "@/lib/game/types";

type Photo = { no: number; photoUrl: string | null };

/**
 * Completed game: the winner of every round (name, time, photo), plus
 * "Archive game". Works for the live console and when revisiting later.
 */
export function FinishedResults({ gameId, initial }: { gameId: string; initial: HostSnapshot }) {
  const { toast } = useToast();
  const { state: s, applyState, resync } = useGameSync<HostSnapshot>({ gameId, role: "host", initial, fetchSnapshot: () => fetchHostSnapshot(gameId) });
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fs, setFs] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (s.status !== "finished") return;
    let live = true;
    fetch(`/api/host/games/${gameId}/results`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
      .then((d: { rounds: Photo[] }) => { if (live) setPhotos(d.rounds); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [gameId, s.status]);
  useEffect(() => {
    const on = () => setFs(document.fullscreenElement === ref.current);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);

  const archive = async () => {
    setBusy(true);
    const { result, changedUnderneath } = await runAction(gameId, "archive", s.version, phaseKey(s));
    setBusy(false);
    setConfirm(false);
    if (result.ok) { applyState(result.state); toast("Game archived", "success"); return; }
    if (changedUnderneath) applyState(changedUnderneath); else resync();
    toast("Couldn't archive the game. Please try again.", "error");
  };

  const results = s.results ?? [];
  const wins = new Map<string, number>();
  for (const r of results) if (r.winnerName) wins.set(r.winnerName, (wins.get(r.winnerName) ?? 0) + 1);
  const cancelled = s.status === "canceled";

  return (
    <div ref={ref} className={fs ? "h-viewport flex flex-col gap-[2dvh] overflow-hidden bg-gradient-to-b from-primary to-brand-night p-[3dvh] text-white" : "grid gap-6"}>
      <Card className={fs ? "shrink-0 border-0 bg-transparent shadow-none" : "relative overflow-hidden"}>
        {!cancelled ? <Confetti pieces={30} /> : null}
        <CardContent className={cn("relative z-10 grid justify-items-center text-center", fs ? "gap-[1.5dvh] p-[1dvh]" : "gap-4 p-8")}>
          {cancelled ? <DoorClosed aria-hidden="true" className="size-14 text-primary" /> : <TrophyIllustration className={fs ? "w-[min(9rem,14dvh)]" : "w-36"} />}
          <h2 className={fs ? "font-display text-[clamp(2.5rem,8dvh,4.5rem)] font-bold leading-tight text-brand-yellow" : "font-display text-4xl font-bold text-primary"}>{cancelled ? "Game cancelled" : "Game complete!"}</h2>
          <p className={fs ? "text-[clamp(1.125rem,3.4dvh,1.875rem)]" : "text-muted-foreground"}>{s.title}{s.archivedAt ? " · archived" : ""}</p>
          {!cancelled && wins.size ? (
            <p className={fs ? "text-[clamp(1.125rem,3.4dvh,1.875rem)]" : "text-sm text-muted-foreground"}>
              {[...wins.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} ${c}×`).join(" · ")}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-center gap-3 print:hidden">
            {!cancelled ? (
              <Button variant={fs ? "outline-light" : "outline"} size="sm" onClick={async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await ref.current?.requestFullscreen(); } catch { /* optional */ } }}>
                {fs ? <Minimize aria-hidden="true" /> : <Expand aria-hidden="true" />}{fs ? "Exit fullscreen" : "Present results"}
              </Button>
            ) : null}
            {!cancelled && !s.archivedAt ? <Button onClick={() => setConfirm(true)} disabled={busy}><Archive aria-hidden="true" /> Archive game</Button> : null}
            {s.archivedAt ? <Badge variant="secondary">Archived</Badge> : null}
            <Button asChild variant={fs ? "outline-light" : "outline"}><Link href="/dashboard">Back to dashboard</Link></Button>
          </div>
        </CardContent>
      </Card>

      {!cancelled ? (
        <ol className={fs ? "grid min-h-0 flex-1 grid-cols-1 content-start gap-[1.5dvh] overflow-y-auto xl:grid-cols-2" : "grid gap-3"} aria-label="Winners by round">
          {results.map((r) => {
            const photo = photos.find((p) => p.no === r.no)?.photoUrl ?? null;
            return (
              <li key={r.no} className={fs ? "flex items-center gap-[2vw] rounded-3xl bg-white/10 p-[1.5dvh]" : "flex items-center gap-4 rounded-3xl border bg-card p-4 shadow-card"}>
                <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-brand-yellow font-display text-xl font-bold text-brand-night">{r.no}</span>
                {photo ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={photo} alt={`Winning photo, round ${r.no}`} loading="lazy" className={fs ? "size-[min(7rem,10dvh)] rounded-2xl bg-black object-cover" : "size-20 rounded-xl bg-black object-cover"} />
                ) : null}
                <div className="min-w-0 flex-1">
                  <p className={fs ? "break-words text-[clamp(1rem,2.8dvh,1.5rem)] leading-snug text-white/80 [overflow-wrap:anywhere]" : "break-words text-sm text-muted-foreground [overflow-wrap:anywhere]"}>{r.prompt}</p>
                  <p className={fs ? "truncate font-display text-[clamp(1.5rem,4.5dvh,3rem)] font-bold text-brand-yellow" : "truncate font-display text-2xl font-bold text-primary"}>{r.winnerName ?? "No winner"}</p>
                </div>
                {r.winnerMs !== null ? <p className={fs ? "font-mono text-[clamp(1.5rem,4.5dvh,3rem)] font-bold tabular-nums" : "font-mono text-2xl font-bold tabular-nums text-primary"}>{formatElapsed(r.winnerMs)}</p> : null}
              </li>
            );
          })}
          {results.length === 0 ? <li className="text-muted-foreground">No rounds were played.</li> : null}
        </ol>
      ) : null}

      <ConfirmDialog open={confirm} busy={busy} destructive={false} title="Archive this game?" confirmLabel="Archive"
        description="It moves out of your recent history. Results and photos stay available to you." onClose={() => setConfirm(false)} onConfirm={archive} />
    </div>
  );
}
