import Link from "next/link";
import { Compass } from "lucide-react";

import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FitViewport } from "@/components/layout/fit-viewport";

export default function NotFound() {
  return (
    <main className="fit-viewport h-viewport mx-auto flex w-full max-w-lg flex-col items-center justify-center gap-6 overflow-y-auto p-6 short:gap-4">
      <FitViewport />
      <Logo href="/" size="lg" />
      <EmptyState
        icon={<Compass />}
        title="We couldn't find that page"
        description="The link may be old or mistyped."
        action={
          <Button asChild>
            <Link href="/">Back to home</Link>
          </Button>
        }
      />
    </main>
  );
}
