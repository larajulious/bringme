import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";

import { generatePlayerToken, hashToken } from "../../lib/players/token.ts";
import { as, createDb, createUser, errorOf, subscribe } from "./harness.ts";

// Phase 3: who can reach which photo, through the EXACT queries the photo routes now issue
// (owner-scoped games lookup, round_ranking, game_rounds winner, player_winner_photo) and the Storage read policy.
let db: PGlite;
let alice: string;
let bob: string;
const svc = { role: "service_role" } as const;
const user = (sub: string) => ({ role: "authenticated", sub }) as const;
const uuid = () => crypto.randomUUID();
const META = JSON.stringify({ syncRttMs: 40, syncAgeMs: 2000 });

before(async () => {
  db = await createDb();
  alice = await createUser(db, "photos-alice@example.com");
  bob = await createUser(db, "photos-bob@example.com");
  for (const u of [alice, bob]) await subscribe(db, u, { plan: "pro" });
});
after(async () => { await db.close(); });

const ver = async (id: string) => Number((await db.query<{ v: string }>("select state_version::text v from public.games where id=$1", [id])).rows[0].v);
const act = async (owner: string, id: string, action: string, winner: string | null = null) =>
  as(db, user(owner), async () => db.query("select public.game_transition($1,$2,$3,$4)", [id, action, await ver(id), winner]));
type G = { id: string; round: string; tokens: Record<string, string>; ids: Record<string, string> };

/** A live round where every named player has an accepted photo (and a Storage object at its path). */
async function roundWithPhotos(owner: string, names: string[]): Promise<G> {
  await db.query("update public.games set status='canceled' where owner_id=$1 and status in ('draft','lobby','live')", [owner]);
  const g = await as(db, user(owner), async () => (await db.query<{ game_id: string; code: string }>("select * from public.create_game_with_rounds('p', $1)", [["a", "b"]])).rows[0]);
  const out: G = { id: g.game_id, round: "", tokens: {}, ids: {} };
  for (const n of names) {
    out.tokens[n] = generatePlayerToken();
    out.ids[n] = (await as(db, svc, () => db.query<{ player_id: string }>("select * from public.join_game($1,$2,$3,null)", [g.code, n, hashToken(out.tokens[n])]))).rows[0].player_id;
  }
  for (const a of ["start_game", "start_countdown", "start_round"]) await act(owner, out.id, a);
  out.round = (await db.query<{ r: string }>("select current_round_id r from public.games where id=$1", [out.id])).rows[0].r;
  await db.query("update public.game_rounds set opened_at = clock_timestamp() - interval '3 seconds' where id=$1", [out.round]);
  for (const [i, n] of names.entries()) {
    const att = uuid();
    await as(db, svc, () => db.query(`select public.begin_submission($1,$2,$3,$4,'${META}')`, [hashToken(out.tokens[n]), out.round, att, 2950 + i]));
    await as(db, svc, () => db.query("select public.complete_submission($1,$2,$3,'{}')", [hashToken(out.tokens[n]), out.round, att]));
    await db.query("insert into storage.objects (bucket_id, name) values ('submissions', $1)", [`${out.id}/${out.round}/${out.ids[n]}.jpg`]);
  }
  return out;
}
// The listing route's queries, verbatim (run as the signed-in host)
const routeGame = (sub: string, gameId: string) => as(db, user(sub), async () =>
  (await db.query<{ current_round_id: string; phase: string }>("select current_round_id, phase from public.games where id = $1 and owner_id = $2", [gameId, sub])).rows);
const ranking = (sub: string, roundId: string) => as(db, user(sub), async () =>
  (await db.query<{ submission_id: string; player_id: string; status: string; storage_path: string }>("select * from public.round_ranking($1)", [roundId])).rows);
const winnerRow = (sub: string, roundId: string) => as(db, user(sub), async () =>
  (await db.query("select winner_player_id, winner_confirmed_at from public.game_rounds where id = $1", [roundId])).rows);
const objects = (actor: Parameters<typeof as>[1]) => as(db, actor, async () =>
  (await db.query<{ name: string }>("select name from storage.objects where bucket_id = 'submissions' order by name")).rows.map((r) => r.name));
const winnerPhoto = (token: string) => as(db, svc, async () => (await db.query<{ p: string | null }>("select public.player_winner_photo($1) p", [hashToken(token)])).rows[0].p);

