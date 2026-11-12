import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { lockedCellIds } from "../lib/bingosnap/board.ts";
import { photoFileName } from "../lib/photos/export.ts";
import { MemoryPhotoStore, PhotoStoreError, STALE_AFTER_MS, classifyStorageError, isStale, photoKey } from "../lib/photos/store.ts";

const G1 = "8f14e45f-ceea-467a-9575-3f0a2a6f3c1b";
const G2 = "c9f0f895-fb98-4b91-8f3a-b1e2a0d0e8d7";
const P1 = "45c48cce-2e2d-4fbd-a1c3-0f1c3c2c1a01";
const P2 = "d3d94468-02a4-4d9e-8f7c-6b5a4c3b2a10";
const C1 = "6512bd43-d9ca-4c6e-9f0b-1a2b3c4d5e61";
const C2 = "c20ad4d7-6fe9-4759-aa27-0c0d0e0f1a12";

const photo = (tag: string, takenAt = 1000) => ({
  image: new Blob([`image-${tag}`], { type: "image/jpeg" }),
  thumb: new Blob([`thumb-${tag}`], { type: "image/jpeg" }),
  width: 1280, height: 960, source: "camera" as const, takenAt,
});
const text = async (b: Blob | null) => (b ? await b.text() : null);

describe("photo keys and storage errors", () => {
  it("keys are [game, player, cell] uuids, lower-cased; anything else is refused", () => {
    assert.deepEqual(photoKey({ gameId: G1.toUpperCase(), playerId: P1 }, C1), [G1, P1, C1]);
    for (const bad of [{ gameId: "x", playerId: P1, cell: C1 }, { gameId: G1, playerId: "", cell: C1 }, { gameId: G1, playerId: P1, cell: "1" }]) {
      assert.throws(() => photoKey({ gameId: bad.gameId, playerId: bad.playerId }, bad.cell), (e: unknown) => e instanceof PhotoStoreError && e.kind === "invalid");
    }
  });
  it("classifies quota, interruption and unavailable storage", () => {
    assert.equal(classifyStorageError({ name: "QuotaExceededError" }), "quota");
    assert.equal(classifyStorageError({ name: "NS_ERROR_DOM_QUOTA_REACHED" }), "quota");
    assert.equal(classifyStorageError({ name: "UnknownError", message: "Quota exceeded." }), "quota");
    assert.equal(classifyStorageError({ name: "AbortError" }), "interrupted");
    assert.equal(classifyStorageError({ name: "InvalidStateError" }), "unavailable");
    assert.equal(classifyStorageError({ name: "SecurityError" }), "unavailable");
    assert.equal(classifyStorageError(new PhotoStoreError("quota")), "quota");
    assert.equal(classifyStorageError(null), "unknown");
  });
  it("only other games' photos older than a week are stale", () => {
    const now = 10 * STALE_AFTER_MS;
    assert.equal(isStale({ gameId: G2, savedAt: now - STALE_AFTER_MS - 1 }, G1, now), true);
    assert.equal(isStale({ gameId: G2, savedAt: now - 1000 }, G1, now), false);
    assert.equal(isStale({ gameId: G1, savedAt: 0 }, G1.toUpperCase(), now), false, "never the current game's");
    assert.equal(isStale({ gameId: G2, savedAt: Number.NaN }, G1, now), true, "a corrupt record is not kept forever");
  });
});

