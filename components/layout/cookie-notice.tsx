"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { ChevronDown, Cookie } from "lucide-react";

import { Button } from "@/components/ui/button";
import { getConsent, setConsent } from "@/lib/site/consent";
import { cn } from "@/lib/utils";

/**
 * Cookie & storage notice with a real choice. Essential cookies (login, 12 h player session) are always on.
 * Optional "preferences" (homepage boop count, sound, hunt view) are stored only if allowed. No tracking exists.
 * Hidden until hydration so it never flashes. A "Cookie settings" button (see CookieSettingsButton) reopens it.
 */
export function CookieNotice() {
  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState(false);
  const [prefs, setPrefs] = useState(false);
  const detailsId = useId();

  useEffect(() => {
    const show = () => { setPrefs(getConsent() === "all"); setDetails(true); setOpen(true); };
    if (getConsent() === null) setOpen(true);
    window.addEventListener("bm-open-cookie-settings", show);
    return () => window.removeEventListener("bm-open-cookie-settings", show);
  }, []);

  if (!open) return null;

  const choose = (value: "all" | "essential") => { setConsent(value); setOpen(false); setDetails(false); };

  return (
    <section
      aria-label="Cookie settings"
      className="fixed inset-x-3 bottom-3 z-50 mx-auto max-w-xl animate-pop-in rounded-2xl border-2 border-primary/20 bg-card p-4 shadow-pop-purple"
    >
      <div className="flex items-start gap-3">
        <Cookie aria-hidden="true" className="mt-0.5 size-6 shrink-0 text-primary" />
        <p className="flex-1 text-sm text-foreground">
          We use essential cookies so the game works. We can also remember small preferences on this device. No ads, no tracking.{" "}
          <Link href="/privacy#cookies" className="font-semibold text-primary underline underline-offset-4">Privacy policy</Link>
        </p>
      </div>

      <button
        type="button"
        onClick={() => setDetails((d) => !d)}
        aria-expanded={details}
        aria-controls={detailsId}
        className="mt-2 inline-flex items-center gap-1 rounded-md text-sm font-semibold text-primary underline-offset-4 hover:underline"
      >
        Customize <ChevronDown aria-hidden="true" className={cn("size-4 transition-transform", details && "rotate-180")} />
      </button>

      {details && (
        <div id={detailsId} className="mt-2 space-y-2 text-sm">
          <label className="flex items-start gap-3 rounded-xl bg-muted p-3">
            <input type="checkbox" checked disabled className="mt-1 size-4 accent-primary" />
            <span><strong>Essential</strong> (always on). Keeps Game Masters signed in and players in their game (12 hours).</span>
          </label>
          <label className="flex cursor-pointer items-start gap-3 rounded-xl bg-muted p-3">
            <input type="checkbox" checked={prefs} onChange={(e) => setPrefs(e.target.checked)} className="mt-1 size-4 accent-primary" />
            <span><strong>Preferences</strong>. Remembers your boop count, sound setting and list/card view on this device.</span>
          </label>
        </div>
      )}

      <div className="mt-3 flex flex-wrap justify-end gap-2">
        {details ? (
          <Button size="sm" onClick={() => choose(prefs ? "all" : "essential")}>Save choices</Button>
        ) : (
          <>
            <Button size="sm" variant="outline" onClick={() => choose("essential")}>Essential only</Button>
            <Button size="sm" onClick={() => choose("all")}>Accept all</Button>
          </>
        )}
      </div>
    </section>
  );
}

/** Footer link to reopen the settings. */
export function CookieSettingsButton({ className }: { className?: string }) {
  return (
    <button type="button" className={className} onClick={() => window.dispatchEvent(new Event("bm-open-cookie-settings"))}>
      Cookie settings
    </button>
  );
}
