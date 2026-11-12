"use client";

import type { FetchResult } from "@/lib/game/sync";
import type { HostAction, HostSnapshot } from "@/lib/game/types";
import { createClient } from "@/lib/supabase/client";

/** Authoritative host snapshot, read under the host's own session (RLS-style owner check in SQL). */
export async function fetchHostSnapshot(gameId: string): Promise<FetchResult<HostSnapshot>> {
  const { data, error } = await createClient().rpc("host_game_state", { p_game: gameId });
  if (error) return error.code === "42501" || /JWT|auth/i.test(error.message) ? { status: "unauthorized" } : { status: "error" };
  return data ? { status: "ok", state: data as unknown as HostSnapshot } : { status: "error" };
}

export async function fetchRoster(gameId: string): Promise<{ id: string; nickname: string }[] | null> {
  const { data, error } = await createClient()
    .from("players")
    .select("id, nickname")
    .eq("game_id", gameId)
    .is("kicked_at", null)
    .order("joined_at", { ascending: true });
  return error ? null : data;
}

export type TransitionResult = { ok: true; state: HostSnapshot } | { ok: false; error: string };

export async function postTransition(gameId: string, action: HostAction, expectedVersion: number, winnerPlayerId?: string | null): Promise<TransitionResult> {
  try {
    const res = await fetch(`/api/host/games/${gameId}/transition`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, expectedVersion, winnerPlayerId: winnerPlayerId ?? undefined }),
    });
    const body = (await res.json().catch(() => ({}))) as { state?: HostSnapshot; error?: string };
    return res.ok && body.state ? { ok: true, state: body.state } : { ok: false, error: body.error ?? "request_failed" };
  } catch {
    return { ok: false, error: "network" };
  }
}

const phaseKey = (s: HostSnapshot) => `${s.status}|${s.phase}|${s.round?.no ?? "-"}|${s.round?.status ?? "-"}`;

/**
 * Run a Game Master action. If it was made against an older state ("stale"),
 * re-read the authoritative state: when only the version moved (e.g. a player
 * joined meanwhile) retry once; if the game itself changed (another tab, a
 * double click that already worked) do NOT act, and return the fresh state.
 */
export async function runAction(
  gameId: string, action: HostAction, currentVersion: number, currentKey: string, winnerPlayerId?: string | null,
): Promise<{ result: TransitionResult; changedUnderneath?: HostSnapshot }> {
  let result = await postTransition(gameId, action, currentVersion, winnerPlayerId);
  if (result.ok || result.error !== "stale_state") return { result };

  const fresh = await fetchHostSnapshot(gameId);
  if (fresh.status !== "ok") return { result };
  if (phaseKey(fresh.state) !== currentKey) return { result, changedUnderneath: fresh.state };
  result = await postTransition(gameId, action, fresh.state.version, winnerPlayerId);
  return { result };
}
export { phaseKey };
