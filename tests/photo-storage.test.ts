import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { PhotoUrlCache, SubmissionPhotoLoader, type ListingResult } from "../lib/game/photo-url-cache.ts";
import { isGamePhotoPath, listSubmissionPhotos, parseHave, type ListingDeps, type RankingRow } from "../lib/game/submission-photos.ts";
import { MIN_PHOTO_BYTES, PREFIX_BUFFER_CAP, probePhoto, readPrefix, type ProbeDeps } from "../lib/players/photo-probe.ts";
import { SharedSignedUrlCache, resolveWinnerPhoto } from "../lib/players/shared-url-cache.ts";

// Phase 3. Everything here runs against MOCKED Storage (in-process fakes); no real Supabase Storage is involved.
const uuid = () => crypto.randomUUID();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const GAME = uuid(), ROUND = uuid(), OTHER_GAME = uuid();
const path = (player: string, game = GAME, round = ROUND) => `${game}/${round}/${player}.jpg`;
function rankRow(player = uuid(), over: Partial<RankingRow> = {}): RankingRow {
  return { submission_id: uuid(), rank: 1, player_id: player, nickname: "P", status: "pending", rank_ms: 1000, claimed_elapsed_ms: 1000,
    server_elapsed_ms: 1040, timing_status: "consistent", timing_flags: [], near_tie: false, is_leader: false, storage_path: path(player), ...over };
}
/** A fake owner-scoped database + counting signer. */
function deps(rows: RankingRow[], o: { owner?: boolean; phase?: string; winner?: string | null; failSign?: boolean } = {}) {
  const calls = { game: 0, ranking: 0, winner: 0, sign: 0, signedPaths: [] as string[] };
  const d: ListingDeps = {
    game: async () => { calls.game++; return o.owner === false ? null : { currentRoundId: ROUND, phase: o.phase ?? "active" }; },
    ranking: async () => { calls.ranking++; return rows; },
    officialWinner: async () => { calls.winner++; return o.winner ?? null; },
    sign: async (paths) => { calls.sign++; calls.signedPaths.push(...paths); return o.failSign ? new Map() : new Map(paths.map((p) => [p, `https://s/${p}?t=${uuid()}`])); },
  };
  return { d, calls };
}

describe("listSubmissionPhotos: who gets which URL", () => {
  it("not your game (or not found): nothing is ranked or signed", async () => {
    const { d, calls } = deps([rankRow()], { owner: false });
    assert.equal(await listSubmissionPhotos(d, { gameId: GAME, view: "host", have: new Set() }), null);
    assert.deepEqual([calls.ranking, calls.sign], [0, 0]);
  });

  it("host: signs every listed photo it doesn't already hold, once per path; keeps ranking order", async () => {
    const rows = [rankRow(), rankRow(), rankRow()];
    const { d, calls } = deps(rows);
    const first = (await listSubmissionPhotos(d, { gameId: GAME, view: "host", have: new Set() }))!;
    assert.equal(calls.signedPaths.length, 3);
    assert.deepEqual(first.submissions.map((r) => r.submissionId), rows.map((r) => r.submission_id));
    assert.ok(first.submissions.every((r) => r.photoUrl && r.photoKey === `submissions/${rows.find((x) => x.submission_id === r.submissionId)!.storage_path}`));
    const again = (await listSubmissionPhotos(d, { gameId: GAME, view: "host", have: new Set([rows[0].submission_id, rows[1].submission_id]) }))!;
    assert.equal(calls.signedPaths.length, 4, "only the photo it didn't have");
    assert.equal(again.submissions[0].photoUrl, null);
    assert.ok(again.submissions[2].photoUrl);
    const none = (await listSubmissionPhotos(d, { gameId: GAME, view: "host", have: new Set(rows.map((r) => r.submission_id)) }))!;
    assert.equal(calls.sign, 2, "nothing to sign -> no Storage call at all");
    assert.equal(none.signed, 0);
  });

  it("presenter: names only until the OFFICIAL winner is announced, then only the winner's photo", async () => {
    const winner = uuid();
    const rows = [rankRow(), rankRow(winner), rankRow()];
    for (const phase of ["active", "reviewing"]) {
      const { d, calls } = deps(rows, { phase, winner });
      const l = (await listSubmissionPhotos(d, { gameId: GAME, view: "presenter", have: new Set() }))!;
      assert.equal(calls.sign + calls.winner, 0, phase);
      assert.ok(l.submissions.every((r) => r.photoKey === null && r.photoUrl === null));
      assert.deepEqual(l.submissions.map((r) => r.nickname), ["P", "P", "P"], "names are still listed");
    }
    const notYet = deps(rows, { phase: "winner_announced", winner: null });
    assert.equal((await listSubmissionPhotos(notYet.d, { gameId: GAME, view: "presenter", have: new Set() }))!.signed, 0);
    const { d, calls } = deps(rows, { phase: "winner_announced", winner });
    const l = (await listSubmissionPhotos(d, { gameId: GAME, view: "presenter", have: new Set() }))!;
    assert.deepEqual(calls.signedPaths, [path(winner)]);
    assert.deepEqual(l.submissions.map((r) => Boolean(r.photoUrl)), [false, true, false]);
  });

  it("paths outside this game's folder, or malformed, are never signed", async () => {
    const bad = [rankRow(uuid(), { storage_path: path(uuid(), OTHER_GAME) }), rankRow(uuid(), { storage_path: "../etc/passwd" }), rankRow(uuid(), { storage_path: `${GAME}/${ROUND}/x.jpg` })];
    const { d, calls } = deps([...bad, rankRow()]);
    const l = (await listSubmissionPhotos(d, { gameId: GAME, view: "host", have: new Set() }))!;
    assert.equal(calls.signedPaths.length, 1);
    assert.ok(l.submissions.slice(0, 3).every((r) => r.photoKey === null && r.photoUrl === null));
    assert.equal(isGamePhotoPath(path(uuid()), GAME.toUpperCase()), true, "ids are compared case-insensitively");
  });

  it("a Storage signing failure still returns the list (photos marked missing, retried by the client)", async () => {
    const { d } = deps([rankRow(), rankRow()], { failSign: true });
    const l = (await listSubmissionPhotos(d, { gameId: GAME, view: "host", have: new Set() }))!;
    assert.equal(l.submissions.length, 2);
    assert.equal(l.signFailed, 2);
    assert.ok(l.submissions.every((r) => r.photoUrl === null && r.photoKey));
  });

  it("parseHave keeps only ids (lower-cased), at most 200", () => {
    const ids = Array.from({ length: 250 }, () => uuid().toUpperCase());
    const h = parseHave(["x", "", "1;drop", ...ids].join(","));
    assert.equal(h.size, 200);
    assert.ok([...h].every((x) => x === x.toLowerCase()));
    assert.equal(parseHave(null).size, 0);
  });
});

