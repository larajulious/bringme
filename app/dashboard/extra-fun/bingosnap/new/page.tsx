import type { Metadata } from "next";
import Link from "next/link";

import { BoardEditor } from "@/components/bingosnap/board-editor";
import { PageHeading } from "@/components/layout/dashboard-shell";
import { SubscriptionRestricted } from "@/components/subscription/restricted";
import { getMyAccessStatus, getMyEntitlement, getMyGamePass, requireSubscriberPage } from "@/lib/auth/session";
import { getSupportEmail } from "@/lib/platform/settings";

export const metadata: Metadata = { title: "New BingoSnap game" };

const back = (
  <p className="mb-3 text-sm">
    <Link href="/dashboard/extra-fun" className="font-semibold text-primary underline-offset-4 hover:underline">← Extra Fun</Link>
  </p>
);

export default async function NewBingoSnapPage() {
  await requireSubscriberPage();
  // The same Game Pass entitlement as Bring Me (database clock); the player cap comes from it.
  const entitlement = await getMyEntitlement();

  if (!entitlement) {
    const [access, pass] = await Promise.all([getMyAccessStatus(), getMyGamePass()]);
    return (
      <>
        {back}
        <PageHeading title="New BingoSnap game" />
        <SubscriptionRestricted state={access.state === "active" ? "pending" : access.state} supportEmail={await getSupportEmail()} trialEnded={pass?.trialEndedNoPass ?? false} />
      </>
    );
  }

  return (
    <>
      {back}
      <PageHeading title="New BingoSnap game" description="Tap a square to write what players must photograph. Save a draft any time; publish when every square is ready." />
      <BoardEditor maxPlayers={entitlement.max_players_per_game} />
    </>
  );
}
