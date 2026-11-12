import type { Metadata } from "next";

import { PlayerShell } from "@/components/layout/player-shell";

export const metadata: Metadata = { title: "Play" };

export default function PlayLayout({ children }: { children: React.ReactNode }) {
  return <PlayerShell>{children}</PlayerShell>;
}
