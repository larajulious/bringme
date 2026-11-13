"use client";

import { Check, Copy, ExternalLink, QrCode } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";

/**
 * Host-only join tools for the game's top bar: copy the join link, show the QR (to hold up a phone or share
 * the screen) and open the join page. `qr` is the server-rendered SVG.
 */
export function HostJoinTools({ joinUrl, joinCode, title, qr }: { joinUrl: string; joinCode: string; title: string; qr: ReactNode }) {
  const { toast } = useToast();
  const [showQr, setShowQr] = useState(false);
  const [copied, setCopied] = useState(false);

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

  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={copy}>
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        {copied ? "Copied" : "Copy link"}
      </Button>
      <Button type="button" size="sm" variant="outline" onClick={() => setShowQr(true)} aria-haspopup="dialog">
        <QrCode aria-hidden="true" /> Show QR
      </Button>
      <Button asChild size="sm" variant="outline">
        <a href={joinUrl} target="_blank" rel="noopener noreferrer">
          <ExternalLink aria-hidden="true" /> Open<span className="sr-only"> join page in a new tab</span>
        </a>
      </Button>

      <Modal
        open={showQr}
        onClose={() => setShowQr(false)}
        title={`Join ${title}`}
        description={`Scan the code or go to ${joinUrl.replace(/^https?:\/\//, "")}`}
        className="max-w-lg"
      >
        <div className="grid justify-items-center gap-4 text-center">
          <div className="w-[min(60dvh,100%,24rem)] overflow-hidden rounded-3xl border bg-white p-3">{qr}</div>
          <p className="text-muted-foreground">
            Room code <span className="ml-1 font-mono text-3xl font-bold tracking-[0.2em] text-primary">{joinCode}</span>
          </p>
        </div>
      </Modal>
    </>
  );
}
