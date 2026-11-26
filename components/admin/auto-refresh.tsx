"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

/** Re-runs the server page every `seconds` while the tab is visible, plus a manual "Refresh now". */
export function AutoRefresh({ seconds = 30, checkedAt }: { seconds?: number; checkedAt: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [on, setOn] = useState(true);

  useEffect(() => {
    if (!on) return;
    const tick = () => { if (document.visibilityState === "visible") startTransition(() => router.refresh()); };
    const id = window.setInterval(tick, seconds * 1000);
    const onVisible = () => { if (document.visibilityState === "visible") tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.clearInterval(id); document.removeEventListener("visibilitychange", onVisible); };
  }, [on, seconds, router]);

  const time = new Date(checkedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });

  return (
    <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
      {/* server and browser may format in different time zones; the browser's value wins */}
      <span suppressHydrationWarning>Checked at {time}</span>
      <div className="flex items-center gap-2">
        <Checkbox id="auto-refresh" checked={on} onCheckedChange={(v) => setOn(v === true)} />
        <Label htmlFor="auto-refresh" className="font-normal text-muted-foreground">Auto-refresh every {seconds}s</Label>
      </div>
      <Button size="sm" variant="outline" disabled={pending} onClick={() => startTransition(() => router.refresh())}>
        <RefreshCw aria-hidden="true" className={pending ? "animate-spin motion-reduce:animate-none" : undefined} /> Refresh now
      </Button>
    </div>
  );
}