describe("PhotoUrlCache (client, per screen)", () => {
  const row = (id: string, key: string | null, url: string | null = null) => ({ submissionId: id, photoKey: key, photoUrl: url });
  it("hit while comfortably valid, then asks again inside the refresh margin; expiry is counted from the REQUEST time", () => {
    let now = 1_000_000;
    const c = new PhotoUrlCache({ marginMs: 60_000, now: () => now });
    c.apply([row("a", "k1", "u1")], 300, now - 2_000);       // the request left 2 s before the answer
    assert.deepEqual(c.haveIds([row("a", "k1")]), ["a"]);
    now += 300_000 - 2_000 - 60_000 - 1;
    assert.deepEqual(c.haveIds([row("a", "k1")]), ["a"]);
    now += 2;
    assert.deepEqual(c.haveIds([row("a", "k1")]), [], "inside the margin: re-sign");
    const { rows, missing } = c.apply([row("a", "k1")], 300, now);
    assert.equal(rows[0].photoUrl, "u1", "the old URL is still shown until the new one arrives");
    assert.equal(missing, 0);
    now += 60_000;
    assert.equal(c.apply([row("a", "k1")], 300, now).rows[0].photoUrl, null, "an EXPIRED url is never shown");
  });

  it("the margin is capped at half the lifetime (short-lived URLs still get reused)", () => {
    let now = 0;
    const c = new PhotoUrlCache({ marginMs: 60_000, now: () => now });
    c.apply([row("a", "k")], 10, now);
    c.apply([row("a", "k", "u")], 10, now);
    assert.equal(c.nextRefreshAt(), 5_000);
    now = 4_999; assert.deepEqual(c.haveIds([row("a", "k")]), ["a"]);
    now = 5_000; assert.deepEqual(c.haveIds([row("a", "k")]), []);
  });

  it("photos that leave the list (removed player, next round) are forgotten at once", () => {
    const c = new PhotoUrlCache();
    c.apply([row("a", "k1", "u1"), row("b", "k2", "u2")], 300, Date.now());
    c.apply([row("a", "k1")], 300, Date.now());
    assert.equal(c.size, 1);
    const back = c.apply([row("a", "k1"), row("b", "k2")], 300, Date.now());
    assert.equal(back.rows[1].photoUrl, null, "a URL dropped with its row is not resurrected");
    assert.equal(back.missing, 1);
  });

  it("rows a view may not show (photoKey null) never get a URL, even if one is cached", () => {
    const c = new PhotoUrlCache();
    c.apply([row("a", "k1", "u1")], 300, Date.now());
    assert.equal(c.apply([row("a", null, "u1")], 300, Date.now()).rows[0].photoUrl, null);
  });

  it("a failed picture is re-signed, at most once per retry window", () => {
    let now = 0;
    const c = new PhotoUrlCache({ retryMs: 10_000, now: () => now });
    c.apply([row("a", "k", "u")], 300, now);
    assert.equal(c.invalidate("k"), true);
    assert.deepEqual(c.haveIds([row("a", "k")]), []);
    assert.equal(c.invalidate("k"), false, "a picture that keeps failing doesn't hammer Storage");
    now = 10_000; assert.equal(c.invalidate("k"), true);
  });
});

