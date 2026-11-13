import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { classifyCameraError, fitWithin, openCamera } from "../lib/game/camera.ts";
import { ClockSync } from "../lib/game/clock.ts";
import { SubmissionFlow, SubmitError, type BeginResult, type FlowState, type SubmitDeps } from "../lib/game/submit-flow.ts";
import { formatElapsed, parseElapsedMs, sanitizeClientMeta } from "../lib/game/timing.ts";

describe("formatElapsed (SS.mmm)", () => {
  it("formats seconds with zero-padded milliseconds", () => {
    assert.equal(formatElapsed(0), "00.000");
    assert.equal(formatElapsed(7412), "07.412");
    assert.equal(formatElapsed(59999), "59.999");
    assert.equal(formatElapsed(5), "00.005");
    assert.equal(formatElapsed(12345.6), "12.346");
  });
  it("switches to M:SS.mmm past a minute and handles negatives and junk", () => {
    assert.equal(formatElapsed(60000), "1:00.000");
    assert.equal(formatElapsed(125007), "2:05.007");
    assert.equal(formatElapsed(-1500), "-01.500");
    assert.equal(formatElapsed(NaN), "--.---");
  });
  it("parseElapsedMs accepts only sane integers", () => {
    assert.equal(parseElapsedMs(1234), 1234);
    for (const bad of [1.5, "5", null, NaN, 8_000_000, -61_000]) assert.equal(parseElapsedMs(bad), null);
  });
});

describe("sanitizeClientMeta", () => {
  it("keeps only whitelisted, well-typed fields", () => {
    const m = sanitizeClientMeta({ syncRttMs: 42.1234, camera: "environment", evil: "<script>", visibility: "weird", bytes: "10", uploadMs: 300, __proto__: { x: 1 } });
    assert.deepEqual(m, { syncRttMs: 42.123, camera: "environment", uploadMs: 300 });
  });
  it("rejects non-objects, infinities and oversize payloads", () => {
    assert.deepEqual(sanitizeClientMeta(null), {});
    assert.deepEqual(sanitizeClientMeta([1, 2]), {});
    assert.deepEqual(sanitizeClientMeta({ syncRttMs: Infinity, uploadMs: 1e20 }), {});
  });
});

describe("ClockSync (monotonic offset estimation)", () => {
  it("projects the server clock forward using only monotonic deltas", () => {
    const c = new ClockSync();
    // request spanned mono 1000..1100, server clock read 5_000_050 (its midpoint)
    c.addSample(5_000_050, 1000, 1100);
    assert.equal(c.serverNow(1050), 5_000_050);
    assert.equal(c.serverNow(2050), 5_001_050, "1 s of monotonic time = 1 s of server time");
    assert.equal(c.elapsedSince(5_000_000, 1550), 550);
  });

  it("is immune to wall-clock jumps after the sample (it never reads Date.now())", () => {
    const c = new ClockSync();
    c.addSample(10_000, 500, 540);
    const before = c.serverNow(2000);
    // simulate the device clock being changed by an hour: nothing in ClockSync can notice
    const realNow = Date.now;
    Date.now = () => realNow() + 3_600_000;
    try { assert.equal(c.serverNow(2000), before); } finally { Date.now = realNow; }
  });

  it("prefers the lowest-RTT fresh sample and drops stale ones", () => {
    const c = new ClockSync();
    c.addSample(1_000_000, 0, 400); // rtt 400
    c.addSample(1_000_700, 700, 740); // rtt 40, consistent with the first projected
    assert.equal(c.best(800)?.rttMs, 40);
    assert.equal(c.quality(800)?.syncRttMs, 40);
    // 3 minutes later every sample is stale: falls back to the most recent one rather than nothing
    assert.equal(c.best(200_000)?.rttMs, 40);
  });

  it("reports uncertainty = RTT/2 + drift allowance and rejects bad samples", () => {
    const c = new ClockSync();
    assert.equal(c.serverNow(1), null);
    assert.equal(c.quality(1), null);
    assert.equal(c.addSample(NaN, 0, 1), null);
    assert.equal(c.addSample(1, 10, 5), null, "response before request");
    c.addSample(1_000, 0, 100);
    const q = c.quality(10_050)!; // 10 s later
    assert.equal(q.syncRttMs, 100);
    assert.equal(q.syncAgeMs, 10_000);
    assert.equal(q.syncUncertaintyMs, 50 + 1 /* 10 s × 50 ppm = 0.5 ms → rounded */);
  });

  it("an asymmetric path shifts the estimate by at most RTT/2 (the documented limit)", () => {
    // truth: server reads its clock right when the request ARRIVES (worst case = t0 + rtt), estimate uses the midpoint
    const c = new ClockSync();
    const rtt = 200, t0 = 0, trueServerAtT0 = 1_000_000;
    const serverReading = trueServerAtT0 + rtt; // all the latency was on the way up
    c.addSample(serverReading, t0, t0 + rtt);
    const estimate = c.serverNow(t0)!; // estimate of server time at t0
    assert.ok(Math.abs(estimate - trueServerAtT0) <= rtt / 2 + rtt / 2, `error ${estimate - trueServerAtT0}ms must stay within RTT`);
    assert.equal(Math.abs(estimate - trueServerAtT0), rtt / 2);
  });
});

