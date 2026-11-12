/**
 * Request-shape validation for BingoSnap (pure, unit-tested). The database
 * re-validates everything; this gives early, friendly errors.
 *
 * Claim and review bodies are STRICT: unknown keys are refused, so nothing
 * (e.g. a photo, data URL or thumbnail) can ride along with a request.
 */
import type { Parsed } from "@/lib/admin/validation";
import { TITLE_MAX_LENGTH } from "../host/validation.ts";
import {
  BINGO_ACTIONS, BOARD_SIZES, CHALLENGE_MAX_LENGTH, DEFAULT_DURATION_SECONDS, MAX_DURATION_SECONDS, MIN_DURATION_SECONDS,
  REASON_MAX_LENGTH, REVIEW_DECISIONS, WIN_MODES, WINNER_RULES, freeSpaceAllowed,
  type BingoAction, type BoardSize, type ReviewDecision, type WinMode, type WinnerRule,
} from "./types.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();

function onlyKeys(body: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(body).every((k) => allowed.includes(k));
}

export type BoardInput = {
  title: string;
  boardSize: BoardSize;
  winMode: WinMode;
  freeSpace: boolean;
  winnerRule: WinnerRule;
  durationSeconds: number;
  /** One entry per position, row-major (length size²); "" = empty square. */
  cells: string[];
  publish: boolean;
  /** Required when saving an existing board (optimistic concurrency). */
  expectedRevision: number | null;
};

const BOARD_KEYS = ["title", "boardSize", "winMode", "freeSpace", "winnerRule", "durationSeconds", "cells", "publish", "expectedRevision"] as const;

/**
 * A board save (draft or publish). Drafts may have empty squares and duplicates;
 * completeness for publishing is checked by the database (bingo_board_problem).
 * Positions are implicit (array index), so no two instructions can share a square.
 */
export function parseBoardInput(body: Record<string, unknown>, opts: { existing: boolean }): Parsed<BoardInput> {
  if (!onlyKeys(body, BOARD_KEYS)) return { ok: false, error: "unexpected_fields" };
  let title = "";
  if (body.title !== undefined && body.title !== null) {
    if (typeof body.title !== "string") return { ok: false, error: "invalid_title" };
    title = clean(body.title);
    if (title.length > TITLE_MAX_LENGTH) return { ok: false, error: "invalid_title" };
  }

  const boardSize = BOARD_SIZES.find((s) => s === body.boardSize);
  if (!boardSize) return { ok: false, error: "invalid_board_size" };
  const winMode = WIN_MODES.find((m) => m === body.winMode);
  if (!winMode) return { ok: false, error: "invalid_win_mode" };
  const winnerRule = body.winnerRule === undefined ? "ranked" : WINNER_RULES.find((r) => r === body.winnerRule);
  if (!winnerRule) return { ok: false, error: "invalid_winner_rule" };

  if (body.freeSpace !== undefined && typeof body.freeSpace !== "boolean") return { ok: false, error: "invalid_free_space" };
  const freeSpace = body.freeSpace === true;
  if (freeSpace && !freeSpaceAllowed(boardSize, winMode)) return { ok: false, error: "free_space_not_allowed" };

  const durationSeconds = body.durationSeconds === undefined ? DEFAULT_DURATION_SECONDS : body.durationSeconds;
  if (!Number.isSafeInteger(durationSeconds) || (durationSeconds as number) < MIN_DURATION_SECONDS || (durationSeconds as number) > MAX_DURATION_SECONDS) {
    return { ok: false, error: "invalid_duration" };
  }

  if (!Array.isArray(body.cells) || body.cells.length !== boardSize * boardSize) return { ok: false, error: "invalid_board_dimensions" };
  const centre = freeSpace ? (boardSize * boardSize - 1) / 2 : -1;
  const cells: string[] = [];
  for (const [i, raw] of body.cells.entries()) {
    if (raw !== null && typeof raw !== "string") return { ok: false, error: "invalid_challenge" };
    const c = clean(raw ?? "");
    if (c.length > CHALLENGE_MAX_LENGTH) return { ok: false, error: "invalid_challenge" };
    if (i === centre && c) return { ok: false, error: "free_cell_not_editable" };
    cells.push(c);
  }

  if (body.publish !== undefined && typeof body.publish !== "boolean") return { ok: false, error: "invalid_publish" };
  let expectedRevision: number | null = null;
  if (opts.existing) {
    if (!Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 0) return { ok: false, error: "invalid_revision" };
    expectedRevision = body.expectedRevision as number;
  }

  return { ok: true, value: { title, boardSize, winMode, freeSpace, winnerRule, durationSeconds: durationSeconds as number, cells, publish: body.publish === true, expectedRevision } };
}

