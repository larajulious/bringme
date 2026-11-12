/**
 * Server-side input validation for admin actions (pure, unit-tested).
 * Never trust the browser: handlers call these before touching the database,
 * and the database CHECK constraints are the final backstop.
 */
import type { AccessState } from "@/lib/supabase/database.types";

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

// ----------------------------------------------------------------- plans ----
export type PlanInput = {
  code?: string;
  name?: string;
  description?: string | null;
  price_cents?: number;
  max_players_per_game?: number;
  max_games_per_period?: number | null;
  max_active_games?: number;
  max_rounds_per_game?: number;
  is_active?: boolean;
};

/** `create` requires every field; otherwise any subset may be sent. `code` is create-only. */
export function parsePlanInput(body: Record<string, unknown>, mode: "create" | "update"): Parsed<PlanInput> {
  const out: PlanInput = {};
  const need = (k: string) => mode === "create" && !(k in body);

  if (mode === "create") {
    if (typeof body.code !== "string" || !/^[a-z0-9_-]{2,40}$/.test(body.code)) return fail("invalid_code");
    out.code = body.code;
  } else if ("code" in body) return fail("code_immutable");

  if ("name" in body || need("name")) {
    if (typeof body.name !== "string" || body.name.trim().length < 1 || body.name.trim().length > 80) return fail("invalid_name");
    out.name = body.name.trim();
  }
  if ("description" in body) {
    if (body.description === null || body.description === "") out.description = null;
    else if (typeof body.description === "string" && body.description.length <= 200) out.description = body.description.trim();
    else return fail("invalid_description");
  }
  // Deprecated (Game Pass): prices are set per currency via parsePriceInput; optional here.
  if ("price_cents" in body) {
    if (!isInt(body.price_cents, 0, 1_000_000)) return fail("invalid_price");
    out.price_cents = body.price_cents;
  }
  if ("max_players_per_game" in body || need("max_players_per_game")) {
    if (!isInt(body.max_players_per_game, 2, 500)) return fail("invalid_max_players");
    out.max_players_per_game = body.max_players_per_game;
  }
  if ("max_games_per_period" in body || need("max_games_per_period")) {
    if (body.max_games_per_period === null) out.max_games_per_period = null;
    else if (isInt(body.max_games_per_period, 1, 10_000)) out.max_games_per_period = body.max_games_per_period;
    else return fail("invalid_max_games");
  }
  if ("max_active_games" in body || need("max_active_games")) {
    if (!isInt(body.max_active_games, 1, 100)) return fail("invalid_max_active_games");
    out.max_active_games = body.max_active_games;
  }
  if ("max_rounds_per_game" in body || need("max_rounds_per_game")) {
    if (!isInt(body.max_rounds_per_game, 1, 200)) return fail("invalid_max_rounds");
    out.max_rounds_per_game = body.max_rounds_per_game;
  }
  if ("is_active" in body) {
    if (typeof body.is_active !== "boolean") return fail("invalid_is_active");
    out.is_active = body.is_active;
  }
  if (mode === "update" && Object.keys(out).length === 0) return fail("nothing_to_update");
  return { ok: true, value: out };
}

// -------------------------------------------------------------- settings ----
export type SettingsInput = {
  default_max_players: number;
  max_photo_size_mb: number;
  photo_retention_days: number;
  support_email: string | null;
};

export function parseSettingsInput(body: Record<string, unknown>): Parsed<SettingsInput> {
  if (!isInt(body.default_max_players, 2, 500)) return fail("invalid_default_max_players");
  if (!isInt(body.max_photo_size_mb, 1, 20)) return fail("invalid_max_photo_size");
  if (!isInt(body.photo_retention_days, 1, 365)) return fail("invalid_retention");
  let email: string | null = null;
  if (typeof body.support_email === "string" && body.support_email.trim() !== "") {
    email = body.support_email.trim();
    if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail("invalid_support_email");
  } else if (body.support_email !== null && body.support_email !== undefined && body.support_email !== "") {
    return fail("invalid_support_email");
  }
  return {
    ok: true,
    value: {
      default_max_players: body.default_max_players,
      max_photo_size_mb: body.max_photo_size_mb,
      photo_retention_days: body.photo_retention_days,
      support_email: email,
    },
  };
}

