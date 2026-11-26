import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  FREE_PLAN_LIMITS, assessUtilization, limitsFromEnv, supabaseDashboardUrl, usageTone, type RoomUsage, type Utilization,
} from "../lib/admin/utilization.ts";

const MB = 1024 * 1024;
const room = (o: Partial<RoomUsage> = {}): RoomUsage => ({
  id: crypto.randomUUID(), title: "Room", join_code: "ABC123", status: "live", phase: "active", game_type: "bring_me",
  players: 10, max_players: 50, tvs: 0, idle_minutes: 1, ...o,
});
const base = (o: Partial<Utilization> = {}): Utilization => ({
  checked_at: new Date().toISOString(), open_rooms: 0, live_rooms: 0, players_in_rooms: 0, est_connections: 0,
  peak_7d_connections: 0, peak_7d_at: null, photos_last_5m: 0, peak_photos_per_minute_7d: 0,
  db_bytes: 20 * MB, storage_bytes: 10 * MB, db_connections: 20, db_max_connections: 60, rooms: [], ...o,
});
const ids = (u: Utilization) => assessUtilization(u, FREE_PLAN_LIMITS).advice.map((a) => a.id);

describe("assessUtilization", () => {
  it("is ok with no advice when everything has headroom and nothing is live", () => {
    assert.deepEqual(assessUtilization(base(), FREE_PLAN_LIMITS), { level: "ok", advice: [] });
  });

  it("a live game alone is info only (hold deploys) and keeps the level ok", () => {
    const r = assessUtilization(base({ live_rooms: 1, open_rooms: 1, rooms: [room()] }), FREE_PLAN_LIMITS);
    assert.equal(r.level, "ok");
    assert.deepEqual(r.advice.map((a) => [a.id, a.severity]), [["in-game", "info"]]);
  });

  it("live connections: act from 75%, urgent from 90%", () => {
    assert.ok(!ids(base({ est_connections: 149 })).includes("realtime-now"));
    const act = assessUtilization(base({ est_connections: 150 }), FREE_PLAN_LIMITS);
    assert.equal(act.level, "act");
    const urgent = assessUtilization(base({ est_connections: 185 }), FREE_PLAN_LIMITS);
    assert.equal(urgent.level, "urgent");
    assert.match(urgent.advice[0].title, /close to the limit/);
    assert.match(assessUtilization(base({ est_connections: 230 }), FREE_PLAN_LIMITS).advice[0].title, /over the limit/);
  });

  it("weekly peak warns before the next event", () => {
    assert.equal(assessUtilization(base({ peak_7d_connections: 120 }), FREE_PLAN_LIMITS).advice[0].severity, "watch");
    assert.equal(assessUtilization(base({ peak_7d_connections: 170 }), FREE_PLAN_LIMITS).advice[0].severity, "act");
  });

  it("storage, database and connections each map to their own advice and link", () => {
    const r = assessUtilization(base({ storage_bytes: 950 * MB, db_bytes: 400 * MB, db_connections: 50 }), FREE_PLAN_LIMITS);
    assert.equal(r.level, "urgent");
    const byId = Object.fromEntries(r.advice.map((a) => [a.id, a]));
    assert.equal(byId.storage.severity, "urgent");
    assert.equal(byId.storage.href, "/admin/storage");
    assert.equal(byId.database.severity, "act");
    assert.equal(byId["db-connections"].severity, "act");
  });

  it("flags idle rooms and a single room taking half the capacity", () => {
    const rooms = [room({ players: 99, title: "Town hall" }), room({ idle_minutes: 200 })];
    const r = assessUtilization(base({ rooms, open_rooms: 2, live_rooms: 2 }), FREE_PLAN_LIMITS);
    assert.deepEqual(r.advice.map((a) => a.id).sort(), ["big-room", "idle-rooms", "in-game"]);
    assert.equal(r.level, "watch");
    assert.match(r.advice.find((a) => a.id === "idle-rooms")!.title, /^1 room has/);
  });

  it("sorts the most severe advice first", () => {
    const r = assessUtilization(base({ est_connections: 190, peak_7d_connections: 130, live_rooms: 3 }), FREE_PLAN_LIMITS);
    assert.deepEqual(r.advice.map((a) => a.severity), ["urgent", "watch", "info"]);
  });
});

describe("limits and helpers", () => {
  it("defaults to the Free plan and accepts overrides after an upgrade", () => {
    assert.deepEqual(limitsFromEnv({}), FREE_PLAN_LIMITS);
    const pro = limitsFromEnv({ SUPABASE_PLAN_NAME: "Supabase Pro", SUPABASE_REALTIME_MAX_CONNECTIONS: "500", SUPABASE_DB_LIMIT_MB: "8192", SUPABASE_STORAGE_LIMIT_MB: "102400" });
    assert.deepEqual(pro, { plan: "Supabase Pro", realtimeConnections: 500, dbBytes: 8192 * MB, storageBytes: 102400 * MB });
    assert.equal(limitsFromEnv({ SUPABASE_REALTIME_MAX_CONNECTIONS: "-3" }).realtimeConnections, 200);
    assert.equal(limitsFromEnv({ SUPABASE_REALTIME_MAX_CONNECTIONS: "lots" }).realtimeConnections, 200);
  });
  it("meter tones follow the advice thresholds", () => {
    assert.deepEqual([0.1, 0.6, 0.75, 0.9, 1.4].map(usageTone), ["ok", "watch", "act", "urgent", "urgent"]);
  });
  it("builds the Supabase dashboard link only from a real project URL", () => {
    assert.equal(supabaseDashboardUrl("https://abcd1234.supabase.co"), "https://supabase.com/dashboard/project/abcd1234");
    assert.equal(supabaseDashboardUrl("http://localhost:54321"), null);
    assert.equal(supabaseDashboardUrl(undefined), null);
  });
});
