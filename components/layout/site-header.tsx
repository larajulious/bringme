import { Suspense } from "react";

import { Logo } from "@/components/brand/logo";
import { AuthButton } from "@/components/auth-button";
import { cn, hasEnvVars } from "@/lib/utils";

/**
 * Landing header (on dark purple). `compactMobile` (homepage, where the big logo sits right below): on phones the
 * header logo is hidden and the actions are centred; from `sm` up it's the usual logo left, actions right.
 */
export function SiteHeader({ compactMobile = false }: { compactMobile?: boolean }) {
  return (
    <header className={cn("mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-5 py-5", compactMobile && "justify-center sm:justify-between")}>
      {/* wrapper hides the whole link on phones (display: none also takes it out of the tab order) */}
      <div className={cn(compactMobile && "hidden sm:block")}>
        <Logo href="/" size="md" tone="light" />
      </div>
      {hasEnvVars ? (
        <Suspense fallback={<div className="h-9 w-24" aria-hidden="true" />}>
          <AuthButton />
        </Suspense>
      ) : null}
    </header>
  );
}
