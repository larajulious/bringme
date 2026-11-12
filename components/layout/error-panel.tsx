"use client";

import { useEffect } from "react";
import { TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

/** Shared body for route-level `error.tsx` boundaries. */
export function ErrorPanel({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div role="alert" className="mx-auto w-full max-w-lg p-6">
      <EmptyState
        icon={<TriangleAlert />}
        title="Oops, the party hit a snag"
        description="Something went wrong on our side. Give it another try."
        action={<Button onClick={reset}>Try again</Button>}
      />
    </div>
  );
}
