import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";

import { as, errorOf, newPGlite } from "./harness.ts";

/**
 * A database that already had an OLDER BringMe! schema before the migrations
 * ran (the shape found on the hosted project: room_code, item_name,
 * round_number, starts_at/expires_at, price/max_players/max_games,
 * display_name, text statuses, permissive legacy policies). Running
 * 20261110000000_legacy_schema_compat.sql + migrations 1–12 must succeed
 * twice, preserve every row, and leave the real security model in place.
 */
const root = join(import.meta.dirname, "..", "..");
const migrationsDir = join(root, "supabase", "migrations");
const files = readdirSync(migrationsDir).filter((n) => n.endsWith(".sql")).sort();
const ADMIN = "00000000-0000-4000-8000-0000000000a1";
const SUB = "00000000-0000-4000-8000-0000000000b2";

const LEGACY = `
insert into auth.users (id, email) values ('${ADMIN}', 'admin@example.com'), ('${SUB}', 'sub@example.com');
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text, role text not null default 'subscriber' check (role in ('subscriber', 'super_admin')),
  created_at timestamptz not null default now());
create table public.subscription_plans (
  id uuid primary key default gen_random_uuid(), code text, name text not null, is_active boolean default true,
  created_at timestamptz default now(), price numeric not null, max_players integer not null, max_games integer not null);
create table public.subscriptions (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles (id),
  plan_id uuid references public.subscription_plans (id), status text not null check (status in ('active', 'expired')),
  created_at timestamptz default now(), starts_at timestamptz not null, expires_at timestamptz);
create table public.games (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references public.profiles (id),
  title text, status text not null default 'lobby' check (status in ('draft', 'lobby', 'live', 'finished')),
  created_at timestamptz default now(), room_code text not null unique);
create index games_open_idx on public.games (status) where status in ('lobby', 'live');
create table public.game_rounds (
  id uuid primary key default gen_random_uuid(), game_id uuid not null references public.games (id) on delete cascade,
  status text not null default 'pending', item_name text not null, round_number integer not null, winner_submission_id uuid);
create table public.players (
  id uuid primary key default gen_random_uuid(), game_id uuid not null references public.games (id) on delete cascade,
  nickname text, joined_at timestamptz default now(), display_name text not null);
create table public.submissions (
  id uuid primary key default gen_random_uuid(), game_id uuid not null, round_id uuid not null references public.game_rounds (id),
  player_id uuid not null references public.players (id), status text not null default 'pending', created_at timestamptz default now());
-- the kind of policies an older setup leaves behind
alter table public.profiles enable row level security;
alter table public.games enable row level security;
create policy "Public profiles are viewable by everyone" on public.profiles for select using (true);
create policy "Anyone can read games" on public.games for select using (status <> 'draft');
-- legacy data that must survive
insert into public.profiles (id, display_name, role) values ('${ADMIN}', 'Boss', 'super_admin'), ('${SUB}', 'Host', 'subscriber');
insert into public.subscription_plans (code, name, price, max_players, max_games) values ('party', 'Party', 9.99, 40, 2), (null, 'Old Plan', 0, 8, 1);
insert into public.subscriptions (user_id, plan_id, status, starts_at, expires_at)
  select '${SUB}', id, 'active', now() - interval '1 day', now() + interval '29 days' from public.subscription_plans where code = 'party';
insert into public.games (id, owner_id, title, status, room_code) values
  ('00000000-0000-4000-8000-00000000c001', '${SUB}', 'Old game', 'finished', 'ABC234'),
  ('00000000-0000-4000-8000-00000000c002', '${SUB}', null, 'finished', 'room-7');
insert into public.game_rounds (id, game_id, status, item_name, round_number) values
  ('00000000-0000-4000-8000-00000000d001', '00000000-0000-4000-8000-00000000c001', 'closed', 'A spoon', 1),
  ('00000000-0000-4000-8000-00000000d002', '00000000-0000-4000-8000-00000000c001', 'closed', 'A sock', 2);
insert into public.players (id, game_id, display_name) values ('00000000-0000-4000-8000-00000000e001', '00000000-0000-4000-8000-00000000c001', 'Sam');
insert into public.submissions (game_id, round_id, player_id, status) values
  ('00000000-0000-4000-8000-00000000c001', '00000000-0000-4000-8000-00000000d001', '00000000-0000-4000-8000-00000000e001', 'approved');
`;

