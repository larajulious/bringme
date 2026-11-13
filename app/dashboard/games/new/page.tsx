import type { Metadata } from "next";

import { GameBuilder } from "@/components/game/game-builder";
import { GameLimitNotice } from "@/components/game/game-limit-notice";
import { PageHeading } from "@/components/layout/dashboard-shell";
import { SubscriptionRestricted } from "@/components/subscription/restricted";
import { getMyAccessStatus, getMyEntitlement, getMyGamePass, requireSubscriberPage } from "@/lib/auth/session";
import { getSupportEmail } from "@/lib/platform/settings";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Create game" };

export default async function NewGamePage() {
  const { userId } = await requireSubscriberPage();
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

  const { data: openGames, count } = await (await createClient()).from("games").select("id, title, status, game_type", { count: "exact" }).eq("owner_id", userId).in("status", ["draft", "lobby", "live"]);
  const open = count ?? openGames?.length ?? 0;
  const atLimit = open >= entitlement.max_active_games;

  return (
    <>
      <PageHeading title="Create a game" description="Pick your rounds, then open the lobby for your players." />
      <div className="max-w-3xl">
        {atLimit ? <GameLimitNotice active={open} max={entitlement.max_active_games} games={openGames ?? []} /> : <GameBuilder maxRounds={entitlement.max_rounds_per_game} />}
      </div>
    </>
  );
}
