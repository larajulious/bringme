import Link from "next/link";
import { CheckCircle2, DoorOpen, Gamepad2, History, Plus } from "lucide-react";

import { GameLimitNotice } from "@/components/game/game-limit-notice";
import { GameList } from "@/components/game/game-list";
import { MetricCard } from "@/components/admin/metric-card";
import { PageHeading } from "@/components/layout/dashboard-shell";
import { PassStatus, passStatusCovers } from "@/components/subscription/pass-status";
import { SubscriptionRestricted } from "@/components/subscription/restricted";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { getMyAccessStatus, getMyEntitlement, getMyGamePass, requireSubscriberPage } from "@/lib/auth/session";
import { getSupportEmail } from "@/lib/platform/settings";
import { createClient } from "@/lib/supabase/server";

export default async function DashboardPage() {
  const { profile, userId } = await requireSubscriberPage();
  const [access, pass, entitlement] = await Promise.all([getMyAccessStatus(), getMyGamePass(), getMyEntitlement()]);
  const supabase = await createClient();

  // RLS limits every query to the signed-in host's own games.
  const [recent, total, completed, openCount] = await Promise.all([
    supabase.from("games").select("id, title, status, join_code, created_at, archived_at, game_type").eq("owner_id", userId).order("created_at", { ascending: false }).limit(50),
    supabase.from("games").select("id", { count: "exact", head: true }).eq("owner_id", userId),
    supabase.from("games").select("id", { count: "exact", head: true }).eq("owner_id", userId).eq("status", "finished"),
    supabase.from("games").select("id", { count: "exact", head: true }).eq("owner_id", userId).in("status", ["draft", "lobby", "live"]),
  ]);
  if (recent.error) throw new Error("Could not load games");

  const games = recent.data ?? [];
  const active = games.filter((g) => g.status === "draft" || g.status === "lobby" || g.status === "live");
  const closed = games.filter((g) => g.status === "finished" || g.status === "canceled");
  const history = closed.filter((g) => !g.archived_at);
  const archived = closed.filter((g) => g.archived_at);
  const canHost = access.state === "active";
  const openGames = openCount.count ?? active.length;
  const atLimit = canHost && !!entitlement && openGames >= entitlement.max_active_games;

  return (
    <>
      <PageHeading
        title={`Welcome${profile.display_name ? `, ${profile.display_name}` : ""}!`}
        description="Ready to throw a party? Create a game and let your friends scan in."
      />

      <div className="mb-8 flex flex-wrap items-center gap-4">
        {canHost ? (
          atLimit ? (
            <Button size="lg" disabled aria-describedby="game-limit-h"><Plus aria-hidden="true" /> Create game</Button>
          ) : (
            <Button asChild size="lg">
              <Link href="/dashboard/games/new"><Plus aria-hidden="true" /> Create game</Link>
            </Button>
          )
        ) : null}
        <Button asChild variant="ghost" size="sm"><Link href="/dashboard/subscription">Game Pass details</Link></Button>
      </div>

      {atLimit && entitlement ? <div className="mb-8"><GameLimitNotice active={openGames} max={entitlement.max_active_games} /></div> : null}

      {passStatusCovers(pass) ? <div className="mb-8"><PassStatus summary={pass} /></div> : null}

      {!canHost && !passStatusCovers(pass) ? (
        <SubscriptionRestricted state={access.state as Exclude<typeof access.state, "active">} supportEmail={await getSupportEmail()} trialEnded={pass?.trialEndedNoPass ?? false} />
      ) : null}

      <div className="mb-8 grid grid-cols-3 gap-2 sm:mb-10 sm:gap-4">
        <MetricCard label="Games created" value={total.count ?? 0} icon={<Gamepad2 />} />
        <MetricCard label="Open now" value={openGames} accent="coral" icon={<DoorOpen />} hint={entitlement ? `Of ${entitlement.max_active_games} allowed` : "Drafts, lobby or live"} />
        <MetricCard label="Completed" value={completed.count ?? 0} accent="success" icon={<CheckCircle2 />} />
      </div>

      <section aria-labelledby="active-h" className="mb-10">
        <h2 id="active-h" className="mb-4 text-xl font-bold text-primary">Active games</h2>
        {active.length === 0 ? (
          <EmptyState
            icon={<DoorOpen />}
            title="No games open right now"
            description={canHost ? "Create a game to open a lobby and get a QR code for your players." : "Games you open will show up here."}
            action={canHost && !atLimit ? <Button asChild><Link href="/dashboard/games/new">Create game</Link></Button> : undefined}
          />
        ) : (
          <GameList games={active} label="Active games" />
        )}
      </section>

      <section aria-labelledby="history-h">
        <h2 id="history-h" className="mb-4 text-xl font-bold text-primary">Game history</h2>
        {history.length === 0 ? (
          <EmptyState icon={<History />} title="No past games yet" description="Finished and cancelled games will be listed here." />
        ) : (
          <GameList games={history} label="Game history" />
        )}
        {archived.length ? (
          <details className="mt-6 rounded-3xl border bg-card p-4">
            <summary className="cursor-pointer font-display text-lg font-semibold text-primary">Archived games ({archived.length})</summary>
            <div className="mt-3"><GameList games={archived} label="Archived games" /></div>
          </details>
        ) : null}
      </section>
    </>
  );
}
