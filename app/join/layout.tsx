import type { Metadata } from "next";

import { PlayerShell } from "@/components/layout/player-shell";

export const metadata: Metadata = { title: "Join game", robots: { index: false } };

/** No home link here: players shouldn't wander off mid-game by accident. */
export default function JoinLayout({ children }: { children: React.ReactNode }) {
  return <PlayerShell homeLink={false}>{children}</PlayerShell>;
}
