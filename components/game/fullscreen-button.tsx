"use client";

import { Expand, Minimize } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type FsDocument = Document & {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type FsElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

/**
 * Whole-page fullscreen for players' phones (standard API + the older WebKit prefix for iPadOS Safari).
 * `supported` is false where pages can't go fullscreen (iPhone Safari allows it for videos only), so the
 * button simply isn't shown there. Decided after mount, so server and client markup match.
 */
export function useFullscreen() {
  const [supported, setSupported] = useState(false);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const d = document as FsDocument;
    setSupported(Boolean(d.fullscreenEnabled || d.webkitFullscreenEnabled));
    const sync = () => setActive(Boolean(d.fullscreenElement || d.webkitFullscreenElement));
    sync();
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
    };
  }, []);

  const toggle = useCallback(async () => {
    const d = document as FsDocument;
    const el = document.documentElement as FsElement;
    try {
      if (d.fullscreenElement || d.webkitFullscreenElement) {
        await (d.exitFullscreen ? d.exitFullscreen() : d.webkitExitFullscreen?.());
      } else {
        await (el.requestFullscreen ? el.requestFullscreen({ navigationUI: "hide" }) : el.webkitRequestFullscreen?.());
      }
    } catch { /* refused (e.g. not from a tap): the page keeps working as it is */ }
  }, []);

  return { supported, active, toggle };
}

/** Icon-only fullscreen toggle for dark player screens. Renders nothing where fullscreen isn't available. */
export function FullscreenButton({ className, compact = false }: { className?: string; compact?: boolean }) {
  const { supported, active, toggle } = useFullscreen();
  if (!supported) return null;
  const label = active ? "Exit fullscreen" : "Fullscreen";
  return (
    <Button
      type="button"
      variant="outline-light"
      size="icon"
      onClick={() => void toggle()}
      aria-label={label}
      title={label}
      className={cn("rounded-full", compact && "size-9 [&_svg]:size-4", className)}
    >
      {active ? <Minimize aria-hidden="true" /> : <Expand aria-hidden="true" />}
    </Button>
  );
}
