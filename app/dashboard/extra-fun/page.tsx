import type { Metadata } from "next";
import Link from "next/link";
import { Camera, Grid3x3, Plus, ShieldCheck, Users } from "lucide-react";

import { BingoMark } from "@/components/bingosnap/bingo-mark";
import { GameList } from "@/components/game/game-list";
import { PageHeading } from "@/components/layout/dashboard-shell";
import { SubscriptionRestricted } from "@/components/subscription/restricted";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { getMyAccessStatus, getMyEntitlement, getMyGamePass, requireSubscriberPage } from "@/lib/auth/session";
import { getSupportEmail } from "@/lib/platform/settings";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Extra Fun" };

export default async function ExtraFunPage() {
  const { userId } = await requireSubscriberPage();
  const supabase = await createClient();
  // RLS limits this to the signed-in host's own games.
  const [entitlement, games] = await Promise.all([
    getMyEntitlement(),
    supabase.from("games").select("id, title, status, join_code, created_at, game_type")
      .eq("owner_id", userId).eq("game_type", "bingosnap").order("created_at", { ascending: false }).limit(50),
  ]);
  if (games.error) throw new Error("Could not load games");
  const list = games.data ?? [];
  const open = list.filter((g) => g.status === "draft" || g.status === "lobby" || g.status === "live");
  const past = list.filter((g) => g.status === "finished" || g.status === "canceled");

  let restricted: React.ReactNode = null;
  if (!entitlement) {
    const [access, pass] = await Promise.all([getMyAccessStatus(), getMyGamePass()]);
    restricted = (
      <SubscriptionRestricted state={access.state === "active" ? "pending" : access.state} supportEmail={await getSupportEmail()} trialEnded={pass?.trialEndedNoPass ?? false} />
    );
  }

  return (
    <>
      <PageHeading title="Extra Fun" description="More ways to play with the same Game Pass. No extra purchase needed." />

      <section aria-labelledby="bingosnap-h" className="mb-10 overflow-hidden rounded-4xl border bg-card shadow-card">
        <div className="grid gap-6 p-6 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center sm:gap-8 sm:p-8">
          <BingoMark className="w-28 justify-self-center sm:w-36" />
          <div className="min-w-0">
            <p className="mb-1 text-xs font-bold uppercase tracking-wide text-brand-coral">Photo Bingo</p>
            <h2 id="bingosnap-h" className="font-display text-3xl font-bold text-primary">BingoSnap</h2>
            <p className="mt-1 text-lg text-muted-foreground">Turn everyday objects into a photo Bingo challenge.</p>
            <ul className="mt-4 flex flex-wrap gap-2 text-sm">
              <li className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-3 py-1 font-semibold text-primary"><Grid3x3 aria-hidden="true" className="size-4" /> 3×3 to 5×5 boards</li>
              <li className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-3 py-1 font-semibold text-primary"><Camera aria-hidden="true" className="size-4" /> Photos stay on players&apos; phones</li>
              <li className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-3 py-1 font-semibold text-primary"><ShieldCheck aria-hidden="true" className="size-4" /> You verify every Bingo</li>
              {entitlement ? (
                <li className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-3 py-1 font-semibold text-primary"><Users aria-hidden="true" className="size-4" /> Up to {entitlement.max_players_per_game} players</li>
              ) : null}
            </ul>
            {entitlement ? (
              <Button asChild size="lg" className="mt-6 w-full sm:w-auto">
                <Link href="/dashboard/extra-fun/bingosnap/new"><Plus aria-hidden="true" /> Create game</Link>
              </Button>
            ) : null}
          </div>
        </div>
      </section>

      {restricted ? <div className="mb-10">{restricted}</div> : null}

      <section aria-labelledby="bs-open-h" className="mb-10">
        <h2 id="bs-open-h" className="mb-4 text-xl font-bold text-primary">Open BingoSnap games</h2>
        {open.length ? (
          <GameList games={open} label="Open BingoSnap games" />
        ) : (
          <EmptyState
            icon={<Grid3x3 />}
            title="No BingoSnap games open"
            description={entitlement ? "Build a board of photo challenges and it'll show up here." : "Games you create will show up here."}
            action={entitlement ? <Button asChild><Link href="/dashboard/extra-fun/bingosnap/new">Create game</Link></Button> : undefined}
          />
        )}
      </section>

      {past.length ? (
        <section aria-labelledby="bs-past-h">
          <h2 id="bs-past-h" className="mb-4 text-xl font-bold text-primary">Past BingoSnap games</h2>
          <GameList games={past.slice(0, 20)} label="Past BingoSnap games" />
        </section>
      ) : null}
    </>
  );
}
