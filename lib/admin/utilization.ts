/**
 * Capacity & health (/admin/health): turns the admin_utilization() snapshot into plain-language advice.
 * Pure (no imports) so it is unit-tested directly. The aim is protecting players mid-game: every rule names
 * what players would notice and the one thing to do about it.
 */

export type RoomUsage = {
  id: string; title: string; join_code: string | null; status: "lobby" | "live"; phase: string; game_type: string;
  players: number; max_players: number | null; tvs: number; idle_minutes: number;
};

/** Shape returned by public.admin_utilization() (migration 20261126000002). */
export type Utilization = {
  checked_at: string;
  open_rooms: number;
  live_rooms: number;
  players_in_rooms: number;
  est_connections: number;
  peak_7d_connections: number;
  peak_7d_at: string | null;
  photos_last_5m: number;
  peak_photos_per_minute_7d: number;
  db_bytes: number;
  storage_bytes: number;
  db_connections: number;
  db_max_connections: number;
  rooms: RoomUsage[];
};

export type Limits = { plan: string; realtimeConnections: number; dbBytes: number; storageBytes: number };

const MB = 1024 * 1024;

/** Supabase Free plan quotas as documented when this was written. Verify on your Supabase usage page. */
export const FREE_PLAN_LIMITS: Limits = { plan: "Supabase Free", realtimeConnections: 200, dbBytes: 500 * MB, storageBytes: 1024 * MB };

const positive = (v: string | undefined) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Plan limits, overridable per deployment after an upgrade (e.g. Pro: 500 connections, 8 GB database, 100 GB storage). */
export function limitsFromEnv(env: Record<string, string | undefined>): Limits {
  return {
    plan: env.SUPABASE_PLAN_NAME?.trim() || FREE_PLAN_LIMITS.plan,
    realtimeConnections: positive(env.SUPABASE_REALTIME_MAX_CONNECTIONS) ?? FREE_PLAN_LIMITS.realtimeConnections,
    dbBytes: (positive(env.SUPABASE_DB_LIMIT_MB) ?? FREE_PLAN_LIMITS.dbBytes / MB) * MB,
    storageBytes: (positive(env.SUPABASE_STORAGE_LIMIT_MB) ?? FREE_PLAN_LIMITS.storageBytes / MB) * MB,
  };
}

export type Severity = "info" | "watch" | "act" | "urgent";
export type Level = "ok" | Exclude<Severity, "info">;
export type Advice = { id: string; severity: Severity; title: string; detail: string; action: string; href?: string };

/** Rooms idle this long are probably abandoned tabs still holding live connections. */
export const IDLE_ROOM_MINUTES = 120;

const RANK: Record<Severity, number> = { info: 0, watch: 1, act: 2, urgent: 3 };
const pct = (used: number, limit: number) => (limit > 0 ? used / limit : 0);
const asPct = (r: number) => `${Math.round(r * 100)}%`;
const fmtMB = (b: number) => (b >= 1024 * MB ? `${(b / (1024 * MB)).toFixed(1)} GB` : `${Math.round(b / MB)} MB`);

/** Usage ratio → meter tone. Same thresholds the advice uses. */
export function usageTone(ratio: number): "ok" | "watch" | "act" | "urgent" {
  if (ratio >= 0.9) return "urgent";
  if (ratio >= 0.75) return "act";
  if (ratio >= 0.6) return "watch";
  return "ok";
}

