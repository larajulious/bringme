import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { bingoErrorCode } from "../lib/bingosnap/error-codes.ts";
import { challengeCount, freeSpaceAllowed } from "../lib/bingosnap/types.ts";
import {
  parseBoardInput, parseClaimInput, parseReviewInput, parseSettingsInput, parseStartInput, parseTransitionInput,
} from "../lib/bingosnap/validation.ts";

const U = "8f14e45f-ceea-467a-9575-3f0a2a6f3c1b";
const U2 = "c9f0f895-fb98-4b91-8f3a-b1e2a0d0e8d7";

describe("parseBoardInput", () => {
  const base = { boardSize: 3, winMode: "traditional", cells: Array(9).fill("") };
  const err = (b: Record<string, unknown>, existing = false) => { const r = parseBoardInput(b, { existing }); return r.ok ? null : r.error; };
  it("accepts an empty draft and applies defaults", () => {
    const r = parseBoardInput(base, { existing: false });
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual([r.value.title, r.value.freeSpace, r.value.winnerRule, r.value.durationSeconds, r.value.publish, r.value.expectedRevision], ["", false, "ranked", 1200, false, null]);
  });
  it("keeps instructions by position and normalises them", () => {
    const r = parseBoardInput({ ...base, cells: ["  red\n shoes ", null, "", "", "", "", "", "", "a watch"] }, { existing: false });
    assert.ok(r.ok && r.value.cells[0] === "red shoes" && r.value.cells[1] === "" && r.value.cells[8] === "a watch");
  });
  it("enforces dimensions, free-centre rules, limits and strict keys", () => {
    assert.equal(err({ ...base, cells: Array(8).fill("") }), "invalid_board_dimensions");
    assert.equal(err({ ...base, boardSize: 5 }), "invalid_board_dimensions");
    assert.equal(err({ ...base, boardSize: 6, cells: Array(36).fill("") }), "invalid_board_size");
    assert.equal(err({ ...base, freeSpace: true, cells: ["", "", "", "", "centre", "", "", "", ""] }), "free_cell_not_editable");
    assert.equal(err({ boardSize: 4, winMode: "traditional", freeSpace: true, cells: Array(16).fill("") }), "free_space_not_allowed");
    assert.equal(err({ ...base, winMode: "full_card", freeSpace: true }), "free_space_not_allowed");
    assert.equal(err({ ...base, cells: ["x".repeat(121), ...Array(8).fill("")] }), "invalid_challenge");
    assert.equal(err({ ...base, cells: [7, ...Array(8).fill("")] }), "invalid_challenge");
    assert.equal(err({ ...base, durationSeconds: 179 }), "invalid_duration");
    assert.equal(err({ ...base, winMode: "line" }), "invalid_win_mode");
    assert.equal(err({ ...base, title: "x".repeat(81) }), "invalid_title");
    assert.equal(err({ ...base, ownerId: "x" }), "unexpected_fields");
    assert.equal(err({ ...base, publish: "yes" }), "invalid_publish");
  });
  it("needs the board revision when saving an existing board", () => {
    assert.equal(err(base, true), "invalid_revision");
    const r = parseBoardInput({ ...base, expectedRevision: 3, publish: true }, { existing: true });
    assert.ok(r.ok && r.value.expectedRevision === 3 && r.value.publish === true);
  });
  it("helpers agree with the database rules", () => {
    assert.deepEqual([challengeCount(3, true), challengeCount(4, false), challengeCount(5, true)], [8, 16, 24]);
    assert.deepEqual([freeSpaceAllowed(3, "traditional"), freeSpaceAllowed(4, "traditional"), freeSpaceAllowed(5, "full_card")], [true, false, false]);
  });
});

