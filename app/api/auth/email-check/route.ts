import { NextResponse } from "next/server";

import { HttpError, handle, json, readJson } from "@/lib/api/http";
import { DISPOSABLE_EMAIL_MESSAGE } from "@/lib/auth/disposable";
import { isValidEmail, normalizeEmail } from "@/lib/auth/otp";
import { clientIp } from "@/lib/billing/polar";
import { createBucket } from "@/lib/snappy/limits";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Signup pre-check, called by "Create account" before Supabase is asked to create the user, so a temporary
 * address gets its error under the email field. It is a convenience, not the enforcement: the Supabase
 * "Before User Created" hook runs the same database check for every signup, including direct API calls.
 *
 * Answers only whether the email's DOMAIN is accepted; it never looks up accounts (no enumeration) and
 * never logs the address. If the check itself is unavailable it answers "allowed" and the hook decides.
 */
const requests = createBucket({ ratePerSec: 0.5, burst: 10 });

export async function POST(request: Request) {
  return handle(async () => {
    const origin = request.headers.get("origin");
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? new URL(request.url).host;
    const originHost = origin ? URL.canParse(origin) ? new URL(origin).host : null : host;
    if (originHost !== host.split(",")[0].trim()) throw new HttpError(403, "cross_origin");

    if (requests(clientIp(request.headers) ?? "unknown") === 0) {
      return NextResponse.json({ error: "slow_down" }, { status: 429, headers: { "Retry-After": "5", "Cache-Control": "no-store" } });
    }

    const raw = (await readJson(request)).email;
    const email = typeof raw === "string" ? normalizeEmail(raw) : "";
    if (!isValidEmail(email)) throw new HttpError(400, "invalid_email");

    const { data, error } = await createAdminClient().rpc("is_disposable_email", { p_email: email });
    if (error) {
      console.warn("[auth:email-check]", JSON.stringify({ errorCode: error.code ?? null }));
      return json({ allowed: true, checked: false });
    }
    return data === true
      ? json({ allowed: false, error: "disposable_email", message: DISPOSABLE_EMAIL_MESSAGE })
      : json({ allowed: true, checked: true });
  });
}