export function assessUtilization(u: Utilization, limits: Limits): { level: Level; advice: Advice[] } {
  const advice: Advice[] = [];
  const rt = pct(u.est_connections, limits.realtimeConnections);
  const peak = pct(u.peak_7d_connections, limits.realtimeConnections);
  const db = pct(u.db_bytes, limits.dbBytes);
  const storage = pct(u.storage_bytes, limits.storageBytes);
  const conns = pct(u.db_connections, u.db_max_connections);

  if (rt >= 0.75) {
    advice.push({
      id: "realtime-now",
      severity: rt >= 0.9 ? "urgent" : "act",
      title: rt >= 1 ? "Live updates are over the limit right now" : "Live updates are close to the limit right now",
      detail: `About ${u.est_connections} of ${limits.realtimeConnections} live connections are in use (${asPct(rt)}). Past the limit, new players and screens drop to slower updates (every 4 seconds), so rounds feel laggy.`,
      action: `Close idle rooms, ask hosts to hold off on new rooms until current games finish, and upgrade your Supabase plan (Pro allows about 500 connections).`,
      href: "/admin/rooms",
    });
  }

  if (peak >= 0.6) {
    advice.push({
      id: "realtime-peak",
      severity: peak >= 0.8 ? "act" : "watch",
      title: "Your busiest moment this week came close to the limit",
      detail: `At peak, about ${u.peak_7d_connections} live connections were in use (${asPct(peak)} of ${limits.realtimeConnections}). A slightly bigger event would push players onto slower updates.`,
      action: "Upgrade your Supabase plan before your next big event, or spread large games across different times.",
    });
  }

  const biggest = u.rooms[0];
  if (biggest && pct(biggest.players + 2 + biggest.tvs, limits.realtimeConnections) >= 0.5) {
    advice.push({
      id: "big-room",
      severity: "watch",
      title: `One room uses half your live capacity`,
      detail: `"${biggest.title}" has ${biggest.players} players. If another large game starts at the same time, players in both may get slower updates.`,
      action: "Keep an eye on new rooms while this game runs.",
      href: `/admin/games/${biggest.id}`,
    });
  }

  if (storage >= 0.75) {
    advice.push({
      id: "storage",
      severity: storage >= 0.9 ? "urgent" : "act",
      title: "Photo storage is filling up",
      detail: `${fmtMB(u.storage_bytes)} of ${fmtMB(limits.storageBytes)} used (${asPct(storage)}). When it is full, photo uploads can fail and players can't submit.`,
      action: "Run Image Cleanup to delete old photos, or upgrade your storage.",
      href: "/admin/storage",
    });
  }

  if (db >= 0.75) {
    advice.push({
      id: "database",
      severity: db >= 0.9 ? "urgent" : "act",
      title: "The database is getting full",
      detail: `${fmtMB(u.db_bytes)} of ${fmtMB(limits.dbBytes)} used (${asPct(db)}). On the Free plan, a project over its database limit can be switched to read-only, which would stop games.`,
      action: "Upgrade your Supabase plan before it reaches the limit.",
    });
  }

  if (conns >= 0.75) {
    advice.push({
      id: "db-connections",
      severity: conns >= 0.9 ? "urgent" : "act",
      title: "Database connections are busy",
      detail: `${u.db_connections} of ${u.db_max_connections} database connections are open (${asPct(conns)}). Requests may queue, so joins and photo submissions slow down.`,
      action: "Check for stuck queries in the Supabase dashboard (Database → Query performance), or upgrade compute.",
    });
  }

  const idle = u.rooms.filter((r) => r.idle_minutes >= IDLE_ROOM_MINUTES);
  if (idle.length > 0) {
    advice.push({
      id: "idle-rooms",
      severity: "watch",
      title: `${idle.length} ${idle.length === 1 ? "room has" : "rooms have"} been idle for over ${IDLE_ROOM_MINUTES / 60} hours`,
      detail: "Forgotten rooms keep phones and screens connected and count against live capacity.",
      action: "Close them from Active rooms.",
      href: "/admin/rooms",
    });
  }

  if (u.live_rooms > 0) {
    advice.push({
      id: "in-game",
      severity: "info",
      title: `${u.live_rooms} ${u.live_rooms === 1 ? "game is" : "games are"} live right now`,
      detail: "Deploys and database changes can interrupt players mid-round.",
      action: "Hold deploys and migrations until these games finish.",
      href: "/admin/rooms",
    });
  }

  advice.sort((a, b) => RANK[b.severity] - RANK[a.severity]);
  const top = advice.find((a) => a.severity !== "info")?.severity;
  return { level: top && top !== "info" ? top : "ok", advice };
}

/** The project's Supabase dashboard, derived from the public project URL (https://<ref>.supabase.co). */
export function supabaseDashboardUrl(publicUrl: string | undefined): string | null {
  const m = publicUrl?.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/);
  return m ? `https://supabase.com/dashboard/project/${m[1]}` : null;
}
