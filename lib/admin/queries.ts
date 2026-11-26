import "server-only";

import { bucketDaily, lastDays } from "@/lib/admin/series";
import { createAdminClient } from "@/lib/supabase/admin";

import { CLEANUP_BUCKET, isGameplayPhotoPath } from "@/lib/admin/image-cleanup";
import { limitsFromEnv, type Utilization } from "@/lib/admin/utilization";
import { imageDateRange, type GameListParams, type ImageListParams } from "@/lib/admin/validation";
import { createClient } from "@/lib/supabase/server";

/**
 * Admin reads run under the signed-in admin's own session (not the service
 * role): the SQL functions / RLS policies re-check super_admin themselves.
 * Callers must still `requireAdminPage()` first so unauthorized users are
 * redirected instead of seeing a database error.
 */
export async function getOverview() {
  const { data, error } = await (await createClient()).rpc("admin_overview");
  if (error || !data?.[0]) throw new Error("Could not load platform metrics");
  return data[0];
}

export async function listSubscribers(args: { q: string; state: string | null; page: number; pageSize: number }) {
  const { data, error } = await (await createClient()).rpc("admin_list_subscribers", {
    p_search: args.q || undefined,
    p_state: (args.state as never) ?? undefined,
    p_limit: args.pageSize,
    p_offset: (args.page - 1) * args.pageSize,
  });
  if (error) throw new Error("Could not load subscribers");
  return { rows: data ?? [], total: data?.[0]?.total_count ?? 0 };
}

export async function listPlans() {
  const { data, error } = await (await createClient())
    .from("subscription_plans")
    .select("*")
    .order("max_players_per_game", { ascending: true });
  if (error) throw new Error("Could not load plans");
  return data ?? [];
}

export async function getSettings() {
  const { data, error } = await (await createClient()).from("platform_settings").select("*").eq("id", true).maybeSingle();
  if (error || !data) throw new Error("Could not load settings");
  return data;
}

export async function getSubscriberDetail(userId: string, gamesPage: number, pageSize: number) {
  const supabase = await createClient();
  const [profile, access, subs, games, gameCount, purchases, audit, trial] = await Promise.all([
    supabase.from("profiles").select("id, email, display_name, role, deactivated_at, created_at").eq("id", userId).maybeSingle(),
    supabase.rpc("admin_subscriber_state", { p_user: userId }),
    // Game Pass ledger: every pass (incl. backfilled legacy subscriptions), newest first.
    supabase.rpc("admin_pass_timeline", { p_user: userId }),
    supabase
      .from("games")
      .select("id, title, status, join_code, max_players, created_at")
      .eq("owner_id", userId)
      .order("created_at", { ascending: false })
      .range((gamesPage - 1) * pageSize, gamesPage * pageSize - 1),
    supabase.from("games").select("id", { count: "exact", head: true }).eq("owner_id", userId),
    supabase.rpc("admin_purchase_history", { p_user: userId }),
    supabase.from("entitlement_events").select("id, at, action, actor_kind, details").eq("user_id", userId).order("at", { ascending: false }).limit(30),
    // trial_eligibility is service-only; the page is already verified as super admin (requireAdminPage).
    createAdminClient().rpc("trial_eligibility", { p_user: userId }),
  ]);
  if (profile.error || access.error || subs.error || games.error) throw new Error("Could not load subscriber");
  return {
    profile: profile.data,
    access: access.data?.[0] ?? null,
    passes: (subs.data ?? []).slice(0, 20),
    purchases: purchases.data ?? [],
    audit: audit.data ?? [],
    trial: trial.data?.[0] ?? null,
    games: games.data ?? [],
    gameTotal: gameCount.count ?? 0,
  };
}

/**
 * Daily activity for the overview charts (last `days` UTC days). Reads run under the admin's own session
 * (admin RLS policies on profiles / games / pass_orders). A failed read yields an empty series: the
 * headline numbers on the page still render.
 */
