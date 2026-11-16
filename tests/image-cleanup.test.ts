import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { formatBytes, isGameplayPhotoPath, runImageCleanup, type Attempt, type CleanupDeps } from "../lib/admin/image-cleanup.ts";

const id = () => crypto.randomUUID();
const photo = () => `${id()}/${id()}/${id()}.jpg`;

/** In-memory bucket + eligibility, with the DB's "deleted = gone" verification. */
function fake(names: string[], opts: { failRemoveOn?: number; dropOnRevalidate?: Set<string>; failRevalidateOn?: number } = {}) {
  const bucket = new Set(names);
  const eligible = new Set(names);
  let removeCalls = 0;
  let candidateCalls = 0;
  const recorded: { evaluated: number; skipped: number; attempted: Attempt[] }[] = [];
  const deps: CleanupDeps = {
    countImages: async () => bucket.size + 5, // 5 protected images that are never candidates
    async candidates(only, limit) {
      candidateCalls++;
      if (only && opts.failRevalidateOn === candidateCalls) throw new Error("revalidation_failed");
      if (only) for (const n of opts.dropOnRevalidate ?? []) eligible.delete(n);
      return [...eligible].filter((n) => bucket.has(n) && (!only || only.includes(n))).slice(0, limit).map((n) => ({ object_name: n, bytes: 100 }));
    },
    async remove(paths) {
      removeCalls++;
      if (opts.failRemoveOn === removeCalls) throw new Error("storage_error");
      for (const p of paths) bucket.delete(p);
      return paths;
    },
    async record(evaluated, skipped, attempted) {
      recorded.push({ evaluated, skipped, attempted });
      const gone = attempted.filter((a) => !bucket.has(a.name));
      const failed = attempted.filter((a) => bucket.has(a.name)).map((a) => ({ name: a.name, reason: a.error ?? "not_removed" }));
      return { run_id: recorded.length, deleted: gone.length, failed: failed.length, bytes_recovered: gone.length * 100, references_updated: gone.length, failed_items: failed };
    },
  };
  return { deps, bucket, recorded, removeCalls: () => removeCalls };
}

describe("runImageCleanup", () => {
  it("deletes in batches and reports deleted / skipped / bytes", async () => {
    const names = Array.from({ length: 25 }, photo);
    const f = fake(names);
    const r = await runImageCleanup(f.deps, { batch: 10, max: 100 });
    assert.equal(f.removeCalls(), 3);
    assert.equal(r.deleted, 25);
    assert.equal(r.failed, 0);
    assert.equal(r.skipped, 5);
    assert.equal(r.evaluated, 30);
    assert.equal(r.bytesRecovered, 2500);
    assert.equal(r.more, false);
    assert.equal(f.recorded.length, 1, "one audit record per run");
  });

  it("a Storage failure fails only that batch; the rest proceeds and the failed images stay for a retry", async () => {
    const names = Array.from({ length: 20 }, photo);
    const f = fake(names, { failRemoveOn: 1 });
    const r = await runImageCleanup(f.deps, { batch: 10 });
    assert.equal(r.deleted, 10);
    assert.equal(r.failed, 10);
    assert.ok(r.failures.every((x) => x.reason === "storage_error"));
    // Retry: only the 10 failed ones are left, and they go now.
    const again = await runImageCleanup(f.deps, { batch: 10 });
    assert.equal(again.deleted, 10);
    assert.equal(f.bucket.size, 0);
    // Third run: nothing left to do.
    const third = await runImageCleanup(f.deps, { batch: 10 });
    assert.equal(third.deleted + third.failed, 0);
  });

  it("images that stop qualifying between preview and deletion are skipped, never removed", async () => {
    const names = Array.from({ length: 4 }, photo);
    const f = fake(names, { dropOnRevalidate: new Set([names[0], names[1]]) });
    const r = await runImageCleanup(f.deps);
    assert.equal(r.deleted, 2);
    assert.ok(f.bucket.has(names[0]) && f.bucket.has(names[1]));
    assert.equal(r.skipped, 5 + 2);
  });

  it("never passes a non-gameplay path to Storage, even if the database returned one", async () => {
    const odd = ["avatars/me.png", "config.json", `${id()}/x.jpg`];
    const f = fake(odd);
    const r = await runImageCleanup(f.deps);
    assert.equal(f.removeCalls(), 0);
    assert.equal(r.deleted, 0);
  });

  it("stops deleting if revalidation fails mid-run, but still records what was done", async () => {
    const names = Array.from({ length: 20 }, photo);
    const f = fake(names, { failRevalidateOn: 3 }); // call 1 = initial list, 2 = batch 1, 3 = batch 2
    const r = await runImageCleanup(f.deps, { batch: 10 });
    assert.equal(r.aborted, true);
    assert.equal(r.more, true);
    assert.equal(r.deleted, 10);
    assert.equal(f.recorded.length, 1);
  });

  it("reports more when the run hits its cap", async () => {
    const f = fake(Array.from({ length: 12 }, photo));
    const r = await runImageCleanup(f.deps, { max: 10, batch: 5 });
    assert.equal(r.deleted, 10);
    assert.equal(r.more, true);
  });
});

describe("helpers", () => {
  it("isGameplayPhotoPath", () => {
    assert.ok(isGameplayPhotoPath(photo()));
    assert.ok(!isGameplayPhotoPath(`${id()}/${id()}/${id()}.gif`));
    assert.ok(!isGameplayPhotoPath(`../${id()}/${id()}.jpg`));
  });
  it("formatBytes", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(1536), "1.5 KB");
    assert.equal(formatBytes(5 * 1024 ** 3), "5.0 GB");
  });
});
