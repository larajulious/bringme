"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { setPreference } from "@/lib/site/consent";
import { IDLE_FLUSH_MS, MAX_BATCH } from "@/lib/snappy/constants";

const RETRY_MS = 15_000; // after a failed send, try again once the dust settles (never a tight loop)
const MAX_RETRIES = 3;
const MINE_KEY = "bm_snappy_taps";

function readMine(): number {
  try { return Number(window.localStorage.getItem(MINE_KEY)) || 0; } catch { return 0; }
}
function writeMine(n: number) {
  setPreference(MINE_KEY, String(n));
}

/**
 * Global boop counter, deliberately simple:
 * 1. on visit, load the total once;
 * 2. each tap is counted in the browser right away (shown as total + your unsent taps);
 * 3. once you stop tapping for 2 s (or reach MAX_BATCH, or leave the page) the batch is sent in ONE request and the
 *    server's new total replaces ours. A failed send keeps the taps and retries later, a few times at most.
 */
export function useBoopCounter() {
  const [server, setServer] = useState<number | null>(null);
  const [unsent, setUnsent] = useState(0);
  const [mine, setMine] = useState(0);
  const [offline, setOffline] = useState(false);
  const [settled, setSettled] = useState(false); // first load finished (success or failure)
  const queue = useRef(0);       // taps not yet confirmed by the server (includes an in-flight batch)
  const inFlight = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const retries = useRef(0);

  const send = useCallback(async (keepalive = false) => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    if (inFlight.current > 0 || queue.current === 0) return;
    const n = Math.min(queue.current, MAX_BATCH);
    inFlight.current = n;
    let ok = false;
    try {
      const res = await fetch("/api/snappy", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taps: n }), keepalive,
      });
      if (res.ok) {
        const { total } = (await res.json()) as { total: number };
        queue.current -= n;           // confirmed (any excess the server didn't count is simply dropped)
        setServer(total);
        setUnsent(queue.current);
        setOffline(false);
        retries.current = 0;
        ok = true;
      } else if (res.status === 400) {
        queue.current -= n;           // can't ever succeed: drop instead of retrying
        setUnsent(queue.current);
        ok = true;
      }
    } catch { /* network: keep the taps */ }
    inFlight.current = 0;
    if (!ok) {
      setOffline(true);
      if (++retries.current > MAX_RETRIES) { queue.current = 0; setUnsent(0); retries.current = 0; return; }
      timer.current = window.setTimeout(() => void send(), RETRY_MS);
    } else if (queue.current > 0) {
      timer.current = window.setTimeout(() => void send(), IDLE_FLUSH_MS);
    }
  }, []);

  useEffect(() => {
    // Restore the personal count after hydration (storage is client-only), then load the total once.
    setMine(readMine());
    let live = true;
    fetch("/api/snappy")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { total: number }) => { if (live) setServer(d.total); })
      .catch(() => { if (live) setOffline(true); })
      .finally(() => { if (live) setSettled(true); });
    const onHide = () => { if (document.visibilityState === "hidden") void send(true); };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onHide);
    return () => {
      live = false;
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onHide);
      window.clearTimeout(timer.current);
    };
  }, [send]);

  const tap = useCallback(() => {
    setMine((m) => { writeMine(m + 1); return m + 1; });
    queue.current += 1;
    setUnsent(queue.current);
    if (inFlight.current > 0) return;            // the in-flight response schedules the next send
    window.clearTimeout(timer.current);           // debounce: restart the 2 s idle countdown on every tap
    timer.current = queue.current >= MAX_BATCH
      ? window.setTimeout(() => void send(), 0)
      : window.setTimeout(() => void send(), IDLE_FLUSH_MS);
  }, [send]);

  return { total: server === null ? null : server + unsent, mine, offline, settled, tap };
}
