import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { FALLBACK_GRACE_MS, FALLBACK_POLL_MS, GameSyncCore, SAFETY_RESYNC_MS, clockOffset, combineRealtime, fallbackPlan, guestRoute, msUntil, routeEverything, scopeOf, secondsUntil, type FetchResult, type RoutePolicy } from "../lib/game/sync.ts";
import { rosterKey, roundsKey, submissionsKey } from "../lib/game/refresh-keys.ts";
import { guestChannelClaims, signHs256 } from "../lib/game/jwt.ts";

type S = { version: number; label: string };
const tick = () => new Promise((r) => setTimeout(r, 0));

function harness(initial: S | null, responses: (() => Promise<FetchResult<S>>)[]) {
  const applied: S[] = [];
  let calls = 0;
  const events = { unauthorized: 0, errors: 0 };
  const core = new GameSyncCore<S>({
    initial,
    fetch: () => responses[Math.min(calls++, responses.length - 1)](),
    onState: (s) => applied.push(s),
    onUnauthorized: () => events.unauthorized++,
    onFetchError: () => events.errors++,
  });
  return { core, applied, events, calls: () => calls };
}
const ok = (version: number, label = `v${version}`): (() => Promise<FetchResult<S>>) => async () => ({ status: "ok", state: { version, label } });
const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => (resolve = r)); return { promise, resolve }; };

describe("GameSyncCore: ordering", () => {
  it("never lets an older snapshot overwrite a newer one", () => {
    const { core, applied } = harness({ version: 5, label: "v5" }, []);
    assert.equal(core.applyIfNewer({ version: 4, label: "late" }), false);
    assert.equal(core.applyIfNewer({ version: 5, label: "dup" }), false);
    assert.equal(core.applyIfNewer({ version: 6, label: "new" }), true);
    assert.equal(core.applyIfNewer({ version: 3, label: "very late" }), false);
    assert.deepEqual(applied.map((s) => s.label), ["new"]);
    assert.equal(core.version, 6);
  });

  it("drops a delayed broadcast for a version it already has, and fetches for a newer one", async () => {
    const h = harness({ version: 10, label: "v10" }, [ok(11)]);
    h.core.handleSignal({ version: 9 });
    h.core.handleSignal({ version: 10 });
    await tick();
    assert.equal(h.calls(), 0, "stale or duplicate events cost nothing");
    h.core.handleSignal({ version: 11 });
    await tick();
    assert.equal(h.calls(), 1);
    assert.equal(h.core.version, 11);
  });

  it("a slow response that resolves after a newer event was applied is discarded", async () => {
    const slow = deferred<FetchResult<S>>();
    const h = harness({ version: 1, label: "v1" }, [() => slow.promise]);
    const pending = h.core.resync(); // request for "v2" is in flight
    h.core.applyIfNewer({ version: 3, label: "v3" }); // meanwhile a newer action response lands
    slow.resolve({ status: "ok", state: { version: 2, label: "v2" } }); // the older response arrives late
    await pending;
    assert.equal(h.core.version, 3);
    assert.deepEqual(h.applied.map((s) => s.label), ["v3"]);
  });

  it("accepts an equal-version fetch (time moved: the item is revealed at the official start)", async () => {
    const h = harness({ version: 7, label: "no prompt" }, [ok(7, "with prompt")]);
    await h.core.resync();
    assert.deepEqual(h.applied.map((s) => s.label), ["with prompt"]);
  });

  it("a fetch older than the current state is ignored", async () => {
    const h = harness({ version: 9, label: "v9" }, [ok(8)]);
    await h.core.resync();
    assert.equal(h.applied.length, 0);
    assert.equal(h.core.version, 9);
  });
});

