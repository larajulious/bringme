import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";

const root = join(import.meta.dirname, "..", "..");

/** PGlite with the extensions the migrations need (btree_gist for the pass ledger's exclusion constraint). */
export function newPGlite(): PGlite {
  return new PGlite({ extensions: { btree_gist } });
}

/** Fresh in-memory Postgres with the Supabase shim + every real migration applied. */
export async function createDb(): Promise<PGlite> {
  const db = newPGlite();
  await db.exec(readFileSync(join(import.meta.dirname, "supabase-shim.sql"), "utf8"));
  const dir = join(root, "supabase", "migrations");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(join(dir, f), "utf8"));
  }
  return db;
}

type Actor =
  | { role: "anon"; claims?: Record<string, unknown> }
  | { role: "authenticated"; sub: string }
  | { role: "service_role" }
  | { role: "postgres" };

/** Run `fn` as a given Postgres/JWT identity, as PostgREST would. */
export async function as<T>(db: PGlite, actor: Actor, fn: () => Promise<T>): Promise<T> {
  await db.exec("reset role");
  if (actor.role !== "postgres") {
    await db.exec(`set role ${actor.role}`);
  }
  const sub = actor.role === "authenticated" ? actor.sub : "";
  const claims = actor.role === "anon" && actor.claims ? JSON.stringify(actor.claims) : sub ? JSON.stringify({ sub }) : "";
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [sub]);
  await db.query("select set_config('request.jwt.claims', $1, false)", [claims]);
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
  }
}

/** Resolves to the error message, or null if the statement succeeded. */
export async function errorOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export async function createUser(db: PGlite, email: string, meta: object = {}): Promise<string> {
  const r = await db.query<{ id: string }>(
    "insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id",
    [email, JSON.stringify(meta)],
  );
  return r.rows[0].id;
}

/**
 * Superuser helper: give a host access over [start, end) (default: started yesterday, 30 days).
 * Since the Game Pass cutover this writes a pass to the ledger (public.subscriptions is frozen).
 */
export async function subscribe(
  db: PGlite,
  userId: string,
  opts: { start?: string; end?: string; plan?: string } = {},
) {
  await db.query("select test.grant_access($1, $2, $3::timestamptz, $4::timestamptz)", [
    userId,
    opts.plan ?? "party",
    opts.start ?? new Date(Date.now() - 86_400_000).toISOString(),
    opts.end ?? new Date(Date.now() + 30 * 86_400_000).toISOString(),
  ]);
}

/** What Supabase does when the host clicks the verification link (fires the trial trigger). */
export const confirmUser = (db: PGlite, userId: string) =>
  db.query("update auth.users set email_confirmed_at = now() where id = $1 and email_confirmed_at is null", [userId]);

/** Simulate elapsed time for one host's passes (seconds into the past). */
export const shiftLedger = (db: PGlite, userId: string, seconds: number) =>
  db.query("select test.shift_ledger($1, $2)", [userId, seconds]);

/** End the host's running pass now; whatever is queued next becomes active. */
export const endCurrentPass = (db: PGlite, userId: string) => db.query("select test.end_current($1)", [userId]);
