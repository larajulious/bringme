"use client";

import { createClient as createPlainClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useRef, useState } from "react";

import { ClockSync } from "@/lib/game/clock";
import { GameSyncCore, clockOffset, type FetchResult } from "@/lib/game/sync";
import { createClient as createBrowserClient } from "@/lib/supabase/client";

export type Conn = "connecting" | "live" | "basic" | "reconnecting" | "offline";

const SAFETY_RESYNC_MS = 30_000; // Broadcast is at-most-once: a slow consistency check, not polling
const FALLBACK_POLL_MS = 4_000; // only while Realtime is unavailable
const FALLBACK_GRACE_MS = 6_000;

type Snap = { version: number; serverNow: string; countdownEndsAt: string | null; round?: { openedAt: string | null } | null };

/**
 * Keeps one game's authoritative state in sync on this device.
 *  - Realtime Broadcast (private channel) delivers "something changed" hints.
 *  - Every hint, reconnect, tab focus and timer boundary triggers a re-read of
 *    the authoritative snapshot; stale snapshots are discarded (GameSyncCore).
 *  - If Realtime can't be used, it degrades to a slow poll and says so ("basic").
 */
export function useGameSync<S extends Snap>(opts: {
  gameId: string;
  role: "guest" | "host";
  initial: S;
  fetchSnapshot: () => Promise<FetchResult<S>>;
  /** Guests only: where the short-lived channel token comes from (BingoSnap has its own). */
  tokenUrl?: string;
  /** A server deadline read from the current state (e.g. BingoSnap's hunt end): re-read right after it, and again after the 2 s claim grace. */
  deadlineOf?: (s: S) => string | null;
}) {
  const { gameId, role } = opts;
  const tokenUrl = opts.tokenUrl ?? "/api/play/realtime-token";
  const [state, setState] = useState<S>(opts.initial);
  const [rt, setRt] = useState<"connecting" | "subscribed" | "down">("connecting");
  const [online, setOnline] = useState(true);
  const [unauthorized, setUnauthorized] = useState(false);
  const [offsetMs, setOffsetMs] = useState(() => Date.parse(opts.initial.serverNow) - Date.now());
  const core = useRef<GameSyncCore<S> | null>(null);
  const bestRtt = useRef(Number.POSITIVE_INFINITY);
  /** Monotonic client↔server clock estimate (performance.now based), used for capture timing. */
  const [clock] = useState(() => new ClockSync());
  const fetchRef = useRef(opts.fetchSnapshot);
  fetchRef.current = opts.fetchSnapshot;

  // ---- core
  useEffect(() => {
    const c = new GameSyncCore<S>({
      initial: opts.initial,
      fetch: async () => {
        const t0 = Date.now();
        const m0 = performance.now();
        const r = await fetchRef.current();
        const m1 = performance.now();
        const t1 = Date.now();
        if (r.status === "ok") clock.addSample(Date.parse(r.state.serverNow), m0, m1);
        if (r.status === "ok" && t1 - t0 <= bestRtt.current + 50) {
          bestRtt.current = Math.min(bestRtt.current, t1 - t0);
          setOffsetMs(clockOffset(r.state.serverNow, t0, t1));
        }
        return r;
      },
      onState: (s) => setState(s),
      onUnauthorized: () => setUnauthorized(true),
    });
    core.current = c;
    void c.resync(); // the server-rendered snapshot may already be a little old
    return () => c.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId]);

  const resync = useCallback(() => void core.current?.resync(), []);
  /** A few quick round trips (kept: the lowest-RTT one) so capture timing starts from a good clock estimate. */
  const syncBurst = useCallback(async () => {
    for (let i = 0; i < 4; i++) {
      const m0 = performance.now();
      const r = await fetchRef.current().catch(() => null);
      const m1 = performance.now();
      if (r?.status === "ok") clock.addSample(Date.parse(r.state.serverNow), m0, m1);
      await new Promise((res) => setTimeout(res, 150));
    }
  }, [clock]);
  /** Apply a state we got from our own action (strictly newer only). */
  const applyState = useCallback((s: S) => core.current?.applyIfNewer(s) ?? false, []);

  // ---- Realtime (Broadcast hints on a private channel)
  useEffect(() => {
    let cancelled = false;
    let client: SupabaseClient | null = null;
    let channel: RealtimeChannel | null = null;
    let refresh: ReturnType<typeof setTimeout> | undefined;

    const start = async () => {
      try {
        if (role === "guest") {
          const fetchToken = async () => {
            const res = await fetch(tokenUrl, { cache: "no-store" });
            if (res.status === 401) { resync(); throw new Error("unauthorized"); }
            if (!res.ok) throw new Error("unavailable");
            return (await res.json()) as { token: string; expiresAt: number };
          };
          const first = await fetchToken();
          if (cancelled) return;
          client = createPlainClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
            auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
          });
          client.realtime.setAuth(first.token);
          const scheduleRefresh = (expiresAt: number) => {
            refresh = setTimeout(async () => {
              try {
                const next = await fetchToken();
                client?.realtime.setAuth(next.token);
                scheduleRefresh(next.expiresAt);
              } catch { /* the safety resync / fallback polling keep us correct */ }
            }, Math.max(30_000, expiresAt - Date.now() - 5 * 60_000));
          };
          scheduleRefresh(first.expiresAt);
        } else {
          client = createBrowserClient();
          const { data } = await client.auth.getSession();
          if (data.session) client.realtime.setAuth(data.session.access_token);
        }
        if (cancelled || !client) return;
        channel = client.channel(`game:${gameId}`, { config: { private: true } });
        channel.on("broadcast", { event: "state" }, (msg) => core.current?.handleSignal(msg.payload));
        channel.subscribe((status) => {
          if (cancelled) return;
          if (status === "SUBSCRIBED") {
            setRt("subscribed");
            resync(); // first connect AND every reconnect: catch up on whatever we missed
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            setRt("down");
          }
        });
      } catch {
        if (!cancelled) setRt("down");
      }
    };
    void start();
    return () => {
      cancelled = true;
      clearTimeout(refresh);
      if (channel) void client?.removeChannel(channel);
    };
  }, [gameId, role, resync, tokenUrl]);

  // ---- network / visibility
  useEffect(() => {
    setOnline(navigator.onLine);
    const on = () => { setOnline(true); resync(); };
    const off = () => setOnline(false);
    const vis = () => { if (document.visibilityState === "visible") resync(); };
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    window.addEventListener("focus", resync);
    document.addEventListener("visibilitychange", vis);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
      window.removeEventListener("focus", resync);
      document.removeEventListener("visibilitychange", vis);
    };
  }, [resync]);

  // ---- slow safety net while subscribed; slow polling only while Realtime is unavailable
  useEffect(() => {
    const visibleResync = () => { if (document.visibilityState === "visible") resync(); };
    if (rt === "subscribed") {
      const id = setInterval(visibleResync, SAFETY_RESYNC_MS);
      return () => clearInterval(id);
    }
    let id: ReturnType<typeof setInterval> | undefined;
    const grace = setTimeout(() => { id = setInterval(visibleResync, FALLBACK_POLL_MS); }, rt === "down" ? 0 : FALLBACK_GRACE_MS);
    return () => { clearTimeout(grace); clearInterval(id); };
  }, [rt, resync]);

  // ---- server-timestamp boundaries: re-read exactly when the countdown ends / the round officially starts
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const iso of [state.countdownEndsAt, state.round?.openedAt ?? null]) {
      if (!iso) continue;
      const wait = Date.parse(iso) - (Date.now() + offsetMs);
      if (wait > -2000 && wait < 15_000) timers.push(setTimeout(resync, Math.max(0, wait) + 60));
    }
    return () => timers.forEach(clearTimeout);
  }, [state.version, state.countdownEndsAt, state.round?.openedAt, offsetMs, resync]);

  // ---- an optional long deadline (no 15 s window: a hunt can last two hours)
  const deadlineAt = opts.deadlineOf?.(state) ?? null;
  useEffect(() => {
    if (!deadlineAt) return;
    const wait = Date.parse(deadlineAt) - (Date.now() + offsetMs);
    if (!(wait > -3000) || wait > 3 * 3600_000) return;
    const timers = [setTimeout(resync, Math.max(0, wait) + 60), setTimeout(resync, Math.max(0, wait) + 2200)];
    return () => timers.forEach(clearTimeout);
  }, [deadlineAt, offsetMs, resync]);

  const conn: Conn = !online ? "offline" : rt === "subscribed" ? "live" : rt === "down" ? "basic" : "connecting";
  return { state, conn, offsetMs, unauthorized, resync, applyState, clock, syncBurst };
}

/** Re-renders every `intervalMs` while `enabled` (for countdowns and timers). */
export function useNow(enabled: boolean, intervalMs = 100): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs]);
  return now;
}
