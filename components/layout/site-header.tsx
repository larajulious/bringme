import { Suspense } from "react";

import { Logo } from "@/components/brand/logo";
import { AuthButton } from "@/components/auth-button";
import { hasEnvVars } from "@/lib/utils";

/** Landing header (on dark purple). */
export function SiteHeader() {
  return (
    <header className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-5 py-5">
      <Logo href="/" size="md" tone="light" />
      {hasEnvVars ? (
        <Suspense fallback={<div className="h-9 w-24" aria-hidden="true" />}>
          <AuthButton />
        </Suspense>
      ) : null}
    </header>
  );
}
