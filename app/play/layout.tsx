import type { Metadata } from "next";

import { pageMeta } from "@/lib/site/seo";

import { PlayerShell } from "@/components/layout/player-shell";

export const metadata: Metadata = pageMeta({
  title: "Join a game",
  description: "Got a room code? Enter it to join a BringMe! game on your phone. No app or account needed.",
  path: "/play",
});

export default function PlayLayout({ children }: { children: React.ReactNode }) {
  return <PlayerShell>{children}</PlayerShell>;
}