describe("photo store contract (memory implementation; IndexedDB is exercised in the browser QA)", () => {
  it("keeps games and participants apart", async () => {
    const s = new MemoryPhotoStore();
    await s.put({ gameId: G1, playerId: P1 }, C1, photo("g1p1"));
    await s.put({ gameId: G1, playerId: P2 }, C1, photo("g1p2"));
    await s.put({ gameId: G2, playerId: P1 }, C1, photo("g2p1"));
    assert.equal((await s.list({ gameId: G1, playerId: P1 })).length, 1);
    assert.equal(await text(await s.getImage({ gameId: G1, playerId: P1 }, C1)), "image-g1p1");
    assert.equal(await text(await s.getImage({ gameId: G1, playerId: P2 }, C1)), "image-g1p2");
    assert.equal(await text(await s.getImage({ gameId: G2, playerId: P1 }, C1)), "image-g2p1");
    assert.equal(await s.getImage({ gameId: G2, playerId: P2 }, C1), null);
  });
  it("replaces a square's photo, removes one, and clears only one participant's game", async () => {
    const s = new MemoryPhotoStore();
    const me = { gameId: G1, playerId: P1 };
    await s.put(me, C1, photo("first", 1));
    const r = await s.put(me, C1, photo("retake", 2));
    assert.equal(r.takenAt, 2);
    assert.equal((await s.list(me)).length, 1);
    assert.equal(await text(await s.getImage(me, C1)), "image-retake");
    await s.put(me, C2, photo("two"));
    await s.remove(me, C1);
    assert.deepEqual((await s.list(me)).map((x) => x.cellId), [C2]);
    await s.put({ gameId: G1, playerId: P2 }, C1, photo("other"));
    await s.clear(me);
    assert.equal((await s.list(me)).length, 0);
    assert.equal((await s.list({ gameId: G1, playerId: P2 })).length, 1, "other participants untouched");
  });
  it("prune never touches the current game", async () => {
    const s = new MemoryPhotoStore();
    await s.put({ gameId: G1, playerId: P1 }, C1, photo("now"));
    await s.put({ gameId: G2, playerId: P1 }, C1, photo("old"));
    assert.equal(await s.prune(G1, Date.now() + STALE_AFTER_MS + 1), 1);
    assert.equal((await s.list({ gameId: G1, playerId: P1 })).length, 1);
    assert.equal((await s.list({ gameId: G2, playerId: P1 })).length, 0);
    assert.equal(s.persistent, false);
  });
});

describe("card helpers", () => {
  it("locks squares in pending or verified claims only", () => {
    const l = lockedCellIds([
      { status: "rejected", cellIds: ["a", "b"] },
      { status: "pending", cellIds: ["c"] },
      { status: "verified", cellIds: ["d"] },
    ]);
    assert.deepEqual([...l].sort(), ["c", "d"]);
  });
  it("file names are safe", () => {
    assert.equal(photoFileName("Office Hunt!", "A red mug ☕", 3), "office-hunt-03-a-red-mug.jpg");
    assert.equal(photoFileName("", "../../etc", undefined), "photo-etc.jpg");
  });
});

describe("photos never leave the device", () => {
  const ROOT = join(import.meta.dirname, "..");
  const code = (f: string) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  const NETWORK = /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|supabase|\.channel\(|\bpostMessage\(|serviceWorker|caches\./;
  it("photo code (lib/photos and the photo components) has no network or service-worker path", () => {
    const files = [
      ...readdirSync(join(ROOT, "lib", "photos")).map((f) => join(ROOT, "lib", "photos", f)),
      ...["photo-capture.tsx", "photo-board.tsx", "hunt-board.tsx", "use-cell-photos.ts"].map((f) => join(ROOT, "components", "bingosnap", f)),
    ];
    assert.ok(files.length >= 7);
    for (const f of files) assert.doesNotMatch(code(f), NETWORK, f);
  });
  it("no photo data in localStorage / sessionStorage, and no base64 encoding", () => {
    const files = [...readdirSync(join(ROOT, "lib", "photos")).map((f) => join(ROOT, "lib", "photos", f)), join(ROOT, "components", "bingosnap", "use-cell-photos.ts")];
    for (const f of files) assert.doesNotMatch(code(f), /localStorage|sessionStorage|toDataURL|readAsDataURL|btoa\(/, f);
  });
  it("the player screen (which does call the API) never handles image data itself", () => {
    const src = code(join(ROOT, "components", "bingosnap", "player-screen.tsx"));
    assert.doesNotMatch(src, /Blob|File\b|canvas|indexedDB|CapturedPhoto|FormData/);
  });
});