// ---------------------------------------------------------- subscriptions ----
export type SubscriptionAction =
  | { action: "activate"; planCode: string; days: number }
  | { action: "set_plan"; planCode: string }
  | { action: "set_expiry"; expires: string }
  | { action: "suspend" }
  | { action: "unsuspend" }
  | { action: "extend"; days: number; reason: string }
  | { action: "revoke"; passId: string; reason: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reasonOf = (v: unknown) => (typeof v === "string" && v.trim().length >= 3 && v.trim().length <= 200 ? v.trim() : null);

export function parseSubscriptionAction(body: Record<string, unknown>): Parsed<SubscriptionAction> {
  const planOk = typeof body.planCode === "string" && /^[a-z0-9_-]{2,40}$/.test(body.planCode);
  switch (body.action) {
    case "activate":
      if (!planOk) return fail("unknown_plan");
      if (!isInt(body.days, 1, 366)) return fail("invalid_days");
      return { ok: true, value: { action: "activate", planCode: body.planCode as string, days: body.days } };
    case "set_plan":
      if (!planOk) return fail("unknown_plan");
      return { ok: true, value: { action: "set_plan", planCode: body.planCode as string } };
    case "set_expiry": {
      if (typeof body.expires !== "string" || Number.isNaN(Date.parse(body.expires))) return fail("invalid_expiry");
      return { ok: true, value: { action: "set_expiry", expires: new Date(body.expires).toISOString() } };
    }
    case "suspend":
      return { ok: true, value: { action: "suspend" } };
    case "unsuspend":
      return { ok: true, value: { action: "unsuspend" } };
    case "extend": {
      if (!isInt(body.days, 1, 366)) return fail("invalid_days");
      const reason = reasonOf(body.reason);
      if (!reason) return fail("reason_required");
      return { ok: true, value: { action: "extend", days: body.days, reason } };
    }
    case "revoke": {
      if (typeof body.passId !== "string" || !UUID_RE.test(body.passId)) return fail("invalid_pass");
      const reason = reasonOf(body.reason);
      if (!reason) return fail("reason_required");
      return { ok: true, value: { action: "revoke", passId: body.passId, reason } };
    }
    default:
      return fail("invalid_action");
  }
}

// ---------------------------------------------------------- list params ----
export const SUBSCRIBER_STATES: AccessState[] = ["active", "pending", "expired", "suspended", "deactivated"];
export const PAGE_SIZE = 20;

export type ListParams = { q: string; state: AccessState | null; page: number };

/** Sanitises ?q, ?state and ?page from the URL (never trust search params either). */
export function parseListParams(sp: { q?: string; state?: string; page?: string }): ListParams {
  const q = (sp.q ?? "").trim().slice(0, 100);
  const state = SUBSCRIBER_STATES.find((s) => s === sp.state) ?? null;
  const n = Number.parseInt(sp.page ?? "1", 10);
  const page = Number.isFinite(n) && n >= 1 && n <= 10_000 ? n : 1;
  return { q, state, page };
}

// ------------------------------------------------------------- plan prices ----
export type PriceInput = { currency: "PHP" | "USD"; amountMinor: number };

/** Exact minor units in a fixed currency; no conversion, no floats from the browser. */
export function parsePriceInput(body: Record<string, unknown>): Parsed<PriceInput> {
  const currency = body.currency === "PHP" || body.currency === "USD" ? body.currency : null;
  if (!currency) return fail("invalid_currency");
  if (!isInt(body.amountMinor, 0, 100_000_000)) return fail("invalid_price");
  return { ok: true, value: { currency, amountMinor: body.amountMinor } };
}

// ------------------------------------------------------- plan edit + Polar sync ----
export type PlanSyncInput = { name: string; maxPlayers: number; phpMinor: number; usdMinor: number };

/** Name (Polar: 3–64 chars), players 2–500, PHP and USD in exact minor units (> 0). Duration is fixed (7 days). */
export function parsePlanSyncInput(body: Record<string, unknown>): Parsed<PlanSyncInput> {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length < 3 || name.length > 64) return fail("invalid_name");
  if (!isInt(body.maxPlayers, 2, 500)) return fail("invalid_max_players");
  if (!isInt(body.phpMinor, 1, 100_000_000) || !isInt(body.usdMinor, 1, 100_000_000)) return fail("invalid_price");
  if ("duration_seconds" in body || "durationSeconds" in body) return fail("duration_fixed");
  return { ok: true, value: { name, maxPlayers: body.maxPlayers, phpMinor: body.phpMinor, usdMinor: body.usdMinor } };
}