describe("SubmissionPhotoLoader (client): signing work over time", () => {
  /** A fake listing endpoint that signs whatever the client doesn't hold (like the real route). */
  function server(n: number, ttl = 300) {
    const rows = Array.from({ length: n }, (_, i) => ({ submissionId: `s${i}`, photoKey: `submissions/p${i}`, photoUrl: null as string | null }));
    const st = { requests: 0, signed: 0, haves: [] as string[][], fail: false, fatal: false, delayMs: 0 };
    const fetchListing = async (have: string[]): Promise<ListingResult<(typeof rows)[number]>> => {
      st.requests++; st.haves.push(have);
      if (st.delayMs) await sleep(st.delayMs);
      if (st.fatal) return { status: "fatal" };
      if (st.fail) return { status: "error" };
      const hold = new Set(have);
      return { status: "ok", ttlSeconds: ttl, rows: rows.map((r) => (hold.has(r.submissionId) ? r : (st.signed++, { ...r, photoUrl: `u-${r.submissionId}-${st.signed}` }))) };
    };
    return { rows, st, fetchListing };
  }

  for (const n of [2, 10, 30, 50]) {
    it(`${n} photos: signed once, then every later re-read of the list signs nothing`, async () => {
      const s = server(n);
      let shown: { photoUrl: string | null }[] = [];
      const l = new SubmissionPhotoLoader({ fetchListing: s.fetchListing, onRows: (r) => { shown = r; } });
      await l.load();
      for (let i = 0; i < 20; i++) await l.load();   // 20 more hints (reviews, other photos…)
      assert.equal(s.st.signed, n);
      assert.equal(s.st.requests, 21);
      assert.ok(shown.every((r) => r.photoUrl));
      l.stop();
    });
  }

  it("concurrent triggers coalesce: one request in flight, at most one follow-up", async () => {
    const s = server(5); s.st.delayMs = 20;
    const l = new SubmissionPhotoLoader({ fetchListing: s.fetchListing, onRows: () => {} });
    await Promise.all(Array.from({ length: 10 }, () => l.load()));
    assert.equal(s.st.requests, 2);
    assert.equal(s.st.signed, 5, "the follow-up re-used every URL");
    l.stop();
  });

  it("refreshes on its own before shown URLs expire (no expired picture while the host just looks)", async () => {
    const s = server(3, 0.2);   // 200 ms URLs: refreshed at ~100 ms
    let shown: { photoUrl: string | null }[] = [];
    const l = new SubmissionPhotoLoader({ fetchListing: s.fetchListing, onRows: (r) => { shown = r; }, minRefreshDelayMs: 0 });
    await l.load();
    const firstUrls = shown.map((r) => r.photoUrl);
    await sleep(160);
    assert.ok(s.st.requests >= 2, "a timer re-read happened without any hint");
    assert.ok(shown.every((r, i) => r.photoUrl && r.photoUrl !== firstUrls[i]), "fresh URLs replaced the old ones");
    l.stop();
    const after = s.st.requests;
    await sleep(250);
    assert.equal(s.st.requests, after, "stop() ends refreshing");
  });

  it("a failing list retries with back-off; 'not your game' stops for good", async () => {
    const s = server(2); s.st.fail = true;
    let errors = 0;
    const l = new SubmissionPhotoLoader({ fetchListing: s.fetchListing, onRows: () => {}, onError: () => errors++, retryStepsMs: [20, 40] });
    await l.load();
    await sleep(35);
    assert.equal(s.st.requests, 2);
    s.st.fail = false;
    await sleep(60);
    assert.equal(s.st.signed, 2, "recovered");
    s.st.fatal = true;
    await l.load();
    const n = s.st.requests;
    await l.load(); await sleep(50);
    assert.equal(s.st.requests, n, "stopped");
    assert.ok(errors >= 2);
  });

  it("photos whose signing failed are retried soon, the rest are kept", async () => {
    let failFor = new Set(["s1"]);
    let signed = 0;
    const rows = ["s0", "s1"].map((id) => ({ submissionId: id, photoKey: `k-${id}`, photoUrl: null as string | null }));
    let shown: { photoUrl: string | null }[] = [];
    const l = new SubmissionPhotoLoader({
      fetchListing: async (have) => ({ status: "ok", ttlSeconds: 300, rows: rows.map((r) => (have.includes(r.submissionId) || failFor.has(r.submissionId) ? r : (signed++, { ...r, photoUrl: `u-${r.submissionId}` }))) }),
      onRows: (r) => { shown = r; }, retryStepsMs: [20],
    });
    await l.load();
    assert.deepEqual(shown.map((r) => Boolean(r.photoUrl)), [true, false]);
    failFor = new Set();
    await sleep(40);
    assert.deepEqual(shown.map((r) => Boolean(r.photoUrl)), [true, true]);
    assert.equal(signed, 2, "s0 was not signed twice");
    l.stop();
  });

  it("a broken picture triggers ONE fresh signing for that photo", async () => {
    const s = server(3);
    const l = new SubmissionPhotoLoader({ fetchListing: s.fetchListing, onRows: () => {} });
    await l.load();
    l.photoFailed({ photoKey: "submissions/p1" });
    l.photoFailed({ photoKey: "submissions/p1" });   // the same broken <img> again
    await sleep(10);
    assert.equal(s.st.signed, 4);
    assert.deepEqual(s.st.haves.at(-1)!.sort(), ["s0", "s2"]);
    l.stop();
  });

  it("reconnect after missed hints: the catch-up re-read reuses every URL", async () => {
    const s = server(10);
    const l = new SubmissionPhotoLoader({ fetchListing: s.fetchListing, onRows: () => {} });
    await l.load();
    await l.load();   // what a reconnect / safety re-read causes once the fingerprint differs
    assert.equal(s.st.signed, 10);
    l.stop();
  });
});

