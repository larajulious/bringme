"use client";

import { Eye, EyeOff } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const KEY = "bringme:hide-items";
const EVENT = "bringme:hide-items";

/**
 * Host-only privacy toggle for the items to bring (e.g. the dashboard is on a shared screen).
 * Remembered per device; every component using it on the page stays in sync. Defaults to shown.
 */
export function useItemPrivacy(): [hidden: boolean, toggle: () => void] {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    try { setHidden(localStorage.getItem(KEY) === "1"); } catch { /* storage blocked: stay shown */ }
    const on = (e: Event) => setHidden((e as CustomEvent<boolean>).detail);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  const toggle = useCallback(() => {
    setHidden((h) => {
      const next = !h;
      try { localStorage.setItem(KEY, next ? "1" : "0"); } catch { /* not remembered, still works */ }
      queueMicrotask(() => window.dispatchEvent(new CustomEvent(EVENT, { detail: next })));
      return next;
    });
  }, []);
  return [hidden, toggle];
}

/** The eye button. `label` names what it hides, for screen readers ("item", "items"). */
export function ItemPrivacyToggle({ hidden, onToggle, label = "item", className }: { hidden: boolean; onToggle: () => void; label?: string; className?: string }) {
  return (
    <Button type="button" size="icon" variant="ghost" aria-pressed={hidden} onClick={onToggle}
      aria-label={hidden ? `Show ${label}` : `Hide ${label}`} title={hidden ? `Show ${label}` : `Hide ${label}`}
      className={cn("shrink-0", className)}>
      {hidden ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
    </Button>
  );
}

/** The item text, or a calm placeholder of similar size while hidden. */
export function ItemText({ text, hidden, className }: { text: string; hidden: boolean; className?: string }) {
  if (!hidden) return <span className={className}>{text}</span>;
  return (
    <span className={cn(className, "select-none text-muted-foreground/70")}>
      <span aria-hidden="true">••••••</span>
      <span className="sr-only">Hidden</span>
    </span>
  );
}
