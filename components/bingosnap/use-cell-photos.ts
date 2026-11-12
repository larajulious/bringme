"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { CapturedPhoto, PhotoSource } from "@/lib/photos/process";
import { openPhotoStore, requestPersistence, type PhotoOwner, type PhotoStore, type PhotoSummary } from "@/lib/photos/store";

export type CellPhoto = { thumbUrl: string; takenAt: number; savedAt: number; source: PhotoSource; broken: boolean };

/**
 * One participant's local photos for one game: thumbnails as object URLs (created once per
 * saved photo, revoked when replaced, deleted or unmounted), plus save / replace / delete.
 * Full-size photos are read from IndexedDB only when opened. Only the photos of `cellIds`
 * (this player's card) are shown; `null` shows all of this player's photos for the game.
 */
export function useCellPhotos(owner: PhotoOwner | null, cellIds: readonly string[] | null) {
  const [store, setStore] = useState<PhotoStore | null>(null);
  const [photos, setPhotos] = useState<Record<string, CellPhoto>>({});
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const urls = useRef(new Map<string, { url: string; savedAt: number }>());
  const saving = useRef(0);
  const gameId = owner?.gameId ?? "";
  const playerId = owner?.playerId ?? "";
  const cellKey = cellIds ? cellIds.join(",") : null;

  useEffect(() => {
    let live = true;
    void openPhotoStore().then((s) => { if (live) setStore(s); });
    return () => { live = false; };
  }, []);

  const apply = useCallback((rows: PhotoSummary[]) => {
    const allowed = cellKey === null ? null : new Set(cellKey ? cellKey.split(",") : []);
    const next: Record<string, CellPhoto> = {};
    const keep = new Map<string, { url: string; savedAt: number }>();
    for (const r of rows) {
      if (allowed && !allowed.has(r.cellId)) continue;
      const old = urls.current.get(r.cellId);
      const url = old && old.savedAt === r.savedAt ? old.url : URL.createObjectURL(r.thumb);
      keep.set(r.cellId, { url, savedAt: r.savedAt });
      next[r.cellId] = { thumbUrl: url, takenAt: r.takenAt, savedAt: r.savedAt, source: r.source, broken: false };
    }
    for (const [id, u] of urls.current) if (keep.get(id)?.url !== u.url) URL.revokeObjectURL(u.url);
    urls.current = keep;
    setPhotos((prev) => {
      // keep "broken" marks for photos that are unchanged
      for (const [id, p] of Object.entries(next)) if (prev[id]?.broken && prev[id].savedAt === p.savedAt) p.broken = true;
      return next;
    });
  }, [cellKey]);

  const reload = useCallback(async () => {
    if (!store || !gameId || !playerId) return;
    try {
      apply(await store.list({ gameId, playerId }));
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoaded(true);
    }
  }, [store, gameId, playerId, apply]);

  // Restore after a refresh, and pick up changes made in another tab when coming back.
  useEffect(() => {
    void reload();
    const onVisible = () => { if (document.visibilityState === "visible") void reload(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [reload]);

  // Housekeeping: other games' photos older than a week (never this game's).
  useEffect(() => {
    if (store && gameId) void store.prune(gameId).catch(() => undefined);
  }, [store, gameId]);

  useEffect(() => () => {
    for (const u of urls.current.values()) URL.revokeObjectURL(u.url);
    urls.current.clear();
  }, []);

  // Warn before closing the tab in the middle of a save.
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => { if (saving.current > 0) e.preventDefault(); };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);

  const save = useCallback(async (cellId: string, photo: CapturedPhoto) => {
    if (!store || !gameId || !playerId) throw new Error("store_not_ready");
    saving.current++;
    try {
      await store.put({ gameId, playerId }, cellId, photo);
    } finally {
      saving.current--;
    }
    requestPersistence();
    await reload();
  }, [store, gameId, playerId, reload]);

  const remove = useCallback(async (cellId: string) => {
    if (!store || !gameId || !playerId) return;
    await store.remove({ gameId, playerId }, cellId);
    await reload();
  }, [store, gameId, playerId, reload]);

  const clearAll = useCallback(async () => {
    if (!store || !gameId || !playerId) return;
    await store.clear({ gameId, playerId });
    await reload();
  }, [store, gameId, playerId, reload]);

  const getImage = useCallback(
    (cellId: string) => (store && gameId && playerId ? store.getImage({ gameId, playerId }, cellId) : Promise.resolve(null)),
    [store, gameId, playerId],
  );

  /** A thumbnail failed to decode (its data was evicted or corrupted): show the square as missing. */
  const markBroken = useCallback((cellId: string) => {
    setPhotos((p) => (p[cellId] && !p[cellId].broken ? { ...p, [cellId]: { ...p[cellId], broken: true } } : p));
  }, []);

  return {
    ready: loaded,
    loadFailed,
    persistent: store?.persistent ?? true,
    photos,
    save,
    remove,
    clearAll,
    getImage,
    markBroken,
  };
}
