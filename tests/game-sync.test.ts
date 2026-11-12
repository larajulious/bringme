import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { GameSyncCore, clockOffset, msUntil, secondsUntil, type FetchResult } from "../lib/game/sync.ts";
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
