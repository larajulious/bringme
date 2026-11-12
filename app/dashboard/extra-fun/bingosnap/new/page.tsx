import type { Metadata } from "next";

import { BoardEditor } from "@/components/bingosnap/board-editor";
import { GameLimitNotice } from "@/components/game/game-limit-notice";
import { BackBar, PageHeading } from "@/components/layout/dashboard-shell";
import { SubscriptionRestricted } from "@/components/subscription/restricted";
import { getMyAccessStatus, getMyEntitlement, getMyGamePass, requireSubscriberPage } from "@/lib/auth/session";
import { getSupportEmail } from "@/lib/platform/settings";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "New BingoSnap game" };

const back = <BackBar href="/dashboard/extra-fun" label="Extra Fun" />;

export default async function NewBingoSnapPage() {
  const { userId } = await requireSubscriberPage();
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

  const { count } = await (await createClient()).from("games").select("id", { count: "exact", head: true }).eq("owner_id", userId).in("status", ["draft", "lobby", "live"]);
  const open = count ?? 0;
  const atLimit = open >= entitlement.max_active_games;

  return (
    <>
      {back}
      <PageHeading title="New BingoSnap game" description="Tap a square to write what players must photograph. Save a draft any time; publish when every square is ready." />
      {atLimit ? <GameLimitNotice active={open} max={entitlement.max_active_games} /> : <BoardEditor maxPlayers={entitlement.max_players_per_game} />}
    </>
  );
}
