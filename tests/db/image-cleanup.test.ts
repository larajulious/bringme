import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";

import { generatePlayerToken, hashToken } from "../../lib/players/token.ts";
import { as, createDb, createUser, errorOf, subscribe } from "./harness.ts";

// Image Storage Cleanup (migration 20261116000003): classification rules, revalidation, recording and audit.
// "Deleting" an object here stands in for the Storage API (which removes the storage.objects row itself).
let db: PGlite;
let boss: string;
const svc = { role: "service_role" } as const;
const user = (sub: string) => ({ role: "authenticated", sub }) as const;
const uuid = () => crypto.randomUUID();
const META = JSON.stringify({ syncRttMs: 40, syncAgeMs: 2000 });
const DAY = 86_400;

before(async () => {
  db = await createDb();
  boss = await createUser(db, "cleanup-boss@example.com");
  await db.query("update public.profiles set role='super_admin' where id=$1", [boss]);
});
after(async () => { await db.close(); });

const ver = async (id: string) => Number((await db.query<{ v: string }>("select state_version::text v from public.games where id=$1", [id])).rows[0].v);
const act = async (owner: string, id: string, action: string) =>
  as(db, user(owner), async () => db.query("select public.game_transition($1,$2,$3,null)", [id, action, await ver(id)]));

type Photo = { game: string; path: string };

/** A host (with a pass) runs a Bring Me round where `n` players submit; each photo is stored `ageDays` ago. */
async function hostWithPhotos(email: string, n: number, ageDays: number, opts: { endGame?: boolean } = {}) {
  const owner = await createUser(db, email);
  await subscribe(db, owner, { plan: "pro" });
  const g = await as(db, user(owner), async () =>
    (await db.query<{ game_id: string; code: string }>("select * from public.create_game_with_rounds('p', $1)", [["a", "b"]])).rows[0]);
  const players: { id: string; token: string }[] = [];
  for (let i = 0; i < n; i++) {
    const token = generatePlayerToken();
    const id = (await as(db, svc, () => db.query<{ player_id: string }>("select * from public.join_game($1,$2,$3,null)", [g.code, `p${i}`, hashToken(token)]))).rows[0].player_id;
    players.push({ id, token });
  }
  for (const a of ["start_game", "start_countdown", "start_round"]) await act(owner, g.game_id, a);
  const round = (await db.query<{ r: string }>("select current_round_id r from public.games where id=$1", [g.game_id])).rows[0].r;
  await db.query("update public.game_rounds set opened_at = clock_timestamp() - interval '3 seconds' where id=$1", [round]);
  const photos: Photo[] = [];
  for (const [i, p] of players.entries()) {
    const att = uuid();
    await as(db, svc, () => db.query(`select public.begin_submission($1,$2,$3,$4,'${META}')`, [hashToken(p.token), round, att, 2950 + i]));
    await as(db, svc, () => db.query("select public.complete_submission($1,$2,$3,'{}')", [hashToken(p.token), round, att]));
    const path = `${g.game_id}/${round}/${p.id}.jpg`;
    await db.query("insert into storage.objects (bucket_id, name, created_at, metadata) values ('submissions', $1, now() - make_interval(secs => $2), $3)",
      [path, ageDays * DAY + 60, JSON.stringify({ size: 1000 + i, mimetype: "image/jpeg" })]);
    // Submissions are as old as their photos (used by the reference repair).
    await db.exec("set session_replication_role = replica"); // fixture only: submitted_at is trigger-immutable
    await db.query("update public.submissions set submitted_at = now() - make_interval(secs => $2) where storage_path = $1", [path, ageDays * DAY + 60]);
    await db.exec("set session_replication_role = origin");
    photos.push({ game: g.game_id, path });
  }
  if (opts.endGame !== false) await db.query("update public.games set status='finished' where id=$1", [g.game_id]);
  return { owner, game: g.game_id, round, players, photos };
}
/** Move the host's whole pass history `days` into the past (so their pass has expired). */
const expirePass = (owner: string, days = 60) => db.query("select test.shift_ledger($1, $2)", [owner, days * DAY]);

type Row = { object_name: string; cleanup_status: string; reason: string; pass_status: string; bytes: string };
const list = async (owner?: string) => as(db, user(boss), async () =>
  (await db.query<Row>("select * from public.admin_list_images(null, null, null, $1, 200, 0)", [owner ?? null])).rows);
const statusOf = async (path: string) => (await list()).find((r) => r.object_name === path);
const candidates = (names: string[] | null) => as(db, user(boss), async () =>
  (await db.query<{ object_name: string; bytes: string }>("select * from public.admin_image_cleanup_candidates($1, 500)", [names])).rows);
const record = (evaluated: number, skipped: number, attempted: object[]) => as(db, user(boss), async () =>
  (await db.query<{ run_id: string; deleted: number; failed: number; bytes_recovered: string; references_updated: number }>(
    "select * from public.admin_record_image_cleanup($1, $2, $3)", [evaluated, skipped, JSON.stringify(attempted)])).rows[0]);