describe("GameSyncCore: resilience", () => {
  it("coalesces a burst of signals into at most one in-flight request plus one follow-up", async () => {
    const gate = deferred<FetchResult<S>>();
    let n = 0;
    const h = harness({ version: 0, label: "v0" }, [() => (n++ === 0 ? gate.promise : ok(2)())]);
    for (let i = 1; i <= 25; i++) h.core.handleSignal({ version: i });
    assert.equal(h.calls(), 1, "only one request while one is in flight");
    gate.resolve({ status: "ok", state: { version: 1, label: "v1" } });
    await h.core.resync();
    await tick();
    assert.ok(h.calls() <= 3, `25 events produced ${h.calls()} requests`);
    assert.equal(h.core.version, 2);
  });

  it("reconnect = resync: after the channel drops and returns, the state catches up on everything missed", async () => {
    const h = harness({ version: 4, label: "v4" }, [ok(9)]);
    // (the hook calls resync() on every SUBSCRIBED, including re-subscribes)
    await h.core.resync();
    assert.equal(h.core.version, 9);
  });

  it("a failed fetch reports the error and recovers on the next attempt", async () => {
    const h = harness({ version: 1, label: "v1" }, [async () => ({ status: "error" }), ok(2)]);
    await h.core.resync();
    assert.equal(h.events.errors, 1);
    assert.equal(h.core.version, 1);
    await h.core.resync();
    assert.equal(h.core.version, 2);
  });

  it("a thrown fetch is treated as an error, not a crash", async () => {
    const h = harness({ version: 1, label: "v1" }, [async () => { throw new Error("network"); }]);
    await h.core.resync();
    assert.equal(h.events.errors, 1);
  });

  it("an unauthorized response stops syncing for good (expired or removed session)", async () => {
    const h = harness({ version: 1, label: "v1" }, [async () => ({ status: "unauthorized" }), ok(5)]);
    await h.core.resync();
    assert.equal(h.events.unauthorized, 1);
    await h.core.resync();
    h.core.handleSignal({ version: 99 });
    assert.equal(h.calls(), 1, "no further requests");
    assert.equal(h.core.applyIfNewer({ version: 50, label: "x" }), false);
  });

  it("stop() ends everything", async () => {
    const h = harness(null, [ok(1)]);
    h.core.stop();
    await h.core.resync();
    assert.equal(h.calls(), 0);
  });

  it("starts from no state and accepts the first snapshot", async () => {
    const h = harness(null, [ok(0)]);
    await h.core.resync();
    assert.equal(h.core.version, 0);
  });
});

describe("clock helpers (server-generated timestamps)", () => {
  it("estimates the client→server offset from the request midpoint", () => {
    // server says 12:00:10.000 while the client's request spanned 12:00:00.000..12:00:00.200 (client clock 10s behind)
    const t0 = Date.parse("2026-01-01T12:00:00.000Z");
    assert.equal(clockOffset("2026-01-01T12:00:10.100Z", t0, t0 + 200), 10_000);
    assert.equal(clockOffset("garbage", 0, 0), 0);
  });
  it("countdown seconds are computed against the corrected server clock", () => {
    const end = "2026-01-01T12:00:03.000Z";
    const t = Date.parse("2026-01-01T12:00:00.000Z");
    assert.equal(secondsUntil(end, t, 0), 3);
    assert.equal(secondsUntil(end, t + 1100, 0), 2);
    assert.equal(secondsUntil(end, t + 2050, 0), 1);
    assert.equal(secondsUntil(end, t + 3000, 0), 0);
    assert.equal(secondsUntil(end, t + 9000, 0), 0, "never negative");
    // a phone whose clock is 5s fast still shows 3 when it applies its offset
    assert.equal(secondsUntil(end, t + 5000, -5000), 3);
    assert.equal(secondsUntil(null, t, 0), 0);
  });
  it("msUntil gives the wait until the official round start", () => {
    const t = Date.parse("2026-01-01T12:00:00.000Z");
    assert.equal(msUntil("2026-01-01T12:00:02.500Z", t, 0), 2500);
    assert.ok((msUntil("2026-01-01T11:59:59.000Z", t, 0) ?? 0) < 0);
    assert.equal(msUntil(null, t, 0), null);
  });
});

