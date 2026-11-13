"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { LiveSubmission } from "@/components/game/review-panel";
import { SubmissionPhotoLoader, type ListingResult } from "@/lib/game/photo-url-cache";

export type PhotoRow = LiveSubmission & { photoKey: string | null };

/**
 * The current round's ranked photos for the host console (`view: "host"`) or the presenter
 * (`view: "presenter"`: names + the official winner's photo only). Phase 3:
 *  - re-read when `dep` changes (the database's submissions fingerprint, see refresh-keys.ts);
 *  - photos this screen already holds are not signed again (in-memory, this tab and game only);
 *  - refreshed on its own before a shown URL expires, and when a picture fails to load.
 */
export function useSubmissionRows(gameId: string, opts: { view: "host" | "presenter"; enabled: boolean; dep: string; url?: string }) {
  const { view, enabled, dep } = opts;
  const base = opts.url ?? `/api/host/games/${gameId}/submissions`;
  /** The host route serves both views; a custom route (TV link) is presenter-only already. */
  const viewQuery = view === "presenter" && !opts.url;
  const [rows, setRows] = useState<PhotoRow[] | null>(null);
  const [error, setError] = useState(false);
  const loader = useRef<SubmissionPhotoLoader<PhotoRow> | null>(null);

  useEffect(() => {
    if (!enabled) { setRows(null); return; }
    const l = new SubmissionPhotoLoader<PhotoRow>({
      fetchListing: async (have): Promise<ListingResult<PhotoRow>> => {
        const q = new URLSearchParams();
        if (viewQuery) q.set("view", "presenter");
        if (have.length) q.set("have", have.join(","));
        const res = await fetch(`${base}${q.size ? `?${q}` : ""}`, { cache: "no-store" }).catch(() => null);
        if (!res) return { status: "error" };
        if (res.status === 401 || res.status === 403 || res.status === 404) return { status: "fatal" };
        if (!res.ok) return { status: "error" };
        const data = (await res.json()) as { submissions: PhotoRow[]; ttlSeconds?: number };
        return { status: "ok", rows: data.submissions.map((r) => ({ ...r, photoKey: r.photoKey ?? null })), ttlSeconds: data.ttlSeconds ?? 120 };
      },
      onRows: (r) => { setRows(r); setError(false); },
      onError: () => setError(true),
    });
    loader.current = l;
    return () => { l.stop(); if (loader.current === l) loader.current = null; };
  }, [gameId, view, enabled, base, viewQuery]);

  // Every change of the list's data (a photo, a decision, a removal, the round/phase/winner) re-reads it once.
  useEffect(() => {
    if (enabled) void loader.current?.load();
  }, [enabled, dep]);

  const reload = useCallback(() => { void loader.current?.load(); }, []);
  /** An <img> failed (expired, revoked, network): fetch a fresh URL for it (throttled per photo). */
  const photoFailed = useCallback((row: { photoKey?: string | null }) => loader.current?.photoFailed(row), []);
  return { rows, error, reload, photoFailed };
}
