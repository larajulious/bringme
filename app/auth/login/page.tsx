import type { Metadata } from "next";
import { Suspense } from "react";

import { AuthNotice } from "@/components/auth/auth-notice";
import { AuthPage } from "@/components/auth/auth-page";
import { EmailOtpForm } from "@/components/auth/email-otp-form";

export const metadata: Metadata = { title: "Sign in or create an account", robots: { index: false, follow: true } };

export default function Page({ searchParams }: { searchParams: Promise<{ reason?: string; error?: string }> }) {
  return (
    <AuthPage>
      <Suspense>
        <AuthNotice searchParams={searchParams} />
      </Suspense>
      <Suspense>
        <EmailOtpForm />
      </Suspense>
    </AuthPage>
  );
}