const storageRemove = (paths: string[]) => db.query("delete from storage.objects where bucket_id='submissions' and name = any($1)", [paths]);

describe("image cleanup classification", () => {
  it("expired pass + 10-day-old images: pending, never a deletion candidate", async () => {
    const h = await hostWithPhotos("c-10d@example.com", 2, 10);
    await expirePass(h.owner);
    for (const p of h.photos) {
      const r = await statusOf(p.path);
      assert.equal(r?.cleanup_status, "pending");
      assert.equal(r?.reason, "waiting_period");
      assert.equal(r?.pass_status, "expired");
    }
    const c = await candidates(h.photos.map((p) => p.path));
    assert.equal(c.length, 0);
  });

  it("expired pass + 15-day-old images: eligible", async () => {
    const h = await hostWithPhotos("c-15d@example.com", 2, 15);
    await expirePass(h.owner);
    for (const p of h.photos) assert.equal((await statusOf(p.path))?.cleanup_status, "eligible");
    assert.equal((await candidates(h.photos.map((p) => p.path))).length, 2);
  });

  it("an expired pass does not protect even though its order was paid; images under 7 days are protected", async () => {
    const h = await hostWithPhotos("c-3d@example.com", 1, 3);
    await expirePass(h.owner);
    const r = await statusOf(h.photos[0].path);
    assert.equal(r?.cleanup_status, "protected");
    assert.equal(r?.reason, "recent");
  });

  it("active pass + 30-day-old images: protected", async () => {
    const h = await hostWithPhotos("c-active@example.com", 1, 30);
    const r = await statusOf(h.photos[0].path);
    assert.equal(r?.cleanup_status, "protected");
    assert.equal(r?.reason, "active_pass");
    assert.equal(r?.pass_status, "active");
  });

  it("recently renewed pass (and a queued pass) protect old images", async () => {
    const h = await hostWithPhotos("c-renew@example.com", 1, 20);
    await expirePass(h.owner);
    assert.equal((await statusOf(h.photos[0].path))?.cleanup_status, "eligible");
    // Bought for later: starts tomorrow. Still unexpired, so it protects.
    await subscribe(db, h.owner, { start: new Date(Date.now() + DAY * 1000).toISOString(), end: new Date(Date.now() + 8 * DAY * 1000).toISOString() });
    assert.equal((await statusOf(h.photos[0].path))?.reason, "active_pass");
  });

  it("a revoked pass does not protect", async () => {
    const h = await hostWithPhotos("c-revoked@example.com", 1, 20);
    await db.query("select set_config('bringme.ledger_maintenance','on',false)");
    await db.query("update public.game_passes set disposition='revoked', ended_at=now(), end_reason='test' where user_id=$1", [h.owner]);
    await db.query("select set_config('bringme.ledger_maintenance','off',false)");
    assert.equal((await statusOf(h.photos[0].path))?.cleanup_status, "eligible");
  });

  it("unknown owner and ambiguous paths are protected", async () => {
    const h = await hostWithPhotos("c-unknown@example.com", 1, 30);
    await expirePass(h.owner);
    const other = await hostWithPhotos("c-unknown2@example.com", 1, 30);
    await expirePass(other.owner);
    const paths = [
      `${uuid()}/${uuid()}/${uuid()}.jpg`,                        // game doesn't exist
      `${h.game}/${h.round}/${other.players[0].id}.jpg`,          // player from another game
      `${h.game}/${other.round}/${h.players[0].id}.jpg`,          // round from another game
      `${h.game}/avatar.png`, "config/settings.json",             // not a gameplay photo path
    ];
    for (const p of paths) {
      await db.query("insert into storage.objects (bucket_id, name, created_at) values ('submissions', $1, now() - interval '40 days')", [p]);
    }
    for (const p of paths) {
      const r = await statusOf(p);
      assert.equal(r?.cleanup_status, "protected", p);
      assert.equal(r?.pass_status, "unknown", p);
    }
    assert.equal((await candidates(paths)).length, 0);
  });

  it("objects outside the submissions bucket are never listed", async () => {
    await db.query("insert into storage.buckets (id, name) values ('avatars', 'avatars') on conflict do nothing");
    await db.query("insert into storage.objects (bucket_id, name, created_at) values ('avatars', $1, now() - interval '90 days')", [`${uuid()}/${uuid()}/${uuid()}.jpg`]);
    assert.ok((await list()).every((r) => !r.object_name.startsWith("avatars")));
    const n = (await db.query<{ n: number }>("select count(*)::int n from storage.objects where bucket_id='avatars'")).rows[0].n;
    assert.equal(n, 1);
  });

  it("in-progress game: protected even with an expired pass", async () => {
    const h = await hostWithPhotos("c-live@example.com", 1, 20, { endGame: false });
    await expirePass(h.owner);
    const r = await statusOf(h.photos[0].path);
    assert.equal(r?.cleanup_status, "protected");
    assert.equal(r?.reason, "active_game");
  });

  it("only super admins can call the cleanup functions; nobody can call the classifier directly", async () => {
    const host = await createUser(db, "c-nosy@example.com");
    for (const sql of [
      "select * from public.admin_image_summary()",
      "select * from public.admin_list_images()",
      "select * from public.admin_image_cleanup_candidates()",
      "select * from public.admin_record_image_cleanup(0, 0, '[]')",
      "select * from public.admin_image_cleanup_history()",
    ]) {
      assert.match((await errorOf(as(db, user(host), () => db.query(sql)))) ?? "", /forbidden/, sql);
      assert.match((await errorOf(as(db, { role: "anon" }, () => db.query(sql)))) ?? "", /permission denied/, sql);
    }
    assert.match((await errorOf(as(db, user(boss), () => db.query("select * from public.image_cleanup_classify()")))) ?? "", /permission denied/);
  });
});

