import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";

import { generatePlayerToken, hashToken } from "../../lib/players/token.ts";
import { as, createDb, createUser, errorOf } from "./harness.ts";

type R = Record<string, unknown>;
let db: PGlite;
let host: string;
let other: string;
const svc = { role: "service_role" } as const;
const user = (sub: string) => ({ role: "authenticated", sub }) as const;
const uuid = () => crypto.randomUUID();
const GOOD_META = { syncRttMs: 40, syncAgeMs: 2000 };

before(async () => {
  db = await createDb();
  host = await createUser(db, "sub-host@example.com");
  other = await createUser(db, "sub-other@example.com");
  for (const u of [host, other]) await as(db, svc, () => db.query("select public.admin_set_subscription($1,'activate','pro',30,null)", [u]));
});
after(async () => { await db.close(); });

type G = { id: string; round: string; tokens: Record<string, string>; ids: Record<string, string> };

const version = async (id: string) => Number((await db.query<{ v: string }>("select state_version::text v from public.games where id=$1", [id])).rows[0].v);
const act = async (g: { id: string }, action: string, sub = host, winner: string | null = null) => {
  const v = await version(g.id);
  return as(db, user(sub), () => db.query("select public.game_transition($1,$2,$3,$4)", [g.id, action, v, winner]));
};
/** Set where "now" is relative to the official round start (opened_at). */
const startedAgo = (g: G, ms: number) => db.query("update public.game_rounds set opened_at = clock_timestamp() - ($2 || ' milliseconds')::interval where id=$1", [g.round, String(ms)]);

/** Active round, officially started `startedMs` ago, for the given players. */
async function activeGame(owner = host, names = ["Ann", "Bo", "Cy"], items = ["a red shoe", "something round"]): Promise<G> {
  await db.query("update public.games set status='canceled' where owner_id=$1 and status in ('draft','lobby','live')", [owner]);
  const g = await as(db, user(owner), async () => (await db.query<{ game_id: string; code: string }>("select * from public.create_game_with_rounds('t', $1)", [items])).rows[0]);
  const tokens: Record<string, string> = {}, ids: Record<string, string> = {};
  for (const n of names) {
    tokens[n] = generatePlayerToken();
    ids[n] = (await as(db, svc, () => db.query<{ player_id: string }>("select * from public.join_game($1,$2,$3,null)", [g.code, n, hashToken(tokens[n])]))).rows[0].player_id;
  }
  const game = { id: g.game_id };
  await act(game, "start_game", owner); await act(game, "start_countdown", owner); await act(game, "start_round", owner);
  const round = (await db.query<{ id: string }>("select current_round_id id from public.games where id=$1", [g.game_id])).rows[0].id;
  const out = { id: g.game_id, round, tokens, ids };
  await startedAgo(out, 5000);
  return out;
}
const begin = (g: G, who: string, attempt: string, elapsed: number, meta: R = GOOD_META) =>
  as(db, svc, async () => (await db.query<{ r: R }>("select public.begin_submission($1,$2,$3,$4,$5) as r", [hashToken(g.tokens[who]), g.round, attempt, elapsed, JSON.stringify(meta)])).rows[0].r);
const complete = (g: G, who: string, attempt: string, meta: R = { uploadMs: 300 }) =>
  as(db, svc, async () => (await db.query<{ r: R }>("select public.complete_submission($1,$2,$3,$4) as r", [hashToken(g.tokens[who]), g.round, attempt, JSON.stringify(meta)])).rows[0].r);
const submission = async (g: G, who: string) =>
  (await db.query<R>("select * from public.submissions where round_id=$1 and player_id=$2", [g.round, g.ids[who]])).rows[0];
const count = async (sql: string, args: unknown[]) => Number((await db.query<{ n: string }>(`select count(*)::text n from ${sql}`, args)).rows[0].n);

