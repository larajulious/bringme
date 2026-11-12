import type { Metadata } from "next";

import { PlayerShell } from "@/components/layout/player-shell";
import { OG_IMAGES, SITE_NAME, TWITTER_IMAGES } from "@/lib/site/seo";

// Invite links get pasted into chats: give them a friendly preview, but keep rooms out of search.
export const metadata: Metadata = {
  title: "Join game",
  description: "You're invited to play BringMe! Tap to join on your phone: no app, no account needed.",
  robots: { index: false, follow: false },
  openGraph: { type: "website", siteName: SITE_NAME, title: "You're invited to play BringMe!", description: "Tap to join on your phone: no app, no account needed.", images: OG_IMAGES },
  twitter: { card: "summary_large_image", title: "You're invited to play BringMe!", description: "Tap to join on your phone: no app, no account needed.", images: TWITTER_IMAGES },
};

/** No home link here: players shouldn't wander off mid-game by accident. */
export default function JoinLayout({ children }: { children: React.ReactNode }) {
  return <PlayerShell homeLink={false}>{children}</PlayerShell>;
}