describe("strict claim / review / transition bodies (nothing can ride along)", () => {
  it("claims accept only { cellIds: uuid[], requestId?: uuid }", () => {
    assert.deepEqual(parseClaimInput({ cellIds: [U, U2.toUpperCase()] }), { ok: true, value: { cellIds: [U, U2], requestId: null } });
    assert.deepEqual(parseClaimInput({ cellIds: [U], requestId: U2.toUpperCase() }), { ok: true, value: { cellIds: [U], requestId: U2 } });
    assert.deepEqual(parseClaimInput({ cellIds: [U], requestId: null }), { ok: true, value: { cellIds: [U], requestId: null } });
    assert.deepEqual(parseClaimInput({ cellIds: [U], requestId: "retry-1" }), { ok: false, error: "invalid_request_id" });
    assert.deepEqual(parseClaimInput({ cellIds: [U], requestId: 7 }), { ok: false, error: "invalid_request_id" });
    assert.deepEqual(parseClaimInput({ cellIds: [U], submittedAt: new Date().toISOString() }), { ok: false, error: "unexpected_fields" }, "no client timestamps");
    assert.deepEqual(parseClaimInput({ cellIds: [U], photo: "data:image/jpeg;base64,AAAA" }), { ok: false, error: "unexpected_fields" });
    assert.deepEqual(parseClaimInput({ cellIds: [U], thumbnails: [] }), { ok: false, error: "unexpected_fields" });
    assert.deepEqual(parseClaimInput({ cellIds: [U, U] }), { ok: false, error: "invalid_cells" });
    assert.deepEqual(parseClaimInput({ cellIds: ["not-a-uuid"] }), { ok: false, error: "invalid_cells" });
    assert.deepEqual(parseClaimInput({ cellIds: [] }), { ok: false, error: "invalid_cells" });
    assert.deepEqual(parseClaimInput({ cellIds: Array.from({ length: 26 }, () => crypto.randomUUID()) }), { ok: false, error: "invalid_cells" });
  });
  it("reviews accept a decision and an optional reason (reject only)", () => {
    assert.deepEqual(parseReviewInput({ decision: "reject", reason: "  photo   missing " }), { ok: true, value: { decision: "reject", reason: "photo missing" } });
    assert.deepEqual(parseReviewInput({ decision: "verify", reason: "" }), { ok: true, value: { decision: "verify", reason: null } });
    assert.deepEqual(parseReviewInput({ decision: "verify", reason: "ok" }), { ok: false, error: "invalid_reason" });
    assert.deepEqual(parseReviewInput({ decision: "approve" }), { ok: false, error: "invalid_decision" });
    assert.deepEqual(parseReviewInput({ decision: "verify", playerId: U }), { ok: false, error: "unexpected_fields" });
    assert.deepEqual(parseReviewInput({ decision: "reject", reason: "x".repeat(121) }), { ok: false, error: "invalid_reason" });
  });
  it("transitions and settings", () => {
    assert.deepEqual(parseTransitionInput({ action: "start_hunt", expectedVersion: 3 }), { ok: true, value: { action: "start_hunt", expectedVersion: 3, winnerSubmissionId: null } });
    assert.deepEqual(parseTransitionInput({ action: "start_round", expectedVersion: 3 }), { ok: false, error: "invalid_action" });
    assert.deepEqual(parseTransitionInput({ action: "end_game", expectedVersion: -1 }), { ok: false, error: "invalid_version" });
    assert.deepEqual(parseTransitionInput({ action: "announce_results", expectedVersion: 1, winnerSubmissionId: "x" }), { ok: false, error: "invalid_winner" });
    assert.deepEqual(parseSettingsInput({ expectedVersion: 1, winnerRule: "first" }), { ok: true, value: { expectedVersion: 1, winnerRule: "first" } });
    assert.deepEqual(parseSettingsInput({ expectedVersion: 1, winnerRule: "first", boardSize: 5 }), { ok: false, error: "unexpected_fields" });
  });
});

describe("error mapping", () => {
  it("maps BingoSnap errors, preferring the most specific message", () => {
    assert.deepEqual(bingoErrorCode("earlier_claim_pending"), [409, "earlier_claim_pending"]);
    assert.deepEqual(bingoErrorCode("claim_pending"), [409, "claim_pending"]);
    assert.deepEqual(bingoErrorCode("invalid_winner_rule"), [400, "invalid_winner_rule"]);
    assert.deepEqual(bingoErrorCode("invalid_pattern"), [422, "invalid_pattern"]);
    assert.deepEqual(bingoErrorCode("wrong_game_type"), [409, "wrong_game_type"]);
    assert.equal(bingoErrorCode("subscription_required"), null, "falls back to the shared mapping");
  });
});

describe("no photo path exists in the BingoSnap backend", () => {
  const ROOT = join(import.meta.dirname, "..");
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
  it("BingoSnap server code never touches Storage, signed URLs, uploads or image data", () => {
    const sources = [...files(join(ROOT, "lib", "bingosnap")), ...files(join(ROOT, "app", "api", "host", "bingosnap")), ...files(join(ROOT, "app", "api", "play", "bingosnap"))];
    assert.ok(sources.length >= 10);
    for (const f of sources) {
      const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""); // code only, not comments
      assert.doesNotMatch(src, /\.storage\b|createSigned|upload|FormData|Blob|base64|image\/|exif/i, f);
    }
  });
  it("the BingoSnap migrations define no photo-shaped column", () => {
    const sql = ["20261112000017_bingosnap_schema.sql", "20261112000018_bingosnap_functions.sql"]
      .map((f) => readFileSync(join(ROOT, "supabase", "migrations", f), "utf8").replace(/--.*$/gm, ""))
      .join("\n");
    assert.doesNotMatch(sql, /storage\.|photo|image|thumbnail|base64|exif|bytea/i);
  });
});

describe("parseStartInput (Phase 5)", () => {
  it("accepts only the version the host saw", () => {
    assert.deepEqual(parseStartInput({ expectedVersion: 7 }), { ok: true, value: { expectedVersion: 7 } });
    assert.deepEqual(parseStartInput({}), { ok: false, error: "invalid_version" });
    assert.deepEqual(parseStartInput({ expectedVersion: -1 }), { ok: false, error: "invalid_version" });
    assert.deepEqual(parseStartInput({ expectedVersion: "7" }), { ok: false, error: "invalid_version" });
    assert.deepEqual(parseStartInput({ expectedVersion: 1.5 }), { ok: false, error: "invalid_version" });
    assert.deepEqual(parseStartInput({ expectedVersion: 7, maxPlayers: 500 }), { ok: false, error: "unexpected_fields" }, "no caps or roles from the client");
  });
});