describe("camera permission and device handling", () => {
  const stream = (facingMode?: string) => ({ getVideoTracks: () => [{ getSettings: () => ({ facingMode }) }] }) as unknown as MediaStream;
  const err = (name: string) => Object.assign(new Error(name), { name });

  it("classifies the errors browsers actually throw", () => {
    assert.equal(classifyCameraError(err("NotAllowedError")), "denied");
    assert.equal(classifyCameraError(err("PermissionDeniedError")), "denied");
    assert.equal(classifyCameraError(err("NotFoundError")), "no_camera");
    assert.equal(classifyCameraError(err("NotReadableError")), "busy");
    assert.equal(classifyCameraError(err("SecurityError")), "insecure");
    assert.equal(classifyCameraError(err("TypeError")), "unsupported");
    assert.equal(classifyCameraError(err("NotSupportedError")), "unsupported");
    assert.equal(classifyCameraError(new Error("weird")), "unknown");
    assert.equal(classifyCameraError(null), "unknown");
  });

  it("prefers the rear camera", async () => {
    let asked: MediaStreamConstraints | undefined;
    const r = await openCamera({ getUserMedia: async (c) => { asked = c; return stream("environment"); } }, true);
    assert.deepEqual([r.ok, r.ok && r.facing], [true, "environment"]);
    assert.deepEqual((asked!.video as MediaTrackConstraints).facingMode, { ideal: "environment" });
    assert.equal(asked!.audio, false, "never asks for the microphone");
  });

  it("falls back to any camera when the rear one can't satisfy the constraints", async () => {
    const calls: MediaStreamConstraints[] = [];
    const r = await openCamera({ getUserMedia: async (c) => { calls.push(c); if (calls.length === 1) throw err("OverconstrainedError"); return stream(); } }, true);
    assert.equal(r.ok, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].video, true);
  });

  it("permission denial is reported once and NOT retried (no repeated prompts)", async () => {
    let n = 0;
    const r = await openCamera({ getUserMedia: async () => { n++; throw err("NotAllowedError"); } }, true);
    assert.deepEqual(r, { ok: false, reason: "denied" });
    assert.equal(n, 1);
  });

  it("reports busy, missing hardware, insecure pages and unsupported browsers distinctly", async () => {
    assert.deepEqual(await openCamera({ getUserMedia: async () => { throw err("NotReadableError"); } }, true), { ok: false, reason: "busy" });
    assert.deepEqual(await openCamera({ getUserMedia: async () => { throw err("NotFoundError"); } }, true), { ok: false, reason: "no_camera" });
    assert.deepEqual(await openCamera({ getUserMedia: async () => stream() }, false), { ok: false, reason: "insecure" });
    assert.deepEqual(await openCamera(undefined, true), { ok: false, reason: "unsupported" });
    assert.deepEqual(await openCamera({}, true), { ok: false, reason: "unsupported" });
  });

  it("fitWithin scales down to the long edge, never up", () => {
    assert.deepEqual(fitWithin(4000, 3000, 1600), { width: 1600, height: 1200 });
    assert.deepEqual(fitWithin(3000, 4000, 1600), { width: 1200, height: 1600 });
    assert.deepEqual(fitWithin(800, 600, 1600), { width: 800, height: 600 });
    assert.deepEqual(fitWithin(0, 10, 1600), { width: 0, height: 0 });
  });
});