describe("guest channel token", () => {
  const secret = "test-secret";
  const claims = guestChannelClaims({ playerId: "11111111-1111-4111-8111-111111111111", gameId: "22222222-2222-4222-8222-222222222222", nowSeconds: 1_700_000_000 });
  const jwt = signHs256(claims, secret);
  const [h, b, sig] = jwt.split(".");

  it("is a valid HS256 JWT that verifies with the secret and fails with another", () => {
    assert.deepEqual(JSON.parse(Buffer.from(h, "base64url").toString()), { alg: "HS256", typ: "JWT" });
    assert.equal(sig, createHmac("sha256", secret).update(`${h}.${b}`).digest("base64url"));
    assert.notEqual(sig, createHmac("sha256", "other").update(`${h}.${b}`).digest("base64url"));
  });
  it("carries only what the channel policy needs: anon role, guest kind, ONE game, short expiry", () => {
    const c = JSON.parse(Buffer.from(b, "base64url").toString());
    assert.equal(c.role, "anon", "no database privileges");
    assert.equal(c.kind, "guest");
    assert.equal(c.game_id, "22222222-2222-4222-8222-222222222222");
    assert.equal(c.exp - c.iat, 3600);
    assert.ok(!("email" in c) && !("token_hash" in c));
  });
});

// ------------------------------------------------------------------ Phase 2: audience-aware hints ----

type P = S & { claims?: number };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A guest core whose fetch returns whatever `server.version` is at that moment (like the real snapshot). */
function guest(start: number, opts: { route?: RoutePolicy<P>; debounceMs?: number; claims?: number } = {}) {
  const server = { version: start, claims: opts.claims ?? 0 };
  let fetches = 0;
  const applied: number[] = [];
  const core = new GameSyncCore<P>({
    initial: { version: start, label: "init", claims: server.claims },
    fetch: async () => { fetches++; return { status: "ok", state: { version: server.version, label: `v${server.version}`, claims: server.claims } }; },
    onState: (s) => applied.push(s.version),
    onUnauthorized: () => undefined,
    route: opts.route ?? guestRoute<P>((s) => (s.claims ?? 0) > 0),
    debounce: { baseMs: opts.debounceMs ?? 20, jitterMs: 0 },
  });
  return { core, server, applied, fetches: () => fetches };
}
const hint = (version: number, scope?: string) => (scope ? { version, phase: "active", scope } : { version, phase: "active" });

