import type { Metadata } from "next";
import { Camera, CreditCard, Gamepad2, HeartHandshake, RotateCcw, Scale, ShieldAlert, Sparkles, UserRound, Wrench } from "lucide-react";

import { LegalPage, type LegalSection } from "@/components/marketing/legal-page";

export const metadata: Metadata = {
  title: "Terms & Conditions",
  description: "The simple rules for hosting and playing BringMe!, including how 7-Day Game Passes work.",
};

const UPDATED = "11 November 2026";

const summary = [
  "Players join with a nickname — no account needed.",
  "Game Passes are one-time purchases for 7 days. Nothing renews automatically.",
  "Play fair, play safe, and only snap what you're allowed to.",
];

const sections: LegalSection[] = [
  {
    id: "agreement", icon: HeartHandshake, tone: "bg-brand-yellow text-brand-night", title: "Agreeing to these terms",
    body: <p>By hosting or playing BringMe! you agree to these terms. If you don&apos;t agree, please don&apos;t use the service. If you use BringMe! for your company or group, you confirm you&apos;re allowed to accept these terms for them.</p>,
  },
  {
    id: "accounts", icon: UserRound, tone: "bg-primary text-white", title: "Accounts and players",
    body: (
      <ul>
        <li><strong>Game Masters</strong> need an account to host. Keep your login private — you&apos;re responsible for what happens on your account.</li>
        <li><strong>Players</strong> join by scanning the host&apos;s QR code and choosing a nickname. Pick something friendly; hosts may remove players.</li>
        <li>You must be old enough to agree to these terms where you live, or have a parent or guardian&apos;s permission.</li>
      </ul>
    ),
  },
  {
    id: "passes", icon: CreditCard, tone: "bg-brand-coral text-white", title: "Game Passes and payments",
    body: (
      <ul>
        <li>New hosts get a <strong>free 7-day trial</strong> for games of up to 3 players.</li>
        <li>Paid <strong>7-Day Game Passes</strong> (Starter, Party and Pro) are <strong>one-time purchases</strong>. Each pass lasts 7 days once it becomes active and <strong>does not renew automatically</strong>.</li>
        <li>Each pass has a player limit per game, shown before you buy. Passes already bought keep the limit and price they were sold with.</li>
        <li>Prices are shown in PHP or USD as set for each currency. Payments are processed by our payment provider, <strong>Polar</strong>; applicable taxes may be added at checkout.</li>
        <li>A pass starts only after the payment is confirmed.</li>
      </ul>
    ),
  },
  {
    id: "refunds", icon: RotateCcw, tone: "bg-brand-night text-brand-yellow", title: "Refunds",
    body: <p>If something went wrong with a purchase, contact us and we&apos;ll look into it. Refunds are reviewed case by case and always where the law requires. A refunded pass ends when the refund is processed.</p>,
  },
  {
    id: "photos", icon: Camera, tone: "bg-brand-yellow text-brand-night", title: "Photos and content",
    body: (
      <ul>
        <li>Players take photos with their phone camera to submit items during a round.</li>
        <li>Only photograph things you&apos;re allowed to. <strong>Don&apos;t photograph people without their consent</strong>, private documents, or anything confidential at work.</li>
        <li>No offensive, harmful or illegal content. Hosts can disqualify photos.</li>
        <li>Photos are stored privately. The host can see submitted photos to judge them, and the winning photo is shown to everyone in that game.</li>
        <li>You keep ownership of your photos and let us store and show them as needed to run the game.</li>
      </ul>
    ),
  },
  {
    id: "hosts", icon: Gamepad2, tone: "bg-primary text-white", title: "Hosting responsibly",
    body: <p>Game Masters choose the items and run the game. Ask only for safe, reasonable items, follow your workplace or venue rules, and keep the game respectful for everyone in the room.</p>,
  },
  {
    id: "fair-play", icon: ShieldAlert, tone: "bg-brand-coral text-white", title: "Fair play and safe play",
    body: (
      <ul>
        <li>No cheating, abusing other players, or trying to break, overload or get around the service and its limits.</li>
        <li>Play safely — no running through hazards, climbing, or going where you shouldn&apos;t to win a round. Snappy wants you back for the next one.</li>
        <li>We may suspend or close accounts that break these rules.</li>
      </ul>
    ),
  },
  {
    id: "service", icon: Wrench, tone: "bg-brand-night text-brand-yellow", title: "The service",
    body: <p>We work hard to keep BringMe! running smoothly, but it&apos;s provided &quot;as is&quot; and may sometimes be unavailable. We may improve, change or retire features over time.</p>,
  },
  {
    id: "liability", icon: Scale, tone: "bg-brand-yellow text-brand-night", title: "Liability",
    body: <p>To the extent the law allows, we aren&apos;t liable for indirect losses, and our total liability for any claim is limited to the amount you paid for the Game Pass involved. Nothing here removes rights you have under consumer law.</p>,
  },
  {
    id: "changes", icon: Sparkles, tone: "bg-primary text-white", title: "Changes to these terms",
    body: <p>We may update these terms from time to time. We&apos;ll change the date at the top, and important changes will be shown in the app. Continuing to use BringMe! means you accept the updated terms.</p>,
  },
];

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms & Conditions" updated={UPDATED} mood="judging" summary={summary} sections={sections}
      intro="The simple rules of the game for hosts and players. Short, plain and friendly — like a good round of BringMe!"
      question="Questions about these terms?"
    />
  );
}