export async function getActivity(days = 30) {
  const supabase = await createClient();
  const since = `${lastDays(days)[0]}T00:00:00Z`;
  const [subs, games, orders] = await Promise.all([
    supabase.from("profiles").select("created_at").eq("role", "subscriber").gte("created_at", since).limit(5000),
    supabase.from("games").select("created_at, game_type").gte("created_at", since).limit(5000),
    // Payment evidence + environment are not granted to the authenticated role: read with the service role.
    // Safe because the caller has already passed requireAdminPage(); nothing here is returned raw.
    createAdminClient()
      .from("pass_orders")
      .select("paid_at, paid_currency, paid_amount_minor, refunded_amount_minor")
      .eq("polar_environment", "production").in("status", ["paid", "partially_refunded", "refunded"])
      .gte("paid_at", since).limit(5000),
  ]);
  const currencies = ["PHP", "USD"] as const;
  return {
    days,
    signups: bucketDaily((subs.data ?? []).map((r) => ({ at: r.created_at, key: "signups", value: 1 })), days, ["signups"]),
    games: bucketDaily((games.data ?? []).map((r) => ({ at: r.created_at, key: r.game_type, value: 1 })), days, ["bring_me", "bingosnap"]),
    revenue: bucketDaily(
      (orders.data ?? []).map((r) => ({ at: r.paid_at, key: r.paid_currency ?? "", value: (r.paid_amount_minor ?? 0) - (r.refunded_amount_minor ?? 0) })),
      days, currencies,
    ),
  };
}

/** Rooms in lobby / live with their host (admin session; the SQL function re-checks super_admin). */
export async function listActiveRooms() {
  const { data, error } = await (await createClient()).rpc("admin_list_active_rooms");
  if (error) throw new Error("Could not load active rooms");
  return data ?? [];
}

/** Capacity & health snapshot (admin session; the SQL function re-checks super_admin) + the plan limits in force. */
export async function getUtilization() {
  const { data, error } = await (await createClient()).rpc("admin_utilization");
  if (error || !data) throw new Error("Could not load capacity metrics");
  const u = data as unknown as Utilization;
  // bigint / numeric come back as numbers or strings depending on size: normalise once here.
  const num = (v: unknown) => Number(v ?? 0);
  return {
    utilization: {
      ...u,
      db_bytes: num(u.db_bytes), storage_bytes: num(u.storage_bytes), db_connections: num(u.db_connections),
      db_max_connections: num(u.db_max_connections), est_connections: num(u.est_connections),
      peak_7d_connections: num(u.peak_7d_connections), players_in_rooms: num(u.players_in_rooms),
    } satisfies Utilization,
    limits: limitsFromEnv(process.env),
  };
}

const countBy = (rows: { game_id: string }[]) =>
  rows.reduce<Record<string, number>>((m, r) => ((m[r.game_id] = (m[r.game_id] ?? 0) + 1), m), {});

/**
 * All games, newest first, with host and player count (admin RLS on games / profiles / players).
 * `q` matches title, join code, or the host's name / email. `q` is pre-sanitised by parseGameListParams.
 */
