"use client";

import type { FetchResult } from "@/lib/game/sync";

/** TV link endpoints (public; the token in the path is the credential). */
export const screenApi = (token: string) => `/api/screen/${token}`;

/** Snapshot for a TV link. 404 = the link was reset (or never existed): treated as "unauthorized". */
export async function fetchScreenSnapshot<S>(token: string): Promise<FetchResult<S>> {
  const r = await fetch(`${screenApi(token)}/state`, { cache: "no-store" }).catch(() => null);
  if (!r) return { status: "error" };
  if (r.status === 404 || r.status === 401) return { status: "unauthorized" };
  if (!r.ok) return { status: "error" };
  return { status: "ok", state: (await r.json()) as S };
}
