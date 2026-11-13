import type { ReactNode } from "react";

import { Backdrop } from "@/components/brand/backdrop";
import { Logo } from "@/components/brand/logo";
import { FullscreenButton } from "@/components/game/fullscreen-button";
import { FitViewport } from "@/components/layout/fit-viewport";

/**
 * Mobile-first shell for players: single centered column, safe-area padding and
 * large touch targets. It is EXACTLY the visible viewport (`h-viewport` follows
 * the mobile address bar) and the document never scrolls (`fit-viewport`), so
 * nothing shifts mid-game. Screens shrink their decorative parts on short
 * viewports (`short:` / `tiny:`); if something still can't fit (e.g. large
 * accessibility text), only <main> scrolls, never the page.
 */
export function PlayerShell({ children, homeLink = true }: { children: ReactNode; homeLink?: boolean }) {
  return (
    <div className="fit-viewport h-viewport relative isolate flex flex-col overflow-hidden bg-gradient-to-b from-primary to-brand-night">
      <FitViewport />
      <Backdrop />
      {/* Three columns keep the logo centred with the fullscreen button on the right. */}
      <header className="pt-safe grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 px-4 pb-2 pt-5 short:pb-1 short:pt-3 tiny:pt-2">
        <span aria-hidden="true" />
        <Logo href={homeLink ? "/" : undefined} size="md" tone="light" />
        <FullscreenButton compact className="justify-self-end" />
      </header>
      <main className="mx-auto flex min-h-0 w-full max-w-md flex-1 flex-col overflow-y-auto overscroll-contain px-4 pb-8 pt-4 pb-safe short:pb-4 short:pt-2 tiny:pb-3 tiny:pt-1">
        {children}
      </main>
    </div>
  );
}