async function legacyDb(extra = ""): Promise<PGlite> {
  const db = newPGlite();
  await db.exec(readFileSync(join(import.meta.dirname, "supabase-shim.sql"), "utf8"));
  await db.exec(LEGACY + extra);
  return db;
}
const applyAll = async (db: PGlite) => { for (const f of files) await db.exec(readFileSync(join(migrationsDir, f), "utf8")); };
const count = async (db: PGlite, t: string) => Number((await db.query<{ n: string }>(`select count(*) n from ${t}`)).rows[0].n);

describe("legacy schema compatibility (pre-existing older BringMe! tables)", () => {
  it("the compat migration sorts before migration 1", () => {
    assert.equal(files[0], "20261110000000_legacy_schema_compat.sql");
    assert.equal(files[1], "20261111000001_core_schema.sql");
  });

  it("WITHOUT the compat migration, migration 1 fails on the legacy tables (the reported 42703)", async () => {
    const db = await legacyDb();
    const err = await errorOf(db.exec(readFileSync(join(migrationsDir, files[1]), "utf8")));
    assert.match(err ?? "", /column .* does not exist/);
  });

  it("compat + migrations 1–12 apply cleanly, twice, and keep every row", async () => {
    const db = await legacyDb();
    const before = { users: 2, profiles: 2, plans: 2, subs: 1, games: 2, rounds: 2, players: 1, subm: 1 };
    await applyAll(db);
    await applyAll(db); // re-run: idempotent
    assert.equal(await count(db, "auth.users"), before.users);
    assert.equal(await count(db, "public.profiles"), before.profiles);
    assert.equal(await count(db, "public.subscription_plans"), before.plans + 3); // seeds add starter + pro + trial; 'party' already existed, so it is not duplicated
    assert.equal(await count(db, "public.subscriptions"), before.subs);
    assert.equal(await count(db, "public.games"), before.games);
    assert.equal(await count(db, "public.game_rounds"), before.rounds);
    assert.equal(await count(db, "public.players"), before.players);
    assert.equal(await count(db, "public.submissions"), before.subm);

    // legacy values mapped into the new columns; legacy columns kept
    const p = (await db.query<{ email: string; role: string }>(`select email, role::text from public.profiles where id='${ADMIN}'`)).rows[0];
    assert.deepEqual(p, { email: "admin@example.com", role: "super_admin" });
    const plan = (await db.query<Record<string, unknown>>("select code, max_players_per_game, max_active_games, max_rounds_per_game, price from public.subscription_plans where name='Party'")).rows[0];
    assert.deepEqual({ ...plan, price: String(plan.price) }, { code: "party", max_players_per_game: 40, max_active_games: 2, max_rounds_per_game: 15, price: "9.99" });
    assert.match((await db.query<{ code: string }>("select code from public.subscription_plans where name='Old Plan'")).rows[0].code, /^old-plan-[0-9a-f]{8}$/);
    const g = (await db.query<{ join_code: string; room_code: string; status: string; phase: string; title: string }>(
      "select join_code, room_code, status::text, phase::text, title from public.games order by created_at, id")).rows;
    assert.equal(g[0].join_code, "ABC234");             // valid legacy code reused
    assert.match(g[1].join_code, /^[A-Z0-9]{6}$/);     // 'room-7' got a fresh one
    assert.equal(g[1].room_code, "room-7");            // ...and the legacy value is kept
    assert.equal(g[1].title, `Game ${g[1].join_code}`);
    assert.ok(g.every((x) => x.status === "finished" && x.phase === "finished"));
    const r = (await db.query<{ round_no: number; prompt: string }>("select round_no, prompt from public.game_rounds order by round_no")).rows;
    assert.deepEqual(r, [{ round_no: 1, prompt: "A spoon" }, { round_no: 2, prompt: "A sock" }]);
    const pl = (await db.query<{ nickname: string; token_hash: string }>("select nickname, token_hash from public.players")).rows[0];
    assert.equal(pl.nickname, "Sam");
    assert.match(pl.token_hash, /^[0-9a-f]{64}$/);
    const s = (await db.query<{ start_matches: boolean; end_matches: boolean }>(
      "select current_period_start = starts_at as start_matches, current_period_end = expires_at as end_matches from public.subscriptions")).rows[0];
    assert.deepEqual(s, { start_matches: true, end_matches: true });
  });

  it("the legacy permissive policies are gone and the real RLS applies (fixes the login 'profile_missing')", async () => {
    const db = await legacyDb();
    await applyAll(db);
    const legacy = await db.query("select policyname from pg_policies where policyname in ('Public profiles are viewable by everyone', 'Anyone can read games')");
    assert.equal(legacy.rows.length, 0);
    // a signed-in user can read their OWN profile (what /auth/continue needs) and nobody else's
    const own = await as(db, { role: "authenticated", sub: SUB }, () => db.query<{ id: string }>("select id from public.profiles"));
    assert.deepEqual(own.rows.map((x) => x.id), [SUB]);
    const admin = await as(db, { role: "authenticated", sub: ADMIN }, () => db.query("select id from public.profiles"));
    assert.equal(admin.rows.length, 2);
    assert.match((await errorOf(as(db, { role: "anon" }, () => db.query("select * from public.profiles")))) ?? "", /permission denied/i);
    assert.match((await errorOf(as(db, { role: "anon" }, () => db.query("select * from public.games")))) ?? "", /permission denied/i);
  });

  it("the app's flows work on the upgraded database (create game, join, entitlement, admin overview)", async () => {
    const db = await legacyDb();
    await applyAll(db);
    const ent = await as(db, { role: "authenticated", sub: SUB }, () => db.query<{ plan_code: string; max_players_per_game: number }>("select * from public.my_entitlement()"));
    assert.equal(ent.rows[0].plan_code, "party");
    const created = await as(db, { role: "authenticated", sub: SUB }, () =>
      db.query<{ game_id: string; code: string }>("select * from public.create_game_with_rounds('New night', array['a cup','a key'])"));
    const { game_id, code } = created.rows[0];
    assert.match(code, /^[A-Z0-9]{6}$/);
    const hash = createHash("sha256").update(randomUUID()).digest("hex");
    const joined = await as(db, { role: "service_role" }, () => db.query<{ nickname: string }>("select * from public.join_game($1, 'Alex', $2, null)", [code, hash]));
    assert.equal(joined.rows[0].nickname, "Alex");
    const ov = await as(db, { role: "authenticated", sub: ADMIN }, () => db.query("select * from public.admin_overview()"));
    assert.equal(ov.rows.length, 1);
    assert.match((await errorOf(as(db, { role: "authenticated", sub: SUB }, () => db.query("select * from public.admin_overview()")))) ?? "", /forbidden/);
    assert.equal(Number((await db.query<{ n: string }>("select count(*) n from public.game_rounds where game_id=$1", [game_id])).rows[0].n), 2);
  });

  it("an unknown legacy status stops the compat migration with a clear message and changes nothing", async () => {
    const db = await legacyDb("alter table public.games drop constraint games_status_check; update public.games set status='waiting' where room_code='room-7';");
    const sql = readFileSync(join(migrationsDir, files[0]), "utf8");
    const err = await errorOf(db.exec(`begin; ${sql}; commit;`));
    await db.exec("rollback").catch(() => {});
    assert.match(err ?? "", /games\.status contains values that are not valid game_status: \[waiting\]/);
    const cols = await db.query("select 1 from information_schema.columns where table_name='games' and column_name='join_code'");
    assert.equal(cols.rows.length, 0, "the failed run left no partial changes (run it in one transaction)");
    assert.equal(await count(db, "public.games"), 2);
  });

  it("is a no-op on a fresh database (the normal path)", async () => {
    const db = newPGlite();
    await db.exec(readFileSync(join(import.meta.dirname, "supabase-shim.sql"), "utf8"));
    await db.exec(readFileSync(join(migrationsDir, files[0]), "utf8"));
    const t = await db.query("select table_name from information_schema.tables where table_schema='public'");
    assert.equal(t.rows.length, 0);
  });
});
