"use client";

import { Check, Copy, Expand, ExternalLink, Minimize, QrCode } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import type { Conn } from "@/components/game/use-game-sync";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

export const connText: Record<Conn, string> = { connecting: "Connecting…", live: "Live", basic: "Live (basic)", reconnecting: "Reconnecting…", offline: "Offline" };

const Kbd = ({ children }: { children: ReactNode }) => <kbd className="ml-1 rounded bg-white/15 px-1.5 font-mono text-xs">{children}</kbd>;

/**
 * Bottom-right presenter toolbar: connection status, join tools (copy link, show the QR on screen, open the
 * join page) and fullscreen. Fades out with the rest of the chrome when the mouse is idle. "Q" toggles the QR.
 */
export function PresenterControls({ conn, idle, fullscreen, onToggleFullscreen, joinUrl, joinCode, qr, title }: {
  conn: Conn; idle: boolean; fullscreen: boolean; onToggleFullscreen: () => void;
  joinUrl: string; joinCode: string; qr: ReactNode; title: string;
}) {
  const { toast } = useToast();
  const [showQr, setShowQr] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "q" || e.key === "Q") && !e.metaKey && !e.ctrlKey && !e.altKey) setShowQr((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(joinUrl);
      setCopied(true);
      toast("Join link copied", "success");
    } catch {
      toast(`Copy blocked by the browser. Link: ${joinUrl}`, "info");
    }
  };

  const shortUrl = joinUrl.replace(/^https?:\/\//, "");

  return (
    <>
      <div
        className={cn(
          "absolute bottom-[2dvh] right-[2vw] z-30 flex max-w-[96vw] flex-wrap items-center justify-end gap-2 transition-opacity duration-300 sm:gap-3",
          idle && !showQr ? "pointer-events-none opacity-0" : "opacity-100",
        )}
      >
        <span className="inline-flex items-center gap-2 rounded-full bg-black/40 px-3 py-1.5 text-sm font-semibold" role="status">
          <span aria-hidden="true" className={cn("size-2.5 rounded-full", conn === "live" ? "bg-emerald-500" : conn === "offline" ? "bg-brand-coral" : "bg-brand-yellow")} />
          {connText[conn]}
        </span>
        <Button type="button" variant="outline-light" size="sm" onClick={copy}>
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? "Copied" : "Copy link"}
        </Button>
        <Button type="button" variant="outline-light" size="sm" onClick={() => setShowQr(true)} aria-haspopup="dialog">
          <QrCode aria-hidden="true" /> Show QR <Kbd>Q</Kbd>
        </Button>
        <Button asChild variant="outline-light" size="sm">
          <a href={joinUrl} target="_blank" rel="noopener noreferrer">
            <ExternalLink aria-hidden="true" /> Open<span className="sr-only"> join page in a new tab</span>
          </a>
        </Button>
        <Button type="button" variant="outline-light" size="sm" onClick={onToggleFullscreen}>
          {fullscreen ? <Minimize aria-hidden="true" /> : <Expand aria-hidden="true" />}
          {fullscreen ? "Exit fullscreen" : "Fullscreen"} <Kbd>F</Kbd>
        </Button>
      </div>

      {/* Big on-screen QR so late arrivals can still join mid-game. */}
      <Modal
        open={showQr}
        onClose={() => setShowQr(false)}
        title={`Join ${title}`}
        description={`Scan the code or go to ${shortUrl}`}
        className="max-w-[min(90vw,46rem)]"
      >
        <div className="grid justify-items-center gap-4 text-center">
          <div className="w-[min(60dvh,80vw,36rem)] overflow-hidden rounded-3xl bg-white p-3 shadow-card">{qr}</div>
          {joinCode ? (
            <p className="text-lg text-muted-foreground">
              Room code <span className="ml-1 font-mono text-3xl font-bold tracking-[0.2em] text-primary">{joinCode}</span>
            </p>
          ) : null}
          <p className="text-sm text-muted-foreground">Press <kbd className="rounded bg-muted px-1.5 font-mono">Q</kbd> or <kbd className="rounded bg-muted px-1.5 font-mono">Esc</kbd> to close</p>
        </div>
      </Modal>
    </>
  );
}
