import type { Metadata } from "next";
import Link from "next/link";

import { GameBuilder } from "@/components/game/game-builder";
import { PageHeading } from "@/components/layout/dashboard-shell";
import { SubscriptionRestricted } from "@/components/subscription/restricted";
import { getMyAccessStatus, getMyEntitlement, getMyGamePass, requireSubscriberPage } from "@/lib/auth/session";
import { getSupportEmail } from "@/lib/platform/settings";

export const metadata: Metadata = { title: "Create game" };

export default async function NewGamePage() {
  await requireSubscriberPage();
  const entitlement = await getMyEntitlement();

  if (!entitlement) {
    const [access, pass] = await Promise.all([getMyAccessStatus(), getMyGamePass()]);
    return (
      <>
        <PageHeading title="Create a game" />
        <SubscriptionRestricted state={access.state === "active" ? "pending" : access.state} supportEmail={await getSupportEmail()} trialEnded={pass?.trialEndedNoPass ?? false} />
      </>
    );
  }

  return (
    <>
      <p className="mb-3 text-sm">
        <Link href="/dashboard" className="font-semibold text-primary underline-offset-4 hover:underline">← Dashboard</Link>
      </p>
      <PageHeading title="Create a game" description="Pick your rounds, then open the lobby for your players." />
      <div className="max-w-3xl">
        <GameBuilder maxRounds={entitlement.max_rounds_per_game} />
      </div>
    </>
  );
}
