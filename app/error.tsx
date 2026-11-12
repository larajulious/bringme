"use client";

import { ErrorPanel } from "@/components/layout/error-panel";

export default function RootError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorPanel {...props} />;
}
