import type { ReactNode } from "react";

import { Backdrop } from "@/components/brand/backdrop";
import { Logo } from "@/components/brand/logo";
import { FitViewport } from "@/components/layout/fit-viewport";

/**
 * Branded full-screen wrapper for every auth screen. Exactly the viewport (no
 * page scroll); tall content on a small phone scrolls inside it.
 */
export function AuthPage({ children }: { children: ReactNode }) {
  return (
    <main className="fit-viewport h-viewport relative isolate overflow-hidden bg-gradient-to-b from-primary to-brand-night">
      <FitViewport />
      <Backdrop />
      <div className="flex h-full flex-col items-center overflow-y-auto overscroll-contain p-5 pt-safe pb-safe">
        <div className="my-auto flex w-full flex-col items-center gap-6 py-5 short:gap-4 short:py-3">
          <Logo href="/" size="lg" tone="light" />
          <div className="w-full max-w-md">{children}</div>
        </div>
      </div>
    </main>
  );
}