describe("happy path and timing evidence", () => {
  it("records the claim, the server's independent view, and ranks by the claim when they agree", async () => {
    const g = await activeGame();
    await startedAgo(g, 3040); // the tap "happens" 3.000 s after the official start, server hears 40 ms later
    const a = uuid();
    const b = await begin(g, "Ann", a, 3000);
    assert.equal(b.status, "ready");
    const done = await complete(g, "Ann", a);
    assert.deepEqual([done.status, done.elapsedMs, done.timing], ["accepted", 3000, "consistent"]);
    const s = await submission(g, "Ann");
    assert.equal(s.claimed_elapsed_ms, 3000);
    assert.ok(Math.abs(Number(s.server_elapsed_ms) - 3040) < 80, `server saw it at ${s.server_elapsed_ms}ms`);
    assert.ok(Number(s.received_elapsed_ms) >= Number(s.server_elapsed_ms), "receipt cannot precede the intent");
    assert.equal(s.rank_ms, 3000, "consistent claims rank by the client's measurement");
    assert.deepEqual(s.timing_flags, []);
    assert.equal(s.storage_path, `${g.id}/${g.round}/${g.ids.Ann}.jpg`, "path derived from verified ids only");
  });

  it("stores bounded client metadata alongside the server timestamps", async () => {
    const g = await activeGame();
    await startedAgo(g, 1000);
    const a = uuid();
    await begin(g, "Ann", a, 960, { ...GOOD_META, camera: "environment" });
    await complete(g, "Ann", a, { uploadMs: 812 });
    const s = await submission(g, "Ann");
    assert.deepEqual(s.client_meta, { ...GOOD_META, camera: "environment", uploadMs: 812 });
  });
});

describe("suspicious timing is detected and never trusted", () => {
  it("a claim far EARLIER than the server heard about it is flagged; ranking falls back to the server's time", async () => {
    const g = await activeGame();
    await startedAgo(g, 9000); // server hears the tap 9 s after the start...
    const a = uuid();
    await begin(g, "Ann", a, 2000); // ...but the client claims 2.000 s
    const r = await complete(g, "Ann", a);
    assert.equal(r.timing, "flagged");
    assert.ok((r.flags as string[]).includes("intent_lag_high"));
    const s = await submission(g, "Ann");
    assert.ok(Math.abs(Number(s.rank_ms) - 9000) < 100, `rank_ms uses the server-observed ${s.rank_ms}`);
    assert.equal(s.claimed_elapsed_ms, 2000, "the claim is kept for forensics");
  });

  it("a claim LATER than the server's own receipt is impossible and flagged", async () => {
    const g = await activeGame();
    await startedAgo(g, 1000);
    const a = uuid();
    await begin(g, "Ann", a, 4000);
    const r = await complete(g, "Ann", a);
    assert.ok((r.flags as string[]).includes("intent_before_capture"));
    assert.equal(r.timing, "flagged");
  });

  it("a negative or beyond-the-limit elapsed time is flagged; absurd values are refused outright", async () => {
    const g = await activeGame();
    const a = uuid();
    await begin(g, "Ann", a, -1000);
    const r = await complete(g, "Ann", a);
    assert.ok((r.flags as string[]).includes("elapsed_negative"));
    assert.match((await errorOf(begin(g, "Bo", uuid(), -70000))) ?? "", /invalid_timing/);
    assert.match((await errorOf(begin(g, "Bo", uuid(), 8_000_000))) ?? "", /invalid_timing/);
  });

  it("poor clock sync only adds soft flags: the submission stays 'consistent' but is visibly low-confidence", async () => {
    const g = await activeGame();
    await startedAgo(g, 2040);
    const a = uuid();
    await begin(g, "Ann", a, 2000, { syncRttMs: 2400, syncAgeMs: 300000 });
    const r = await complete(g, "Ann", a);
    assert.equal(r.timing, "consistent");
    assert.deepEqual((r.flags as string[]).sort(), ["sync_rtt_high", "sync_stale"]);
    const g2 = await activeGame();
    await startedAgo(g2, 2040);
    const a2 = uuid();
    await begin(g2, "Ann", a2, 2000, {});
    assert.ok(((await complete(g2, "Ann", a2)).flags as string[]).includes("sync_unknown"));
  });

  it("junk metadata can never break completion (types are checked in SQL)", async () => {
    const g = await activeGame();
    await startedAgo(g, 1040);
    const a = uuid();
    await begin(g, "Ann", a, 1000, { syncRttMs: "lots", syncAgeMs: { x: 1 } });
    const r = await complete(g, "Ann", a);
    assert.equal(r.status, "accepted");
  });
});

