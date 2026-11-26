import type { Metadata } from "next";

import { GuidesHub } from "@/components/marketing/guide-page";
import { pageMeta } from "@/lib/site/seo";

export const metadata: Metadata = pageMeta({
  title: "Party Game Ideas for Work, Teams & Holidays",
  description:
    "Free party game guides: Bring Me game ideas, photo scavenger hunts, photo bingo, Christmas office party games and icebreakers for large groups.",
  path: "/party-games",
});

export default function Page() {
  return <GuidesHub />;
}
