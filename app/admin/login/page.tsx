import type { Metadata } from "next";
import { Suspense } from "react";

import { AuthNotice } from "@/components/auth/auth-notice";
import { AuthPage } from "@/components/auth/auth-page";
import { EmailOtpForm } from "@/components/auth/email-otp-form";

export const metadata: Metadata = { title: "Super Admin login", robots: { index: false } };

export default function Page({ searchParams }: { searchParams: Promise<{ reason?: string; error?: string }> }) {
  return (
    <AuthPage>
      <Suspense>
        <AuthNotice searchParams={searchParams} />
      </Suspense>
      <Suspense>
        <EmailOtpForm area="admin" />
      </Suspense>
    </AuthPage>
  );
}
