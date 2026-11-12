import { Suspense } from "react";

import { Logo } from "@/components/brand/logo";
import { AuthButton } from "@/components/auth-button";
import { hasEnvVars } from "@/lib/utils";

/**
 * Landing header (on dark purple). `brand={false}` (homepage, where the big logo is right below) drops the
 * header logo and puts "Get started" in its place on the left.
 */
export function SiteHeader({ brand = true }: { brand?: boolean }) {
  return (
    <header className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-5 py-5">
      {brand ? <Logo href="/" size="md" tone="light" /> : null}
      {hasEnvVars ? (
        <Suspense fallback={<div className="h-9 w-24" aria-hidden="true" />}>
          <AuthButton split={!brand} />
        </Suspense>
      ) : null}
    </header>
  );
}