/** `{ cellIds: uuid[] }` and nothing else. */
export function parseClaimInput(body: Record<string, unknown>): Parsed<{ cellIds: string[]; requestId: string | null }> {
  if (!onlyKeys(body, ["cellIds", "requestId"])) return { ok: false, error: "unexpected_fields" };
  const ids = body.cellIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 25 || !ids.every(isUuid)) return { ok: false, error: "invalid_cells" };
  const lower = ids.map((id) => id.toLowerCase());
  if (new Set(lower).size !== lower.length) return { ok: false, error: "invalid_cells" };
  // Optional idempotency key: the same id on a retry returns the existing claim.
  if (body.requestId !== undefined && body.requestId !== null && !isUuid(body.requestId)) return { ok: false, error: "invalid_request_id" };
  const requestId = typeof body.requestId === "string" ? body.requestId.toLowerCase() : null;
  return { ok: true, value: { cellIds: lower, requestId } };
}

/** `{ decision, reason? }`; a reason only for rejections. */
export function parseReviewInput(body: Record<string, unknown>): Parsed<{ decision: ReviewDecision; reason: string | null }> {
  if (!onlyKeys(body, ["decision", "reason"])) return { ok: false, error: "unexpected_fields" };
  const decision = REVIEW_DECISIONS.find((d) => d === body.decision);
  if (!decision) return { ok: false, error: "invalid_decision" };
  let reason: string | null = null;
  if (body.reason !== undefined && body.reason !== null) {
    if (typeof body.reason !== "string") return { ok: false, error: "invalid_reason" };
    reason = clean(body.reason) || null;
    if (reason && (decision !== "reject" || reason.length > REASON_MAX_LENGTH)) return { ok: false, error: "invalid_reason" };
  }
  return { ok: true, value: { decision, reason } };
}

export function parseTransitionInput(body: Record<string, unknown>): Parsed<{ action: BingoAction; expectedVersion: number; winnerSubmissionId: string | null }> {
  if (!onlyKeys(body, ["action", "expectedVersion", "winnerSubmissionId"])) return { ok: false, error: "unexpected_fields" };
  const action = BINGO_ACTIONS.find((a) => a === body.action);
  if (!action) return { ok: false, error: "invalid_action" };
  if (!Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number) < 0) return { ok: false, error: "invalid_version" };
  let winnerSubmissionId: string | null = null;
  if (body.winnerSubmissionId !== undefined && body.winnerSubmissionId !== null) {
    if (!isUuid(body.winnerSubmissionId)) return { ok: false, error: "invalid_winner" };
    winnerSubmissionId = body.winnerSubmissionId.toLowerCase();
  }
  return { ok: true, value: { action, expectedVersion: body.expectedVersion as number, winnerSubmissionId } };
}

/** Start the game (lobby -> countdown -> hunt). Only the version the host saw is accepted. */
export function parseStartInput(body: Record<string, unknown>): Parsed<{ expectedVersion: number }> {
  if (!onlyKeys(body, ["expectedVersion"])) return { ok: false, error: "unexpected_fields" };
  if (!Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number) < 0) return { ok: false, error: "invalid_version" };
  return { ok: true, value: { expectedVersion: body.expectedVersion as number } };
}

export function parseSettingsInput(body: Record<string, unknown>): Parsed<{ expectedVersion: number; winnerRule: WinnerRule }> {
  if (!onlyKeys(body, ["expectedVersion", "winnerRule"])) return { ok: false, error: "unexpected_fields" };
  if (!Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number) < 0) return { ok: false, error: "invalid_version" };
  const winnerRule = WINNER_RULES.find((r) => r === body.winnerRule);
  if (!winnerRule) return { ok: false, error: "invalid_winner_rule" };
  return { ok: true, value: { expectedVersion: body.expectedVersion as number, winnerRule } };
}
