"use client";

import { Check, Copy, ExternalLink, RefreshCw, Tv } from "lucide-react";
import { useEffect, useState } from "react";

import { QrCode } from "@/components/game/qr-code";
import { Button } from "@/components/ui/button";
import { Loading } from "@/components/ui/loading";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";

type Link = { url: string; path: string };

/**
 * Host-only "TV link": a public address for the audience-safe presenter screen, to open on any smart-TV browser
 * (no sign-in). Created on first open; "Reset link" replaces it and cuts off every TV holding the old one.
 */
export function TvLinkButton({ gameId }: { gameId: string }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState<Link | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = async (reset = false) => {
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch(`/api/host/games/${gameId}/screen-link`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reset }),
      });
      if (!res.ok) throw new Error("failed");
      setLink((await res.json()) as Link);
      if (reset) toast("New TV link ready. Old TV links stopped working.", "success");
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
      setConfirmReset(false);
    }
  };

  useEffect(() => {
    if (open && !link && !busy && !failed) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per open
  }, [open]);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
      toast("TV link copied", "success");
    } catch {
      toast(`Copy blocked by the browser. Link: ${link.url}`, "info");
    }
  };

  const shown = link?.url.replace(/^https?:\/\//, "") ?? "";

  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)} aria-haspopup="dialog">
        <Tv aria-hidden="true" /> TV link
      </Button>
      <Modal
        open={open}
        onClose={() => { setOpen(false); setConfirmReset(false); }}
        title="Show the game on a TV"
        description="Open this address in the TV's web browser. No sign-in needed. The TV shows exactly what the presenter screen shows."
        className="max-w-lg"
      >
        {link ? (
          <div className="grid gap-4">
            <p className="break-all rounded-2xl bg-secondary px-4 py-3 text-center font-mono text-lg font-bold text-primary sm:text-xl" aria-label={`TV link ${shown}`}>
              {shown}
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              <Button type="button" size="sm" variant="secondary" onClick={copy}>
                {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />} {copied ? "Copied" : "Copy link"}
              </Button>
              <Button asChild size="sm" variant="outline">
                <a href={link.url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink aria-hidden="true" /> Open<span className="sr-only"> TV screen in a new tab</span>
                </a>
              </Button>
            </div>
            <div className="grid justify-items-center gap-2 text-center">
              <div className="w-48 overflow-hidden rounded-2xl border bg-white p-2">
                <QrCode value={link.url} label="QR code of the TV link" className="h-auto w-full" />
              </div>
              <p className="text-sm text-muted-foreground">Scan with a phone to open it there, then cast or AirPlay it to the TV.</p>
            </div>
            <div className="rounded-2xl border border-dashed p-3 text-sm text-muted-foreground">
              {confirmReset ? (
                <div className="grid gap-2">
                  <p className="font-semibold text-foreground">Reset the TV link? Every TV using the current link stops showing the game.</p>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" size="sm" variant="destructive" onClick={() => void load(true)} disabled={busy}>{busy ? "Resetting…" : "Reset link"}</Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmReset(false)} disabled={busy}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p>Anyone with this link can watch the screen (never the item list or review photos).</p>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmReset(true)}>
                    <RefreshCw aria-hidden="true" /> Reset link
                  </Button>
                </div>
              )}
            </div>
          </div>
        ) : failed ? (
          <div className="grid justify-items-center gap-3 text-center">
            <p className="text-muted-foreground">Couldn&apos;t get the TV link. Check your connection and try again.</p>
            <Button type="button" size="sm" onClick={() => void load()}>Try again</Button>
          </div>
        ) : (
          <Loading className="min-h-40 rounded-2xl" />
        )}
      </Modal>
    </>
  );
}