describe("duplicates, retries and races", () => {
  it("begin twice for the same capture resumes: one intent, original timing kept", async () => {
    const g = await activeGame();
    const a = uuid();
    const first = await begin(g, "Ann", a, 1000);
    await new Promise((r) => setTimeout(r, 30));
    const again = await begin(g, "Ann", a, 99999); // a retry can't change the timing
    assert.equal(again.status, "resumed");
    assert.equal(again.intentAt, first.intentAt);
    assert.equal(await count("public.submission_intents where round_id=$1 and player_id=$2", [g.round, g.ids.Ann]), 1);
    assert.equal(Number((await db.query<{ c: number }>("select claimed_elapsed_ms c from public.submission_intents where round_id=$1", [g.round])).rows[0].c), 1000);
  });

  it("a NEW capture replaces an unfinished one and its timing restarts (no 'reserve a fast time')", async () => {
    const g = await activeGame();
    const first = await begin(g, "Ann", uuid(), 100);
    await new Promise((r) => setTimeout(r, 30));
    const second = await begin(g, "Ann", uuid(), 20000);
    assert.equal(second.status, "ready");
    assert.ok(Date.parse(second.intentAt as string) > Date.parse(first.intentAt as string));
    assert.equal(Number((await db.query<{ c: number }>("select claimed_elapsed_ms c from public.submission_intents where round_id=$1", [g.round])).rows[0].c), 20000);
  });

  it("the superseded capture cannot complete; the replacing one can", async () => {
    const g = await activeGame();
    const old = uuid(), fresh = uuid();
    await begin(g, "Ann", old, 500);
    await begin(g, "Ann", fresh, 700);
    assert.match((await errorOf(complete(g, "Ann", old))) ?? "", /attempt_superseded/);
    assert.equal((await complete(g, "Ann", fresh)).status, "accepted");
  });

  it("after acceptance there is no second submission: begin/complete are idempotent and nothing is overwritten", async () => {
    const g = await activeGame();
    await startedAgo(g, 2040);
    const a = uuid();
    await begin(g, "Ann", a, 2000);
    const first = await complete(g, "Ann", a);
    const retry = await complete(g, "Ann", a); // response was lost, client retries
    assert.equal(retry.status, "duplicate");
    assert.equal(retry.elapsedMs, first.elapsedMs);
    const b2 = await begin(g, "Ann", uuid(), 100); // a new capture after acceptance: refused, shows the accepted result
    assert.equal(b2.status, "already_submitted");
    assert.equal(b2.elapsedMs, 2000);
    assert.equal(await count("public.submissions where round_id=$1 and player_id=$2", [g.round, g.ids.Ann]), 1);
    assert.equal((await submission(g, "Ann")).claimed_elapsed_ms, 2000, "the accepted timing never changes");
  });

  it("complete without a begin, or with someone else's attempt id, is refused", async () => {
    const g = await activeGame();
    assert.match((await errorOf(complete(g, "Ann", uuid()))) ?? "", /no_intent/);
    const a = uuid();
    await begin(g, "Ann", a, 500);
    assert.match((await errorOf(complete(g, "Bo", a))) ?? "", /no_intent/, "Bo cannot finish Ann's capture");
    assert.equal(await count("public.submissions where round_id=$1", [g.round]), 0);
  });

  it("each player's photo path is derived from their own verified identity (cannot overwrite another's)", async () => {
    const g = await activeGame();
    await startedAgo(g, 1040);
    for (const who of ["Ann", "Bo"]) { const a = uuid(); await begin(g, who, a, 1000); await complete(g, who, a); }
    const paths = (await db.query<{ p: string }>("select storage_path p from public.submissions where round_id=$1 order by storage_path", [g.round])).rows.map((r) => r.p);
    assert.equal(new Set(paths).size, 2);
    assert.ok(paths.includes(`${g.id}/${g.round}/${g.ids.Ann}.jpg`) && paths.includes(`${g.id}/${g.round}/${g.ids.Bo}.jpg`));
  });

  it("interrupted upload: the same attempt may retry inside the window, then must start over", async () => {
    const g = await activeGame();
    const a = uuid();
    await begin(g, "Ann", a, 800);
    assert.equal((await begin(g, "Ann", a, 800)).status, "resumed", "retry #1 after a dropped connection");
    assert.equal((await begin(g, "Ann", a, 800)).status, "resumed", "retry #2");
    await db.query("update public.submission_intents set intent_at = clock_timestamp() - interval '60 seconds' where round_id=$1", [g.round]);
    assert.match((await errorOf(complete(g, "Ann", a))) ?? "", /attempt_expired/, "too late: this capture can no longer be accepted");
    assert.match((await errorOf(begin(g, "Ann", a, 800))) ?? "", /attempt_expired/);
    const fresh = uuid();
    assert.equal((await begin(g, "Ann", fresh, 61000)).status, "ready", "a new capture is allowed (and gets new timing)");
    assert.equal((await complete(g, "Ann", fresh)).status, "accepted");
  });

  it("slow network: a slow upload is accepted but marked upload_slow", async () => {
    const g = await activeGame();
    await startedAgo(g, 1040);
    const a = uuid();
    await begin(g, "Ann", a, 1000);
    await db.query("update public.submission_intents set intent_at = clock_timestamp() - interval '25 seconds' where round_id=$1", [g.round]);
    await startedAgo(g, 26040);
    const r = await complete(g, "Ann", a);
    assert.equal(r.status, "accepted");
    assert.ok((r.flags as string[]).includes("upload_slow"));
  });
});