describe("SubmissionFlow: duplicates, delays, retries, races", () => {
  type Log = { begins: number; uploads: number; completes: number; sleeps: number[] };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const blob = (ms = 0) => new Promise<Blob>((r) => setTimeout(() => r(new Blob(["x"])), ms));
  const input = (attemptId = "a1", elapsedMs = 3000) => ({ attemptId, elapsedMs, meta: { syncRttMs: 40 } });

  function make(over: Partial<SubmitDeps> = {}) {
    const log: Log = { begins: 0, uploads: 0, completes: 0, sleeps: [] };
    const states: FlowState[] = [];
    const deps: SubmitDeps = {
      begin: async () => { log.begins++; return { status: "ready", uploadUrl: "u" } as BeginResult; },
      upload: async (_b, _u, p) => { log.uploads++; p(0.5); p(1); },
      complete: async () => { log.completes++; return { status: "accepted", elapsedMs: 3000, timing: "consistent" }; },
      sleep: async (ms) => { log.sleeps.push(ms); },
      ...over,
    };
    const flow = new SubmissionFlow(deps, (s) => states.push(s));
    return { flow, log, states };
  }
  const settle = async (flow: SubmissionFlow) => { for (let i = 0; i < 50 && ["preparing", "uploading"].includes(flow.current.kind); i++) await tick(); };

  it("happy path: tap → upload with progress → accepted, with no confirmation step", async () => {
    const { flow, states, log } = make();
    assert.equal(flow.start(input(), blob()), true);
    await settle(flow);
    assert.equal(flow.current.kind, "accepted");
    assert.deepEqual([log.begins, log.uploads, log.completes], [1, 1, 1]);
    assert.ok(states.some((s) => s.kind === "uploading" && s.progress === 1), "progress reported");
  });

  it("begin is fired at tap time, BEFORE the (slow) compression finishes", async () => {
    const order: string[] = [];
    const { flow } = make({ begin: async () => { order.push("begin"); return { status: "ready", uploadUrl: "u" }; } });
    flow.start(input(), new Promise<Blob>((r) => setTimeout(() => { order.push("compressed"); r(new Blob(["x"])); }, 30)));
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(order.slice(0, 2), ["begin", "compressed"]);
  });

  it("the elapsed time given at the tap is what gets sent, however long the upload takes", async () => {
    let sent: number | null = null;
    const { flow } = make({
      begin: async (i) => { sent = i.elapsedMs; return { status: "ready", uploadUrl: "u" }; },
      upload: async () => { await new Promise((r) => setTimeout(r, 60)); }, // slow network
    });
    flow.start(input("a", 4321), blob());
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(sent, 4321);
    assert.equal(flow.current.kind, "accepted");
  });

  it("duplicate taps (double tap, two handlers) are ignored: exactly one begin/upload/complete", async () => {
    const { flow, log } = make({ upload: async () => { await new Promise((r) => setTimeout(r, 20)); log0.uploads++; } });
    const log0 = log;
    const results = [flow.start(input("a"), blob()), flow.start(input("b"), blob()), flow.start(input("c"), blob())];
    assert.deepEqual(results, [true, false, false]);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual([log.begins, log.completes], [1, 1]);
    assert.equal(flow.start(input("d"), blob()), false, "no retake after acceptance");
    assert.equal(flow.current.kind, "accepted");
  });

  it("an interrupted upload is retried automatically with the SAME attempt and timing", async () => {
    let n = 0;
    const attempts: string[] = [];
    const { flow, log } = make({
      begin: async (i) => { attempts.push(`${i.attemptId}:${i.elapsedMs}`); return { status: n === 0 ? "ready" : "resumed", uploadUrl: "u" }; },
      upload: async () => { if (n++ < 2) throw new SubmitError("network", true); },
    });
    flow.start(input("same", 2500), blob());
    await settle(flow);
    assert.equal(flow.current.kind, "accepted");
    assert.equal(log.completes, 1);
    assert.deepEqual(attempts, ["same:2500", "same:2500", "same:2500"]);
    assert.deepEqual(log.sleeps, [500, 1500], "back-off between automatic retries");
  });

  it("when the network stays down it surfaces a retryable failure, and a manual retry then succeeds", async () => {
    let down = true;
    const { flow, log } = make({ upload: async () => { if (down) throw new SubmitError("network", true); } });
    flow.start(input(), blob());
    await settle(flow);
    assert.deepEqual(flow.current, { kind: "failed", code: "network", retryable: true, canRecapture: false });
    assert.equal(log.completes, 0);
    assert.equal(flow.start(input("another"), blob()), false, "can't 'retake' to dodge a failed upload");
    down = false;
    await flow.retry();
    assert.equal(flow.current.kind, "accepted");
    assert.equal(log.completes, 1);
  });

  it("a lost 'complete' response is safe to retry: the server answers 'duplicate' and we land on accepted", async () => {
    let c = 0;
    const { flow } = make({ complete: async () => { if (c++ === 0) throw new SubmitError("network", true); return { status: "duplicate", elapsedMs: 3000, timing: "consistent" }; } });
    flow.start(input(), blob());
    await settle(flow);
    assert.equal(flow.current.kind, "accepted");
  });

  it("'database busy' on complete retries ONLY complete: no second begin, no re-upload", async () => {
    let c = 0;
    const metas: unknown[] = [];
    const { flow, log } = make({ complete: async (x) => { log.completes++; metas.push(x.meta.uploadAttempts); if (c++ === 0) throw new SubmitError("db_busy", true); return { status: "accepted", elapsedMs: 3000, timing: "consistent" }; } });
    flow.start(input(), blob());
    await settle(flow);
    assert.equal(flow.current.kind, "accepted");
    assert.deepEqual([log.begins, log.uploads, log.completes], [1, 1, 2]);
    assert.deepEqual(log.sleeps, [500]);
    assert.deepEqual(metas, [1, 1], "still one upload");
  });

  it("'database busy' on begin retries begin (nothing was stored yet)", async () => {
    let b = 0;
    const { flow, log } = make({ begin: async () => { log.begins++; if (b++ === 0) throw new SubmitError("db_busy", true); return { status: "ready", uploadUrl: "u" }; } });
    flow.start(input(), blob());
    await settle(flow);
    assert.equal(flow.current.kind, "accepted");
    assert.deepEqual([log.begins, log.uploads, log.completes], [2, 1, 1]);
  });

  it("any other retryable complete failure still starts over from begin (fresh upload URL)", async () => {
    let c = 0;
    const { flow, log } = make({ complete: async () => { log.completes++; if (c++ === 0) throw new SubmitError("network", true); return { status: "duplicate", elapsedMs: 3000, timing: "consistent" }; } });
    flow.start(input(), blob());
    await settle(flow);
    assert.equal(flow.current.kind, "accepted");
    assert.deepEqual([log.begins, log.uploads, log.completes], [2, 2, 2]);
  });

  it("'database busy' on every try ends in a retryable failure after the automatic retries", async () => {
    const { flow, log } = make({ complete: async () => { log.completes++; throw new SubmitError("db_busy", true); } });
    flow.start(input(), blob());
    await settle(flow);
    assert.equal(flow.current.kind, "failed");
    assert.ok(flow.current.kind === "failed" && flow.current.retryable && !flow.current.canRecapture);
    assert.deepEqual([log.begins, log.uploads, log.completes], [1, 1, 3]);
  });

  it("two simultaneous manual retries run once (single flight)", async () => {
    let down = true;
    const { flow, log } = make({ upload: async () => { if (down) throw new SubmitError("network", true); await new Promise((r) => setTimeout(r, 20)); } });
    flow.start(input(), blob());
    await settle(flow);
    down = false;
    await Promise.all([flow.retry(), flow.retry(), flow.retry()]);
    assert.equal(log.completes, 1);
  });

  it("already submitted (refresh, second device): shown as accepted without uploading again", async () => {
    const { flow, log } = make({ begin: async () => ({ status: "already_submitted", elapsedMs: 1234 }) });
    flow.start(input(), blob());
    await settle(flow);
    assert.deepEqual(flow.current, { kind: "accepted", elapsedMs: 1234, timing: null });
    assert.equal(log.uploads, 0);
  });

  it("too late (round closed) is final; an expired attempt allows ONE fresh capture", async () => {
    const closed = make({ begin: async () => { throw new SubmitError("round_closed", false); } });
    closed.flow.start(input(), blob());
    await settle(closed.flow);
    assert.deepEqual(closed.flow.current, { kind: "failed", code: "round_closed", retryable: false, canRecapture: false });
    assert.equal(closed.flow.start(input("x"), blob()), false);

    let expire = true;
    const exp = make({ complete: async () => { if (expire) { expire = false; throw new SubmitError("attempt_expired", false); } return { status: "accepted", elapsedMs: 9000, timing: "consistent" }; } });
    exp.flow.start(input("old", 1000), blob());
    await settle(exp.flow);
    assert.deepEqual(exp.flow.current, { kind: "failed", code: "attempt_expired", retryable: false, canRecapture: true });
    assert.equal(exp.flow.start(input("new", 9000), blob()), true, "a new capture is allowed (with new timing)");
    await settle(exp.flow);
    assert.equal(exp.flow.current.kind, "accepted");
  });

  it("a photo the server rejects can be captured again; other players' removal is fatal", async () => {
    const bad = make({ complete: async () => { throw new SubmitError("invalid_image", false); } });
    bad.flow.start(input(), blob());
    await settle(bad.flow);
    assert.equal((bad.flow.current as { canRecapture: boolean }).canRecapture, true);
    const removed = make({ begin: async () => { throw new SubmitError("player_removed", false); } });
    removed.flow.start(input(), blob());
    await settle(removed.flow);
    assert.deepEqual(removed.flow.current, { kind: "failed", code: "player_removed", retryable: false, canRecapture: false });
  });

  it("compression failure surfaces as a retryable failure rather than hanging", async () => {
    const { flow } = make();
    flow.start(input(), Promise.reject(new Error("canvas blew up")));
    await settle(flow);
    assert.equal(flow.current.kind, "failed");
  });
});