describe("probePhoto: validation without downloading the photo", () => {
  const PHOTO = 400 * 1024;
  const jpeg = (size = PHOTO) => { const b = new Uint8Array(size); b.set([0xff, 0xd8, 0xff, 0xe0]); return b; };
  /** A Storage fake. `range`: honour Range (send only what was asked) or ignore it (send the whole object). */
  function storage(bytes: Uint8Array | null, o: { range?: boolean; type?: string; info?: "unavailable"; stream?: "unavailable" | "throw"; maxMb?: number } = {}) {
    const st = { pulled: 0, cancelled: false, aborted: false, streams: 0 };
    const d: ProbeDeps = {
      info: async () => (o.info ?? (bytes ? { size: bytes.length, contentType: o.type ?? "image/jpeg" } : null)),
      maxBytes: async () => (o.maxMb ?? 5) * 1048576,
      stream: async (n) => {
        st.streams++;
        if (o.stream === "unavailable") return "unavailable";
        if (!bytes) return null;
        const src = o.range === false ? bytes : bytes.subarray(0, n);
        let off = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(c) { if (o.stream === "throw") return c.error(new Error("reset")); if (off >= src.length) return c.close(); const chunk = src.subarray(off, off + 65536); off += chunk.length; st.pulled += chunk.length; c.enqueue(chunk); },
          cancel() { st.cancelled = true; },
        }, { highWaterMark: 0 });
        return { body, abort: () => { st.aborted = true; } };
      },
    };
    return { d, st };
  }

  it("Range honoured: 3 bytes are read", async () => {
    const { d, st } = storage(jpeg());
    assert.deepEqual(await probePhoto(d), { ok: true, bytes: PHOTO, bytesBuffered: 3 });
    assert.ok(st.aborted);
  });

  it("Range IGNORED (whole file sent): one 64 KiB chunk is buffered, the stream is cancelled, the rest never pulled", async () => {
    const { d, st } = storage(jpeg(), { range: false });
    const v = await probePhoto(d);
    assert.equal(v.ok, true);
    assert.equal(v.bytesBuffered, 65536);
    assert.ok(st.cancelled && st.aborted);
    assert.ok(st.pulled <= 65536 * 2, `pulled ${st.pulled} of ${PHOTO} bytes`);
  });

  it("invalid signature (not a JPEG) is rejected", async () => {
    const png = new Uint8Array(4096); png.set([0x89, 0x50, 0x4e, 0x47]);
    assert.equal((await probePhoto(storage(png).d)).ok, false);
    assert.deepEqual(await probePhoto(storage(png).d), { ok: false, reason: "invalid", bytesBuffered: 3 });
  });

  it("oversized, too small, or not image/jpeg: rejected from metadata, nothing downloaded", async () => {
    for (const [bytes, o] of [[jpeg(6 * 1048576), {}], [jpeg(MIN_PHOTO_BYTES - 1), {}], [jpeg(), { type: "image/png" }], [jpeg(), { type: "text/html" }], [jpeg(2 * 1048576), { maxMb: 1 }]] as const) {
      const { d, st } = storage(bytes, o);
      assert.deepEqual(await probePhoto(d), { ok: false, reason: "invalid", bytesBuffered: 0 });
      assert.equal(st.streams, 0);
    }
    assert.equal((await probePhoto(storage(jpeg(), { type: "image/jpeg; charset=binary" }).d)).ok, true, "parameters on the type are ignored");
  });

  it("a missing object is 'missing'; Storage trouble is 'unavailable' (retry), never 'invalid'", async () => {
    assert.deepEqual(await probePhoto(storage(null).d), { ok: false, reason: "missing", bytesBuffered: 0 });
    assert.equal((await probePhoto(storage(jpeg(), { info: "unavailable" }).d)).ok === false && (await probePhoto(storage(jpeg(), { info: "unavailable" }).d) as { reason: string }).reason, "unavailable");
    assert.equal((await probePhoto(storage(jpeg(), { stream: "unavailable" }).d) as { reason: string }).reason, "unavailable");
    const broken = storage(jpeg(), { stream: "throw" });
    assert.equal((await probePhoto(broken.d) as { reason: string }).reason, "unavailable");
    assert.ok(broken.st.aborted, "the request is always released");
  });

  it("readPrefix never buffers more than its cap, whatever the server sends", async () => {
    let sent = 0;
    const endless = new ReadableStream<Uint8Array>({ pull(c) { sent += 1024; c.enqueue(new Uint8Array(1024)); } }, { highWaterMark: 0 });
    const r = await readPrefix(endless, 1 << 30);
    assert.ok(r.bytesBuffered <= PREFIX_BUFFER_CAP && sent <= PREFIX_BUFFER_CAP + 2048);
  });
});