describe("round state rules", () => {
  it("refuses before the official start, after the time limit, outside the active phase", async () => {
    const g = await activeGame();
    await db.query("update public.game_rounds set opened_at = clock_timestamp() + interval '2 seconds' where id=$1", [g.round]);
    assert.match((await errorOf(begin(g, "Ann", uuid(), 0))) ?? "", /round_not_started/);
    await startedAgo(g, 70_000); // default limit is 60 s (+2 s grace)
    assert.match((await errorOf(begin(g, "Ann", uuid(), 1000))) ?? "", /round_closed/);

    const waiting = await activeGame();
    await act(waiting, "close_submissions");
    assert.match((await errorOf(begin(waiting, "Ann", uuid(), 100))) ?? "", /round_not_open/);
  });

  it("only the CURRENT round of the player's own game accepts submissions", async () => {
    const g = await activeGame();
    const g2 = await activeGame(other, ["Zed"]);
    const stolen = { ...g2, tokens: g.tokens, ids: g.ids } as G; // Ann's token, but pointing at another game's round
    assert.match((await errorOf(begin(stolen, "Ann", uuid(), 100))) ?? "", /round_not_open/);
    assert.equal(await count("public.submission_intents where round_id=$1", [g2.round]), 0);
  });

  it("a tap before the host closed submissions still counts when its upload lands later (straggler)…", async () => {
    const g = await activeGame();
    await startedAgo(g, 1040);
    const a = uuid();
    await begin(g, "Ann", a, 1000);
    await act(g, "close_submissions");
    await act(g, "move_to_review");
    assert.equal((await complete(g, "Ann", a)).status, "accepted");
  });

  it("…but not once the winner has been announced, and not for a tap after the close", async () => {
    const g = await activeGame();
    await startedAgo(g, 1040);
    const a = uuid();
    await begin(g, "Ann", a, 1000);
    await act(g, "close_submissions"); await act(g, "move_to_review"); await act(g, "announce_winner");
    assert.match((await errorOf(complete(g, "Ann", a))) ?? "", /round_not_open/);

    const h = await activeGame();
    await act(h, "close_submissions");
    // Explicitly AFTER the close: in a fast in-memory DB a default now() can tie with closed_at,
    // and a tap at the exact close instant counts by design (intent_at <= closed_at).
    await db.query("insert into public.submission_intents (game_id, round_id, player_id, attempt_id, claimed_elapsed_ms, intent_at) select $1,$2,$3,gen_random_uuid(),1, closed_at + interval '1 millisecond' from public.game_rounds where id=$2", [h.id, h.round, h.ids.Ann]);
    assert.match((await errorOf(db.query("insert into public.submissions (game_id, round_id, player_id, storage_path) values ($1,$2,$3,$4)", [h.id, h.round, h.ids.Ann, `${h.id}/${h.round}/${h.ids.Ann}.jpg`]))) ?? "", /round_not_open/, "the DB trigger is the backstop");
  });

  it("removed players and invalid sessions cannot submit", async () => {
    const g = await activeGame();
    await as(db, user(host), () => db.query("update public.players set kicked_at=now() where id=$1", [g.ids.Cy]));
    assert.match((await errorOf(begin(g, "Cy", uuid(), 100))) ?? "", /player_removed/);
    const ghost = { ...g, tokens: { Ghost: generatePlayerToken() } } as unknown as G;
    assert.match((await errorOf(begin(ghost, "Ghost", uuid(), 100))) ?? "", /invalid_session/);
  });
});

