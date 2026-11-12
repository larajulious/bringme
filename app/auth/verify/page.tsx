import type { Metadata } from "next";
import { MailCheck } from "lucide-react";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AuthPage } from "@/components/auth/auth-page";
import { ConfirmEmailButton } from "@/components/auth/confirm-email-button";
import { Card, CardContent } from "@/components/ui/card";
import { parseEmailOtpType } from "@/lib/auth/confirm";
import { safeNext } from "@/lib/auth/redirect";

// same-origin: the token in this URL is never sent to another site as a Referer, while the form POST
// still carries an Origin header for the CSRF check.
export const metadata: Metadata = { title: "Confirm your email", robots: { index: false, follow: false }, referrer: "same-origin" };

type Params = Promise<{ token_hash?: string; type?: string; next?: string }>;

/**
 * Landing page for the Confirm signup link. Shows a button instead of verifying on load, so email
 * security scanners that prefetch links can't use up the one-time token. The button POSTs to /auth/confirm.
 */
export default function Page({ searchParams }: { searchParams: Params }) {
  return (
    <AuthPage>
      <Suspense>
        <ConfirmCard searchParams={searchParams} />
      </Suspense>
    </AuthPage>
  );
}

async function ConfirmCard({ searchParams }: { searchParams: Params }) {
  const { token_hash: tokenHash, type: rawType, next } = await searchParams;
  const type = parseEmailOtpType(rawType ?? null);
  if (!tokenHash || !type) redirect("/auth/login?error=link_invalid");

  return (
    <Card>
      <CardContent className="flex flex-col gap-6 p-6 sm:p-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="grid size-16 place-items-center rounded-full bg-secondary text-primary" aria-hidden="true">
            <MailCheck className="!size-8" />
          </span>
          <h1 className="font-display text-2xl font-bold text-primary sm:text-3xl">Almost there!</h1>
          <p className="text-muted-foreground">Tap the button to confirm your email and start using Bring Me.</p>
        </div>
        <form method="post" action="/auth/confirm" className="flex flex-col">
          <input type="hidden" name="token_hash" value={tokenHash} />
          <input type="hidden" name="type" value={type} />
          {next ? <input type="hidden" name="next" value={safeNext(next, "/auth/continue")} /> : null}
          <ConfirmEmailButton />
        </form>
      </CardContent>
    </Card>
  );
}
