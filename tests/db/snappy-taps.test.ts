/** Homepage boop counter (migrations 20261112000015 → 000016): real SQL on PGlite. */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";

import { as, createDb, errorOf, newPGlite } from "./harness.ts";

const svc = { role: "service_role" } as const;
let db: PGlite;

const add = (taps: number) => as(db, svc, async () => Number((await db.query<{ t: string }>("select public.add_snappy_taps($1) t", [taps])).rows[0].t));
const total = () => as(db, svc, async () => Number((await db.query<{ t: string }>("select public.get_snappy_taps() t")).rows[0].t));

before(async () => { db = await createDb(); });
beforeEach(async () => { await db.exec("update public.snappy_counter set taps = 0"); });

describe("snappy counter", () => {
  it("is one number: each batch is added and the new total returned", async () => {
    assert.equal(await add(5), 5);
    assert.equal(await add(500), 505);
    assert.equal(await total(), 505);
    assert.equal(Number((await db.query<{ n: string }>("select count(*) n from public.snappy_counter")).rows[0].n), 1);
  });

  it("keeps no history or per-visitor data (old tables and functions are gone)", async () => {
    const tables = (await db.query<{ t: string | null }>("select to_regclass('public.snappy_tap_limits')::text t union all select to_regclass('public.snappy_tap_shards')::text")).rows;
    assert.deepEqual(tables.map((r) => r.t), [null, null]);
    const oldFn = (await db.query<{ n: string }>("select count(*) n from pg_proc where proname = 'add_snappy_taps' and pronargs = 2")).rows[0].n;
    assert.equal(Number(oldFn), 0);
  });

  it("rejects bad batches", async () => {
    for (const taps of [0, -5, 501]) assert.match((await errorOf(add(taps))) ?? "", /invalid_taps/, String(taps));
    assert.equal(await total(), 0);
  });

  it("browsers (anon/authenticated) can't call the functions or touch the table", async () => {
    for (const actor of [{ role: "anon" } as const, { role: "authenticated", sub: "00000000-0000-4000-8000-000000000001" } as const]) {
      assert.match((await errorOf(as(db, actor, () => db.query("select public.add_snappy_taps(1)")))) ?? "", /permission denied/);
      assert.match((await errorOf(as(db, actor, () => db.query("select public.get_snappy_taps()")))) ?? "", /permission denied/);
      assert.match((await errorOf(as(db, actor, () => db.query("select * from public.snappy_counter")))) ?? "", /permission denied/);
      assert.match((await errorOf(as(db, actor, () => db.query("update public.snappy_counter set taps = 999999")))) ?? "", /permission denied/);
    }
  });
});

describe("upgrade from the sharded counter (000015)", () => {
  it("carries the existing total over into the single number", async () => {
    const dir = join(import.meta.dirname, "..", "..", "supabase", "migrations");
    const files = readdirSync(dir).filter((n) => n.endsWith(".sql")).sort();
    const up = newPGlite();
    await up.exec(readFileSync(join(import.meta.dirname, "supabase-shim.sql"), "utf8"));
    for (const f of files.filter((n) => n < "20261112000016")) await up.exec(readFileSync(join(dir, f), "utf8"));
    await up.exec("update public.snappy_tap_shards set taps = shard * 10"); // 0+10+…+150 = 1200
    await up.exec(readFileSync(join(dir, "20261112000016_snappy_counter_simplify.sql"), "utf8"));
    const t = (await up.query<{ t: string }>("select taps t from public.snappy_counter")).rows[0].t;
    assert.equal(Number(t), 1200);
    await up.close();
  });
});