describe("access control", () => {
  it("guests and hosts cannot call the submission functions or read intents", async () => {
    const g = await activeGame();
    for (const actor of [{ role: "anon" } as const, user(host)]) {
      for (const sql of [
        "select public.begin_submission('a', gen_random_uuid(), gen_random_uuid(), 1, '{}')",
        "select public.complete_submission('a', gen_random_uuid(), gen_random_uuid(), '{}')",
        "select * from public.submission_intents",
      ]) assert.match((await errorOf(as(db, actor, () => db.query(sql)))) ?? "", /permission denied/i, sql);
    }
    assert.ok(g);
  });

  it("only the owning host can read submissions and rankings; another host sees nothing", async () => {
    const g = await activeGame();
    await startedAgo(g, 1040);
    const a = uuid(); await begin(g, "Ann", a, 1000); await complete(g, "Ann", a);
    const mine = await as(db, user(host), () => db.query("select * from public.round_ranking($1)", [g.round]));
    assert.equal(mine.rows.length, 1);
    const theirs = await as(db, user(other), () => db.query("select * from public.round_ranking($1)", [g.round]));
    assert.equal(theirs.rows.length, 0);
    assert.match((await errorOf(as(db, { role: "anon" }, () => db.query("select * from public.round_ranking($1)", [g.round])))) ?? "", /permission denied/i);
  });
});

describe("ranking policy and near ties", () => {
  async function rankedRound(entries: { who: string; elapsed: number; startedAgo?: number }[]) {
    const g = await activeGame(host, entries.map((e) => e.who));
    for (const e of entries) {
      await startedAgo(g, (e.startedAgo ?? e.elapsed) + 40);
      const a = uuid();
      await begin(g, e.who, a, e.elapsed);
      await complete(g, e.who, a);
    }
    return g;
  }
  const ranking = async (g: G) => (await as(db, user(host), () => db.query<{ rank: number; nickname: string; rank_ms: number; near_tie: boolean; timing_status: string }>("select * from public.round_ranking($1)", [g.round]))).rows;

  it("orders by rank_ms and marks results closer than 150 ms as near ties", async () => {
    const g = await rankedRound([{ who: "Cy", elapsed: 5000 }, { who: "Ann", elapsed: 3000 }, { who: "Bo", elapsed: 3080 }]);
    const r = await ranking(g);
    assert.deepEqual(r.map((x) => [x.rank, x.nickname]), [[1, "Ann"], [2, "Bo"], [3, "Cy"]]);
    assert.deepEqual(r.map((x) => x.near_tie), [true, true, false], "Ann/Bo are 80 ms apart: too close to call by the clock");
  });

  it("results more than 150 ms apart are not near ties", async () => {
    const g = await rankedRound([{ who: "Ann", elapsed: 3000 }, { who: "Bo", elapsed: 3400 }]);
    assert.deepEqual((await ranking(g)).map((x) => x.near_tie), [false, false]);
  });

  it("a flagged submission ranks by the server's observation, not its claim", async () => {
    const g = await rankedRound([
      { who: "Ann", elapsed: 4000 },
      { who: "Bo", elapsed: 1000, startedAgo: 9000 }, // claims 1.0 s but the server only heard at 9 s
    ]);
    const r = await ranking(g);
    assert.deepEqual(r.map((x) => x.nickname), ["Ann", "Bo"], "the cheater's fake lead is gone");
    assert.equal(r[1].timing_status, "flagged");
    assert.ok(r[1].rank_ms > 8000);
  });

  it("exact ties are broken deterministically: server-observed time, then arrival order", async () => {
    const g = await activeGame(host, ["Ann", "Bo"]);
    await startedAgo(g, 2040);
    const a = uuid(), b = uuid();
    await begin(g, "Bo", b, 2000);
    await new Promise((r) => setTimeout(r, 20));
    await begin(g, "Ann", a, 2000);
    await complete(g, "Ann", a); await complete(g, "Bo", b);
    const r = await ranking(g);
    assert.equal(r[0].nickname, "Bo", "Bo's tap reached the server first");
    assert.ok(r.every((x) => x.near_tie));
  });
});

