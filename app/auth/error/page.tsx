import type { Metadata } from "next";
import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import { Suspense } from "react";

import { AuthPage } from "@/components/auth/auth-page";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { OTP_LENGTH } from "@/lib/auth/otp";

export const metadata: Metadata = { title: "Sign-in problem", robots: { index: false, follow: false } };

const messages: Record<string, string> = {
  // Email links are no longer used for sign-in (an old email or a mis-set template can still carry one).
  link_invalid: `That email link has expired or was already used. Bring Me now signs you in with a ${OTP_LENGTH}-digit code: go back, enter your email and type the code from the newest email.`,
  profile_missing: "We couldn't load your account. Please sign in again or contact support.",
  profile_lookup_failed: "We couldn't reach your account details right now. Please try again in a moment.",
};

async function Content({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <EmptyState
      icon={<TriangleAlert />}
      title="Sorry, something went wrong"
      description={(error && messages[error]) || "Please try signing in again."}
      action={<Button asChild><Link href="/auth/login">Get a sign-in code</Link></Button>}
    />
  );
}

export default function Page({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  return (
    <AuthPage>
      <Suspense>
        <Content searchParams={searchParams} />
      </Suspense>
    </AuthPage>
  );
}