export async function listGames(args: GameListParams & { pageSize: number }) {
  const supabase = await createClient();
  let query = supabase
    .from("games")
    .select("id, title, join_code, status, phase, game_type, max_players, owner_id, created_at, started_at, finished_at", { count: "exact" })
    .order("created_at", { ascending: false })
    .range((args.page - 1) * args.pageSize, args.page * args.pageSize - 1);
  if (args.status) query = query.eq("status", args.status);
  if (args.type) query = query.eq("game_type", args.type);
  if (args.owner) query = query.eq("owner_id", args.owner);
  if (args.q) {
    const like = `%${args.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const hosts = await supabase.from("profiles").select("id").or(`email.ilike.${like},display_name.ilike.${like}`).limit(100);
    const ids = (hosts.data ?? []).map((h) => h.id);
    const code = args.q.replace(/\s/g, "").toUpperCase();
    query = query.or([`title.ilike.${like}`, /^[A-Z0-9]{6}$/.test(code) ? `join_code.eq.${code}` : null, ids.length ? `owner_id.in.(${ids.join(",")})` : null].filter(Boolean).join(","));
  }
  const { data, error, count } = await query;
  if (error) throw new Error("Could not load games");
  const games = data ?? [];
  const ownerIds = [...new Set(games.map((g) => g.owner_id))];
  const gameIds = games.map((g) => g.id);
  const [owners, players] = await Promise.all([
    ownerIds.length ? supabase.from("profiles").select("id, email, display_name").in("id", ownerIds) : Promise.resolve({ data: [] }),
    gameIds.length ? supabase.from("players").select("game_id").in("game_id", gameIds).is("kicked_at", null) : Promise.resolve({ data: [] }),
  ]);
  const ownerById = new Map((owners.data ?? []).map((o) => [o.id, o]));
  const playerCount = countBy(players.data ?? []);
  return {
    total: count ?? 0,
    rows: games.map((g) => ({ ...g, owner: ownerById.get(g.owner_id) ?? null, players: playerCount[g.id] ?? 0 })),
  };
}

/** One game with its host, players and rounds (Bring Me) or board + claims (BingoSnap). Null if it doesn't exist. */
export async function getGameDetail(id: string) {
  const supabase = await createClient();
  const { data: game, error } = await supabase.from("games").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error("Could not load game");
  if (!game) return null;
  const bingo = game.game_type === "bingosnap";
  const [owner, players, rounds, board, claims] = await Promise.all([
    supabase.from("profiles").select("id, email, display_name").eq("id", game.owner_id).maybeSingle(),
    supabase.from("players").select("id, nickname, joined_at, last_seen_at, kicked_at").eq("game_id", id).order("joined_at"),
    bingo ? Promise.resolve({ data: [] }) : supabase.from("game_rounds")
      .select("id, round_no, prompt, status, time_limit_seconds, opened_at, closed_at, winner_player_id, winner_rank_ms, winner_confirmed_at")
      .eq("game_id", id).order("round_no"),
    bingo ? supabase.from("bingo_games").select("board_size, win_mode, free_space, winner_rule, duration_seconds, hunt_started_at, hunt_ends_at").eq("game_id", id).maybeSingle() : Promise.resolve({ data: null }),
    bingo ? supabase.from("bingo_submissions").select("id, player_id, attempt_no, pattern, status, submitted_at").eq("game_id", id).order("submitted_at") : Promise.resolve({ data: [] }),
  ]);
  return {
    game, owner: owner.data ?? null, players: players.data ?? [],
    rounds: rounds.data ?? [], board: board.data ?? null, claims: claims.data ?? [],
  };
}

/**
 * Image Cleanup page: totals, one filtered page of classified images (with 5-minute thumbnail URLs signed
 * under the admin's own session: the Storage read policy allows super admins) and recent cleanup runs.
 * Classification is done by the database (image_cleanup_classify), never here.
 */
export async function getImageCleanup(args: ImageListParams & { pageSize: number }) {
  const supabase = await createClient();
  const { from, to } = imageDateRange(args);
  const [summary, page, history] = await Promise.all([
    supabase.rpc("admin_image_summary"),
    supabase.rpc("admin_list_images", {
      p_status: args.status ?? undefined, p_from: from, p_to: to, p_owner: args.owner || undefined,
      p_limit: args.pageSize, p_offset: (args.page - 1) * args.pageSize,
    }),
    supabase.rpc("admin_image_cleanup_history", { p_limit: 20 }),
  ]);
  if (summary.error || page.error || history.error) throw new Error("Could not load image storage");
  const rows = page.data ?? [];
  const paths = rows.filter((r) => isGameplayPhotoPath(r.object_name)).map((r) => r.object_name);
  const { data: signed } = paths.length
    ? await supabase.storage.from(CLEANUP_BUCKET).createSignedUrls(paths, 300)
    : { data: [] };
  const thumbs = new Map((signed ?? []).filter((s) => s.signedUrl && s.path).map((s) => [s.path as string, s.signedUrl]));
  return {
    summary: summary.data?.[0] ?? null,
    rows: rows.map((r) => ({ ...r, thumbUrl: thumbs.get(r.object_name) ?? null })),
    total: Number(rows[0]?.total_count ?? 0),
    history: history.data ?? [],
  };
}