describe("SharedSignedUrlCache + resolveWinnerPhoto (server, winner photo)", () => {
  it("50 players at once: ONE signing; later requests reuse it while ≥ minRemaining is left", async () => {
    let now = 0, signs = 0;
    const c = new SharedSignedUrlCache({ ttlSeconds: 120, minRemainingMs: 60_000, now: () => now });
    const sign = async () => { signs++; await sleep(5); return `u${signs}`; };
    const urls = await Promise.all(Array.from({ length: 50 }, () => resolveWinnerPhoto(async () => "g/r/p.jpg", c, sign, "submissions")));
    assert.equal(signs, 1);
    assert.ok(urls.every((u) => u === "u1"));
    now = 60_000; assert.equal(await c.get("submissions/g/r/p.jpg", sign), "u1");
    now = 60_001; assert.equal(await c.get("submissions/g/r/p.jpg", sign), "u2", "less than 60 s left: re-signed");
  });

  it("no path from the database (not announcing, removed player, other game) = no URL and the cache is never touched", async () => {
    const c = new SharedSignedUrlCache({ ttlSeconds: 120, minRemainingMs: 60_000 });
    let signs = 0;
    await c.get("submissions/g/r/p.jpg", async () => { signs++; return "secret"; });
    assert.equal(await resolveWinnerPhoto(async () => null, c, async () => { signs++; return "x"; }, "submissions"), null);
    assert.equal(signs, 1);
    assert.equal(c.stats.hits, 0);
  });

  it("different objects never share a URL; failures are not cached; size is bounded", async () => {
    const c = new SharedSignedUrlCache({ ttlSeconds: 120, minRemainingMs: 1, maxEntries: 3 });
    assert.notEqual(await c.get("a", async () => "ua"), await c.get("b", async () => "ub"));
    assert.equal(await c.get("x", async () => null), null);
    assert.equal(await c.get("x", async () => "ux"), "ux", "a failed signing is retried next time");
    for (const k of ["c", "d", "e"]) await c.get(k, async () => `u${k}`);
    let resigned = false;
    await c.get("a", async () => { resigned = true; return "ua2"; });
    assert.ok(resigned, "the oldest entry was evicted");
  });
});
