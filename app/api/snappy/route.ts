import { connection, NextResponse } from "next/server";

import { HttpError, handle, json, readJson } from "@/lib/api/http";
import { clientIp } from "@/lib/billing/polar";
import { createBucket, parseTaps } from "@/lib/snappy/limits";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Public homepage "Snappy boops" counter: one number, no history.
 * The browser counts taps locally and sends them once the visitor pauses (≥ 2 s idle, ≤ 500 per request).
 * Spam protection without storing anything about visitors (these buckets live in memory only):
 *  - requests: ~1 every 2 s per client, small burst → 429 beyond that;
 *  - taps: ~25/s sustained per client (an office can share one IP), burst 1,000 → the excess is silently not
 *    counted, so there's nothing to retry.
 * Put an edge/WAF rate limit in front in production for volumetric traffic.
 */
const requests = createBucket({ ratePerSec: 0.5, burst: 5 });
const taps = createBucket({ ratePerSec: 25, burst: 1_000 });

const unavailable = (code?: string) => code === "PGRST202" || code === "PGRST205" || code === "42883";

export async function GET() {
  await connection(); // always live (never prerendered at build time)
  return handle(async () => {
    const { data, error } = await createAdminClient().rpc("get_snappy_taps");
    if (error) throw new HttpError(unavailable(error.code) ? 503 : 500, "counter_unavailable");
    return NextResponse.json({ total: Number(data ?? 0) }, {
      headers: { "Cache-Control": "public, max-age=0, s-maxage=5, stale-while-revalidate=30" },
    });
  });
}

export async function POST(request: Request) {
  return handle(async () => {
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin) throw new HttpError(403, "cross_origin");

    const want = parseTaps(await readJson(request));
    if (want === null) throw new HttpError(400, "invalid_taps");

    const key = clientIp(request.headers) ?? "unknown";
    if (requests(key) === 0) {
      return NextResponse.json({ error: "slow_down" }, { status: 429, headers: { "Retry-After": "5", "Cache-Control": "no-store" } });
    }
    const accepted = taps(key, want);

    const admin = createAdminClient();
    const { data, error } = accepted > 0
      ? await admin.rpc("add_snappy_taps", { p_taps: accepted })
      : await admin.rpc("get_snappy_taps");
    if (error) throw new HttpError(unavailable(error.code) ? 503 : 500, "counter_unavailable");
    return json({ accepted, total: Number(data ?? 0) });
  });
}