describe("image cleanup runs", () => {
  it("records deletions, marks references only for objects that are gone, and audits the run", async () => {
    const h = await hostWithPhotos("r-delete@example.com", 3, 20);
    await expirePass(h.owner);
    const [a, b, c] = h.photos.map((p) => p.path);
    const sizes = Object.fromEntries((await candidates([a, b, c])).map((r) => [r.object_name, Number(r.bytes)]));
    // Storage removed a and b; c failed (still present).
    await storageRemove([a, b]);
    const res = await record(10, 7, [
      { name: a, bytes: sizes[a], error: null },
      { name: b, bytes: sizes[b], error: null },
      { name: c, bytes: sizes[c], error: "storage_error" },
    ]);
    assert.equal(res.deleted, 2);
    assert.equal(res.failed, 1);
    assert.equal(Number(res.bytes_recovered), sizes[a] + sizes[b]);
    const subs = (await db.query<{ storage_path: string; photo_deleted_at: string | null; points_awarded: number }>(
      "select storage_path, photo_deleted_at, points_awarded from public.submissions where game_id=$1", [h.game])).rows;
    assert.equal(subs.length, 3, "game history is kept");
    for (const s of subs) assert.equal(s.photo_deleted_at !== null, s.storage_path !== c, s.storage_path);

    const hist = await as(db, user(boss), async () => (await db.query<{ admin_id: string; details: Record<string, unknown> }>(
      "select * from public.admin_image_cleanup_history(5)")).rows);
    assert.equal(hist[0].admin_id, boss);
    assert.equal(hist[0].details.evaluated, 10);
    assert.equal(hist[0].details.deleted, 2);
    assert.equal(hist[0].details.failed, 1);
    assert.equal(hist[0].details.skipped, 7);
    assert.deepEqual(hist[0].details.failure_reasons, { storage_error: 1 });

    // Retry: only the failed one is still a candidate.
    assert.deepEqual((await candidates([a, b, c])).map((r) => r.object_name), [c]);
  });

  it("a claimed deletion whose object still exists counts as failed", async () => {
    const h = await hostWithPhotos("r-lie@example.com", 1, 20);
    await expirePass(h.owner);
    const res = await record(1, 0, [{ name: h.photos[0].path, bytes: 1000, error: null }]);
    assert.equal(res.deleted, 0);
    assert.equal(res.failed, 1);
    const s = (await db.query<{ d: string | null }>("select photo_deleted_at d from public.submissions where storage_path=$1", [h.photos[0].path])).rows[0];
    assert.equal(s.d, null);
  });

  it("repeated execution is a no-op, and repairs references left by an interrupted run", async () => {
    const h = await hostWithPhotos("r-repeat@example.com", 1, 20);
    await expirePass(h.owner);
    await storageRemove([h.photos[0].path]); // deleted, but the run died before recording
    const res = await record(0, 0, []);
    assert.equal(res.deleted, 0);
    assert.ok(res.references_updated >= 1);
    const again = await record(0, 0, []);
    assert.equal(again.references_updated, 0);
  });

  it("a pass activated between preview and deletion: revalidation drops the images", async () => {
    const h = await hostWithPhotos("r-race@example.com", 2, 20);
    await expirePass(h.owner);
    const preview = (await candidates(null)).filter((r) => h.photos.some((p) => p.path === r.object_name));
    assert.equal(preview.length, 2);
    await subscribe(db, h.owner); // host buys a new pass
    assert.equal((await candidates(preview.map((r) => r.object_name))).length, 0);
  });

  it("summary counts every bucket object once", async () => {
    const s = await as(db, user(boss), async () => (await db.query<Record<string, string>>("select * from public.admin_image_summary()")).rows[0]);
    const all = await list();
    assert.equal(Number(s.total_count), all.length);
    assert.equal(Number(s.pending_count) + Number(s.eligible_count) + Number(s.protected_count), all.length);
    assert.equal(Number(s.eligible_count), all.filter((r) => r.cleanup_status === "eligible").length);
  });
});
