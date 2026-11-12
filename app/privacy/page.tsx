import type { Metadata } from "next";
import { Camera, Clock, Cookie, CreditCard, Database, Eye, Lock, Server, Sparkles, UserCheck, Users, Wrench } from "lucide-react";

import { LegalPage, type LegalSection } from "@/components/marketing/legal-page";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "What BringMe! collects when you host or play, how it's used, and the choices you have.",
};

const UPDATED = "12 November 2026";

const summary = [
  "Players only give us a nickname and the photos they choose to snap.",
  "We never see or store your card details — payments go through Polar.",
  "No ads, no selling your data, and no tracking or advertising cookies.",
];

/**
 * Keep this in sync with what the app really does (checked against the schema and API routes):
 * profiles(email, display_name), players(nickname, session token hash, joined/last seen), submissions
 * (photo + timing + technical timing meta), pass_orders/payment_events (Polar ids, amounts, event payloads),
 * Polar checkout receives account email, internal user id and IP. Cookies: Supabase auth, bm_player (12 h).
 * localStorage: homepage personal boop count + sound preference. Global boop counter: one number, nothing per
 * visitor (spam limits are in-memory only). No analytics. Photo auto-deletion is NOT implemented yet.
 */
const sections: LegalSection[] = [
  {
    id: "scope", icon: Users, tone: "bg-brand-yellow text-brand-night", title: "Who this covers",
    body: <p>This policy explains how BringMe! handles information about <strong>Game Masters</strong> (hosts with an account), <strong>players</strong> (who join with a QR code) and anyone visiting our website.</p>,
  },
  {
    id: "collect", icon: Database, tone: "bg-primary text-white", title: "What we collect",
    body: (
      <>
        <p><strong>Game Masters</strong></p>
        <ul>
          <li>Your email address, a display name if you add one, and your password (stored securely by our login provider — we never see it).</li>
          <li>The games you create: titles, items to bring, rounds and results.</li>
          <li>Your Game Passes and order history.</li>
        </ul>
        <p><strong>Players</strong></p>
        <ul>
          <li>The nickname you choose, and when you joined and were last active in the game.</li>
          <li>The photos you submit and how fast you submitted them.</li>
          <li>Technical timing details (like connection speed and upload attempts) so rounds are judged fairly.</li>
        </ul>
        <p>Players don&apos;t create an account and we don&apos;t ask for their email or phone number.</p>
      </>
    ),
  },
  {
    id: "camera", icon: Camera, tone: "bg-brand-coral text-white", title: "Your camera",
    body: (
      <ul>
        <li>BringMe! asks for camera permission only so you can snap items during a round. We never use your microphone.</li>
        <li>A photo is taken only when you tap the shutter, and only that photo is uploaded.</li>
        <li>You can turn off camera access at any time in your browser settings.</li>
      </ul>
    ),
  },
  {
    id: "payments", icon: CreditCard, tone: "bg-brand-night text-brand-yellow", title: "Payments",
    body: (
      <ul>
        <li>Game Passes are paid through <strong>Polar</strong>, our payment provider. Your card or payment details go directly to Polar — <strong>we never receive or store them</strong>.</li>
        <li>To start a checkout we share your account email, an internal account ID, and your IP address (which helps with currency and tax).</li>
        <li>Polar sends us the order details we need to activate your pass, such as the amount, currency, payment status and order references.</li>
        <li>Polar handles your payment information under its own privacy policy.</li>
      </ul>
    ),
  },
  {
    id: "use", icon: Sparkles, tone: "bg-brand-yellow text-brand-night", title: "How we use it",
    body: (
      <ul>
        <li>To run games: lobbies, rounds, timing, judging and announcing winners.</li>
        <li>To activate Game Passes and enforce their player limits.</li>
        <li>To keep BringMe! secure and fair, prevent abuse and fix problems.</li>
        <li>To reply when you contact us.</li>
      </ul>
    ),
  },
  {
    id: "sharing", icon: Eye, tone: "bg-primary text-white", title: "Who can see what",
    body: (
      <ul>
        <li>Everyone in a game can see the players&apos; nicknames.</li>
        <li>The <strong>host</strong> can see every photo submitted in their game, to judge it.</li>
        <li>The <strong>winning photo</strong> is shown to everyone in that game when the winner is announced. Other players never see your photo otherwise.</li>
        <li>We <strong>don&apos;t sell</strong> your information and don&apos;t use it for advertising.</li>
      </ul>
    ),
  },
  {
    id: "providers", icon: Server, tone: "bg-brand-coral text-white", title: "Service providers",
    body: <p>We use trusted providers to run BringMe!: <strong>Supabase</strong> (database, login and private photo storage), <strong>Polar</strong> (payments) and our website hosting provider. They process information only to provide their service to us. We may also share information if the law requires it.</p>,
  },
  {
    id: "cookies", icon: Cookie, tone: "bg-brand-night text-brand-yellow", title: "Cookies and local storage",
    body: (
      <ul>
        <li><strong>Login cookies</strong> keep Game Masters signed in.</li>
        <li>A <strong>player cookie</strong> keeps you in your game if you refresh or lose connection. It expires after 12 hours.</li>
        <li>Our homepage remembers your own Snappy boop count and sound setting in your browser only.</li>
        <li>We don&apos;t use advertising or third-party tracking cookies.</li>
      </ul>
    ),
  },
  {
    id: "retention", icon: Clock, tone: "bg-brand-yellow text-brand-night", title: "How long we keep it",
    body: (
      <ul>
        <li>Account information is kept while your account is open.</li>
        <li>Games, results and photos are kept with the host&apos;s game history until the host&apos;s account is closed or you ask us to delete them.</li>
        <li>Payment and order records are kept as long as needed for accounting, tax and legal requirements.</li>
        <li>Homepage boops are simply added to one anonymous total. We don&apos;t record who tapped or when.</li>
      </ul>
    ),
  },
  {
    id: "security", icon: Lock, tone: "bg-primary text-white", title: "Keeping it safe",
    body: <p>Photos are kept in private storage and opened only through short-lived links for the people allowed to see them. Access to data is checked on our servers, and connections are encrypted. No system is perfect, but we work hard to protect your information.</p>,
  },
  {
    id: "rights", icon: UserCheck, tone: "bg-brand-coral text-white", title: "Your choices and rights",
    body: <p>You can ask us to show you, correct, or delete the information we hold about you. Players can ask for their photos to be removed from a game. Depending on where you live, you may have extra rights under your local privacy law, including the right to complain to your data protection authority.</p>,
  },
  {
    id: "changes", icon: Wrench, tone: "bg-brand-night text-brand-yellow", title: "Children and changes",
    body: <p>BringMe! isn&apos;t meant for young children to use on their own; kids should play with a parent, guardian or teacher hosting. We may update this policy as BringMe! grows — we&apos;ll change the date at the top, and show important changes in the app.</p>,
  },
];

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy" updated={UPDATED} mood="waiting" summary={summary} sections={sections}
      intro="What we collect when you host or play, why we need it, and what you can do about it. No fine print games."
      question="Questions about your privacy?"
    />
  );
}
