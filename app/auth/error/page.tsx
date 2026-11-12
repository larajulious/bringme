import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import { Suspense } from "react";

import { AuthPage } from "@/components/auth/auth-page";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

const messages: Record<string, string> = {
  link_invalid: "That link is invalid or has expired. Please request a new one.",
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
      action={<Button asChild><Link href="/auth/login">Back to sign in</Link></Button>}
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