describe("photo isolation", () => {
  it("the owner gets the round and its ranked photos through the route's queries", async () => {
    const g = await roundWithPhotos(alice, ["Ann", "Bo"]);
    const [game] = await routeGame(alice, g.id);
    assert.equal(game.current_round_id, g.round);
    assert.equal(game.phase, "active");
    const rows = await ranking(alice, g.round);
    assert.deepEqual(rows.map((r) => r.storage_path).sort(), [`${g.id}/${g.round}/${g.ids.Ann}.jpg`, `${g.id}/${g.round}/${g.ids.Bo}.jpg`].sort());
  });

  it("another host gets nothing: no game (-> 404), no ranking, no winner row, no Storage object", async () => {
    const g = await roundWithPhotos(alice, ["Ann"]);
    assert.deepEqual(await routeGame(bob, g.id), [], "owner-scoped lookup: another host's game is 'not found'");
    assert.deepEqual(await ranking(bob, g.round), []);
    assert.deepEqual(await winnerRow(bob, g.round), []);
    const bobSees = await objects(user(bob));
    assert.ok(!bobSees.some((n) => n.startsWith(`${g.id}/`)), "the Storage read policy refuses the other host's photos");
    assert.ok((await objects(user(alice))).some((n) => n.startsWith(`${g.id}/`)));
  });

  it("guests (players) can't list photos or rankings at all", async () => {
    const g = await roundWithPhotos(alice, ["Ann"]);
    const guest = { role: "anon", claims: { kind: "guest", game_id: g.id, sub: g.ids.Ann } } as const;
    assert.deepEqual(await objects(guest), [], "no Storage read policy for anon");
    assert.match((await errorOf(as(db, guest, () => db.query("select * from public.round_ranking($1)", [g.round])))) ?? "", /permission denied/i);
    assert.match((await errorOf(as(db, guest, () => db.query("select * from public.submissions")))) ?? "", /permission denied/i);
    assert.match((await errorOf(as(db, guest, () => db.query("insert into storage.objects (bucket_id, name) values ('submissions', $1)", [`${g.id}/${g.round}/${uuid()}.jpg`])))) ?? "", /row-level security|permission denied/i);
  });

  it("a removed player's photo leaves the host's list (so it is never signed again); a rejected one stays for review", async () => {
    const g = await roundWithPhotos(alice, ["Ann", "Bo", "Cy"]);
    const sub = (await ranking(alice, g.round)).find((r) => r.player_id === g.ids.Cy)!.submission_id;
    await as(db, user(alice), () => db.query("select public.review_submission($1,'disqualify')", [sub]));
    await as(db, user(alice), () => db.query("update public.players set kicked_at = now() where id=$1", [g.ids.Bo]));
    const rows = await ranking(alice, g.round);
    assert.deepEqual(rows.map((r) => r.player_id).sort(), [g.ids.Ann, g.ids.Cy].sort());
    assert.equal(rows.find((r) => r.player_id === g.ids.Cy)!.status, "rejected", "the host can still see (and undo) a disqualification");
  });

  it("winner photo: only during the official announcement, only for that game's players who weren't removed", async () => {
    const g = await roundWithPhotos(alice, ["Ann", "Bo", "Cy"]);
    const other = await roundWithPhotos(bob, ["Zed"]);
    const annSub = (await ranking(alice, g.round)).find((r) => r.player_id === g.ids.Ann)!.submission_id;
    await as(db, user(alice), () => db.query("select public.review_submission($1,'approve')", [annSub]));
    assert.equal(await winnerPhoto(g.tokens.Bo), null, "nothing before the announcement");
    await as(db, user(alice), () => db.query("update public.players set kicked_at = now() where id=$1", [g.ids.Cy]));
    for (const a of ["close_submissions", "move_to_review"]) await act(alice, g.id, a);
    await act(alice, g.id, "announce_winner", g.ids.Ann);
    const expected = `${g.id}/${g.round}/${g.ids.Ann}.jpg`;
    assert.equal(await winnerPhoto(g.tokens.Bo), expected);
    assert.equal(await winnerPhoto(g.tokens.Ann), expected);
    assert.equal(await winnerPhoto(g.tokens.Cy), null, "a removed player gets no URL");
    assert.equal(await winnerPhoto(other.tokens.Zed), null, "a player of another game gets no URL");
    assert.equal(await winnerPhoto(generatePlayerToken()), null, "an unknown session gets no URL");
    const [w] = await winnerRow(alice, g.round) as { winner_player_id: string; winner_confirmed_at: string }[];
    assert.ok(w.winner_confirmed_at && w.winner_player_id === g.ids.Ann, "the presenter's winner check sees the official winner");
    await act(alice, g.id, "next_round");
    assert.equal(await winnerPhoto(g.tokens.Bo), null, "the announcement is over: no more URLs");
  });

  it("the completion route's identity and duplicate lookups find exactly this player's row", async () => {
    const g = await roundWithPhotos(alice, ["Ann", "Bo"]);
    const me = await as(db, svc, async () => (await db.query<{ id: string; game_id: string; kicked_at: string | null }>(
      "select id, game_id, kicked_at from public.players where token_hash = $1", [hashToken(g.tokens.Ann)])).rows);
    assert.deepEqual(me.map((r) => [r.id, r.game_id, r.kicked_at]), [[g.ids.Ann, g.id, null]]);
    const prior = await as(db, svc, async () => (await db.query<{ claimed_elapsed_ms: number; timing_status: string }>(
      "select claimed_elapsed_ms, timing_status from public.submissions where round_id = $1 and player_id = $2", [g.round, g.ids.Ann])).rows);
    assert.equal(prior.length, 1);
    assert.equal(prior[0].claimed_elapsed_ms, 2950);
    const none = await as(db, svc, async () => (await db.query("select 1 from public.submissions where round_id = $1 and player_id = $2", [uuid(), g.ids.Ann])).rows);
    assert.equal(none.length, 0, "another round: not a duplicate");
  });
});
