"use client";

import { ErrorPanel } from "@/components/layout/error-panel";

export default function ConsoleError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorPanel {...props} />;
}