describe("Phase 2: scopes and routing", () => {
  it("scopeOf: missing or unknown scope (older database) means 'all'; the host topic is always 'host'", () => {
    assert.equal(scopeOf({ version: 1 }), "all");
    assert.equal(scopeOf({ version: 1, scope: "weird" }), "all");
    assert.equal(scopeOf(null), "all");
    assert.equal(scopeOf({ version: 1, scope: "roster" }), "roster");
    assert.equal(scopeOf({ version: 1, scope: "all" }, "host"), "host");
  });

  it("guest policy: all -> now, roster -> debounce, host -> skip, claims -> only when relevant; hosts take everything", () => {
    const r = guestRoute<{ c: boolean }>((s) => s.c);
    assert.deepEqual(["all", "roster", "host"].map((x) => r(x as never, { c: false })), ["now", "debounce", "skip"]);
    assert.equal(r("claims", { c: true }), "now");
    assert.equal(r("claims", { c: false }), "skip");
    assert.equal(r("claims", null), "skip");
    assert.equal(guestRoute()("claims", {}), "skip", "no predicate (Bring Me): never relevant");
    for (const s of ["all", "roster", "claims", "host"] as const) assert.equal(routeEverything(s, null), "now");
  });

  for (const n of [10, 30, 50]) {
    it(`${n} host-only hints cost a player NOTHING, and the next 'all' hint still brings the latest state`, async () => {
      const g = guest(5);
      for (let i = 1; i <= n; i++) { g.server.version = 5 + i; g.core.handleSignal(hint(5 + i), "host"); g.core.handleSignal(hint(5 + i, "host")); }
      await sleep(5);
      assert.equal(g.fetches(), 0);
      assert.equal(g.core.stats.skipped, 2 * n);
      g.server.version = 6 + n;
      g.core.handleSignal(hint(6 + n, "all"));   // e.g. 'close submissions'
      await sleep(5);
      assert.equal(g.fetches(), 1);
      assert.equal(g.core.version, 6 + n, "the snapshot includes every skipped change");
    });
  }

  it("skipped versions never block a later relevant hint (no 'consumed' version)", async () => {
    const g = guest(1);
    g.core.handleSignal(hint(2, "host")); g.core.handleSignal(hint(3, "host"));
    g.server.version = 4;
    g.core.handleSignal(hint(4, "all"));
    await sleep(5);
    assert.deepEqual(g.applied, [4]);
  });

  it("out-of-order hints: a late older hint after a newer snapshot costs nothing", async () => {
    const g = guest(1);
    g.server.version = 9;
    g.core.handleSignal(hint(9, "all"));
    await sleep(5);
    for (const v of [7, 8, 9]) { g.core.handleSignal(hint(v, "all")); g.core.handleSignal(hint(v, "roster")); }
    await sleep(40);
    assert.equal(g.fetches(), 1);
    assert.equal(g.core.stats.stale, 6);
    assert.equal(g.core.version, 9);
  });

  it("reconnect after many missed hints: the re-read on SUBSCRIBED brings the latest state and cancels a pending delayed read", async () => {
    const g = guest(3, { debounceMs: 30 });
    g.core.handleSignal(hint(4, "roster"));   // delayed read scheduled…
    g.server.version = 17;                   // …then the socket dropped and 13 hints were missed
    await g.core.resync();                   // what useGameSync does on SUBSCRIBED
    assert.equal(g.core.version, 17);
    await sleep(60);
    assert.equal(g.fetches(), 1, "the delayed read was dropped: we already hold a newer snapshot");
  });

  it("join hints: 30 in a burst cause ONE delayed read, which gets the final headcount", async () => {
    const g = guest(10, { debounceMs: 25 });
    for (let i = 1; i <= 30; i++) { g.server.version = 10 + i; g.core.handleSignal(hint(10 + i, "roster")); }
    assert.equal(g.fetches(), 0, "nothing immediate");
    await sleep(60);
    assert.equal(g.fetches(), 1);
    assert.equal(g.core.version, 40);
  });

  it("the delay is bounded: hints arriving later don't postpone the read", async () => {
    const g = guest(1, { debounceMs: 30 });
    g.core.handleSignal(hint(2, "roster"));
    await sleep(15); g.server.version = 3; g.core.handleSignal(hint(3, "roster"));
    await sleep(25);
    assert.equal(g.fetches(), 1, "read at ~30 ms after the FIRST hint");
    assert.equal(g.core.version, 3);
  });

  it("a phase change during a pending join delay is applied at once, and the delayed read is then dropped", async () => {
    const g = guest(1, { debounceMs: 40 });
    g.core.handleSignal(hint(2, "roster"));
    g.server.version = 3;
    g.core.handleSignal(hint(3, "all"));   // host pressed Start
    await sleep(5);
    assert.equal(g.core.version, 3);
    await sleep(60);
    assert.equal(g.fetches(), 1);
  });

  it("a delayed read still happens if the immediate snapshot was older than the join it waits for", async () => {
    const g = guest(1, { debounceMs: 30 });
    g.server.version = 2;
    const pending = g.core.resync();          // in flight, will return v2
    g.core.handleSignal(hint(3, "roster"));    // a join committed meanwhile
    await pending;
    g.server.version = 3;
    await sleep(60);
    assert.equal(g.core.version, 3);
  });

  it("a removal (scope 'all') during gameplay is applied at once", async () => {
    const g = guest(20);
    g.server.version = 21;
    g.core.handleSignal(hint(21, "all"));
    await sleep(5);
    assert.deepEqual(g.applied, [21]);
  });

  it("claim reviews: only a player holding a claim re-reads", async () => {
    const none = guest(5, { claims: 0 });
    const mine = guest(5, { claims: 1 });
    for (const g of [none, mine]) { g.server.version = 6; g.core.handleSignal(hint(6, "claims")); }
    await sleep(5);
    assert.deepEqual([none.fetches(), mine.fetches()], [0, 1]);
  });

  it("a legacy hint without a scope (database not migrated yet) still makes players re-read", async () => {
    const g = guest(1);
    g.server.version = 2;
    g.core.handleSignal({ version: 2, phase: "lobby" });
    await sleep(5);
    assert.equal(g.fetches(), 1);
  });

  it("hosts re-read on every newer hint, from either topic", async () => {
    const h = guest(1, { route: routeEverything as RoutePolicy<P> });
    h.server.version = 2; h.core.handleSignal(hint(2), "host");
    await sleep(5);
    h.server.version = 3; h.core.handleSignal(hint(3, "roster"));
    await sleep(5);
    assert.equal(h.fetches(), 2);
  });

  it("stop() cancels a pending delayed read", async () => {
    const g = guest(1, { debounceMs: 20 });
    g.core.handleSignal(hint(2, "roster"));
    g.core.stop();
    await sleep(40);
    assert.equal(g.fetches(), 0);
  });
});

