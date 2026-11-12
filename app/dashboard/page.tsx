import Link from "next/link";
import { CheckCircle2, ChevronRight, DoorOpen, Gamepad2, History, Plus, Sparkles, Ticket } from "lucide-react";

import { Mascot } from "@/components/brand/mascot";
import { GameLimitNotice } from "@/components/game/game-limit-notice";
import { GameList } from "@/components/game/game-list";
import { MetricCard } from "@/components/admin/metric-card";
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

  const createButton = canHost ? (
    atLimit ? (
      <Button size="lg" disabled aria-describedby="game-limit-h" className="w-full sm:w-auto"><Plus aria-hidden="true" /> Create game</Button>
    ) : (
      <Button asChild size="lg" className="w-full sm:w-auto">
        <Link href="/dashboard/games/new"><Plus aria-hidden="true" /> Create game</Link>
      </Button>
    )
  ) : null;
  const restricted = !canHost && !passStatusCovers(pass);

  return (
    <div className="grid gap-8">
      {/* Welcome banner: who you are + the one thing to do next. */}
      <section aria-labelledby="welcome-h" className="relative overflow-hidden rounded-4xl bg-gradient-to-br from-primary to-brand-night p-6 text-white shadow-card sm:p-8">
        <div className="relative z-10 max-w-3xl sm:pr-40 lg:pr-52">
          <p className="text-xs font-bold uppercase tracking-widest text-brand-yellow">Game Master</p>
          <h1 id="welcome-h" className="mt-1 break-words font-display text-3xl font-bold sm:text-4xl">
            Welcome{profile.display_name ? `, ${profile.display_name}` : ""}!
          </h1>
          <p className="mt-2 text-base text-white/85 sm:text-lg">Ready to throw a party? Create a game and let your friends scan in.</p>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            {createButton}
            <Button asChild size="lg" variant="outline-light" className="w-full sm:w-auto">
              <Link href="/dashboard/extra-fun"><Sparkles aria-hidden="true" /> Try BingoSnap</Link>
            </Button>
          </div>
        </div>
        <Mascot mood="cheer" className="pointer-events-none absolute -bottom-4 right-6 hidden w-36 sm:block lg:right-12 lg:w-44" />
      </section>

      {atLimit && entitlement ? <GameLimitNotice active={openGames} max={entitlement.max_active_games} /> : null}
      {restricted ? (
        <SubscriptionRestricted state={access.state as Exclude<typeof access.state, "active">} supportEmail={await getSupportEmail()} trialEnded={pass?.trialEndedNoPass ?? false} />
      ) : null}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        {/* Games are the main job, so they come first on phones; the pass and numbers sit beside them on lg. */}
        <div className="grid min-w-0 gap-10">
      <section aria-labelledby="active-h">
        <SectionTitle id="active-h" title="Active games" count={active.length} />
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
        <SectionTitle id="history-h" title="Game history" count={history.length} />
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
        </div>

        {/* Pass + numbers: above the games on phones (what can I host?), a sticky side column on lg. */}
        <aside aria-label="Your Game Pass and stats" className="order-first grid gap-4 lg:sticky lg:top-6 lg:order-none">
          {passStatusCovers(pass) ? <PassStatus summary={pass} /> : null}
          <div className="grid grid-cols-3 gap-2 sm:gap-4 lg:grid-cols-1 lg:gap-3">
            <MetricCard label="Games created" value={total.count ?? 0} icon={<Gamepad2 />} />
            <MetricCard label="Open now" value={openGames} accent="coral" icon={<DoorOpen />} hint={entitlement ? `Of ${entitlement.max_active_games} allowed` : "Drafts, lobby or live"} />
            <MetricCard label="Completed" value={completed.count ?? 0} accent="success" icon={<CheckCircle2 />} />
          </div>
          <Link href="/dashboard/subscription" className="flex items-center justify-between gap-3 rounded-3xl border bg-card px-5 py-4 font-display font-semibold text-primary shadow-card transition-transform motion-safe:hover:-translate-y-0.5">
            <span className="flex items-center gap-2"><Ticket aria-hidden="true" className="size-5 text-brand-coral" /> Game Pass &amp; purchases</span>
            <ChevronRight aria-hidden="true" className="size-5" />
          </Link>
        </aside>
      </div>
    </div>
  );
}

function SectionTitle({ id, title, count }: { id: string; title: string; count: number }) {
  return (
    <div className="mb-4 flex items-center gap-2">
      <h2 id={id} className="text-xl font-bold text-primary sm:text-2xl">{title}</h2>
      {count > 0 ? <span className="rounded-full bg-secondary px-2.5 py-0.5 text-sm font-bold text-secondary-foreground">{count}</span> : null}
    </div>
  );
}