describe("snapshots and notifications", () => {
  it("players see their own result after a refresh; the host sees the submission count; completion notifies via the version", async () => {
    const g = await activeGame();
    await startedAgo(g, 1040);
    const v0 = await version(g.id);
    const a = uuid(); await begin(g, "Ann", a, 1000); await complete(g, "Ann", a);
    assert.ok((await version(g.id)) > v0, "state_version bumped so Realtime hints and re-reads happen");
    const mine = (await as(db, svc, () => db.query<{ s: { me: { hasSubmitted: boolean; submission: { elapsedMs: number } | null }; submissionCount: number } }>("select public.player_game_state($1) as s", [hashToken(g.tokens.Ann)]))).rows[0].s;
    assert.equal(mine.me.hasSubmitted, true);
    assert.equal(mine.me.submission?.elapsedMs, 1000);
    const bo = (await as(db, svc, () => db.query<{ s: { me: { hasSubmitted: boolean } } }>("select public.player_game_state($1) as s", [hashToken(g.tokens.Bo)]))).rows[0].s;
    assert.equal(bo.me.hasSubmitted, false);
    const hostView = (await as(db, user(host), () => db.query<{ s: { submissionCount: number; round: { id: string } } }>("select public.host_game_state($1) as s", [g.id]))).rows[0].s;
    assert.equal(hostView.submissionCount, 1);
    assert.equal(hostView.round.id, g.round);
    // Phase 2: a submission is host-only news, so its hint goes to the owner-only topic, never to players
    const hints = await db.query<{ payload: { version: number; scope: string } }>("select payload from realtime.messages where topic = $1 order by id desc limit 1", [`game:${g.id}:host`]);
    assert.equal(hints.rows[0].payload.version, await version(g.id));
    assert.equal(hints.rows[0].payload.scope, "host");
  });
});

describe("tolerance of the server cross-check", () => {
  it("a lead of up to 1 s over the server's observation is tolerated (soft warning above 400 ms); more is flagged", async () => {
    const run = async (leadMs: number) => {
      const g = await activeGame(host, ["Ann"]);
      await startedAgo(g, 5000 + leadMs); // the server hears the tap at 5 s + lead
      const a = uuid();
      await begin(g, "Ann", a, 5000); // the client claims exactly 5.000 s
      return complete(g, "Ann", a);
    };
    const ok = await run(200);
    assert.equal(ok.timing, "consistent");
    assert.ok(!(ok.flags as string[]).includes("intent_lag_elevated"));
    const warn = await run(700);
    assert.equal(warn.timing, "consistent");
    assert.ok((warn.flags as string[]).includes("intent_lag_elevated"));
    const bad = await run(1300);
    assert.equal(bad.timing, "flagged");
    assert.ok((bad.flags as string[]).includes("intent_lag_high"));
  });
});