describe("Phase 2: Realtime health and fallback", () => {
  it("a host relies on hints only when BOTH topics are subscribed; either one down means polling", () => {
    assert.equal(combineRealtime("subscribed"), "subscribed");
    assert.equal(combineRealtime("subscribed", "subscribed"), "subscribed");
    assert.equal(combineRealtime("subscribed", "down"), "down", "host topic refused (e.g. older database) -> basic mode");
    assert.equal(combineRealtime("down", "subscribed"), "down");
    assert.equal(combineRealtime("subscribed", "connecting"), "connecting");
  });

  it("fallback plan is unchanged: 30 s safety while subscribed, 4 s polling (after a 6 s grace while connecting, at once when down)", () => {
    assert.deepEqual(fallbackPlan("subscribed"), { everyMs: SAFETY_RESYNC_MS, startAfterMs: 0 });
    assert.deepEqual(fallbackPlan("connecting"), { everyMs: FALLBACK_POLL_MS, startAfterMs: FALLBACK_GRACE_MS });
    assert.deepEqual(fallbackPlan("down"), { everyMs: FALLBACK_POLL_MS, startAfterMs: 0 });
    assert.deepEqual([SAFETY_RESYNC_MS, FALLBACK_POLL_MS, FALLBACK_GRACE_MS], [30_000, 4_000, 6_000]);
  });

  it("while Realtime is down, polling alone keeps a player correct (no hints at all)", async () => {
    const g = guest(1);
    for (let v = 2; v <= 6; v++) { g.server.version = v; await g.core.resync(); }   // each 4 s tick
    assert.deepEqual(g.applied, [2, 3, 4, 5, 6]);
  });
});

describe("Phase 2: host side-list refresh keys", () => {
  const base = { version: 7, status: "live" as const, phase: "active" as const, totalRounds: 3, roundsRemaining: 2,
    round: { id: "r1", status: "open" as const, winnerPlayerId: null, decided: false } as never, rosterKey: "R", submissionsKey: "S" };
  it("without database fingerprints every key follows the version (pre-Phase-2 behaviour)", () => {
    const old = { ...base, rosterKey: undefined, submissionsKey: undefined };
    assert.equal(rosterKey(old), "v7");
    assert.equal(submissionsKey(old), "v7");
  });
  it("a photo (new submissionsKey, new version) changes only the submissions key", () => {
    const next = { ...base, version: 8, submissionsKey: "S2" };
    assert.equal(rosterKey(next), rosterKey(base));
    assert.equal(roundsKey(next), roundsKey(base));
    assert.notEqual(submissionsKey(next), submissionsKey(base));
  });
  it("a join changes only the roster key; closing the round changes rounds and submissions keys", () => {
    assert.notEqual(rosterKey({ ...base, rosterKey: "R2" }), rosterKey(base));
    const closed = { ...base, round: { id: "r1", status: "closed" as const, winnerPlayerId: null, decided: false } as never, phase: "reviewing" as const };
    assert.notEqual(roundsKey(closed), roundsKey(base));
    assert.notEqual(submissionsKey(closed), submissionsKey(base));
    assert.equal(rosterKey(closed), rosterKey(base));
  });
  it("an official winner changes the submissions key (the presenter shows the winner's photo)", () => {
    const won = { ...base, round: { id: "r1", status: "closed" as const, winnerPlayerId: "p", decided: true } as never };
    assert.notEqual(submissionsKey(won), submissionsKey(base));
  });
});
