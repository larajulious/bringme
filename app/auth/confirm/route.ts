import { NextResponse, type NextRequest } from "next/server";

import { confirmFailure, isSameOriginPost, parseEmailOtpType } from "@/lib/auth/confirm";
import { safeNext } from "@/lib/auth/redirect";
import { redirectBase } from "@/lib/site/url";
import { createClient } from "@/lib/supabase/server";

type AuthErrorLike = { code?: string; name?: string } | null | undefined;

/**
 * Email links land here.
 *   GET ?token_hash=…&type=email  (Confirm signup template). NOT verified on GET: email security
 *     scanners prefetch links and would use up the one-time token. Forwarded to /auth/verify, whose
 *     "Confirm my email" button POSTs back here.
 *   POST token_hash + type  Verified on the server with verifyOtp, so it works in ANY browser or device
 *     (nothing from the signup browser is needed). The per-request server client writes the session
 *     cookies onto the 303 redirect.
 *   GET ?code=…  Older {{ .ConfirmationURL }} links still in inboxes. PKCE: only works in the browser
 *     that requested it (the code verifier cookie lives there), and unusable by scanners for the same reason.
 *   GET ?error_code=…  Supabase's own verify step failed (expired / used) and sent the user back here.
 * Tokens are never logged; only Supabase's error code is.
 */
function responses(request: NextRequest) {
  const requestOrigin = new URL(request.url).origin;
  const origin = redirectBase(requestOrigin);
  const redirect = (path: string, status = 307) => {
    const res = NextResponse.redirect(new URL(path, origin), status);
    res.headers.set("Cache-Control", "no-store");
    return res;
  };
  const fail = (error: AuthErrorLike, method: string, status?: number) => {
    console.warn("[auth:confirm]", JSON.stringify({ method, errorCode: error?.code ?? null }));
    return redirect(`/auth/login?error=${confirmFailure(error)}`, status);
  };
  return { origin, requestOrigin, redirect, fail };
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const { redirect, fail } = responses(request);

  const providerError = searchParams.get("error_code");
  if (providerError) return fail({ code: providerError }, "provider");

  const tokenHash = searchParams.get("token_hash");
  const type = parseEmailOtpType(searchParams.get("type"));
  if (tokenHash && type) {
    const verify = new URLSearchParams({ token_hash: tokenHash, type });
    const next = searchParams.get("next");
    if (next) verify.set("next", safeNext(next, "/auth/continue"));
    return redirect(`/auth/verify?${verify}`);
  }

  const code = searchParams.get("code");
  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    return error ? fail(error, "code") : redirect(safeNext(searchParams.get("next"), "/auth/continue"));
  }
  return fail(null, "missing_params");
}

export async function POST(request: NextRequest) {
  const { origin, requestOrigin, redirect, fail } = responses(request);
  // 303: the browser follows with a GET (never re-POSTs the form).
  if (!isSameOriginPost(request.headers, [origin, requestOrigin])) return fail(null, "cross_site", 303);

  const form = await request.formData().catch(() => null);
  const tokenHash = form?.get("token_hash");
  const type = parseEmailOtpType(typeof form?.get("type") === "string" ? (form.get("type") as string) : null);
  if (typeof tokenHash !== "string" || !tokenHash || !type) return fail(null, "missing_params", 303);

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
  if (error) return fail(error, "token_hash", 303);
  const next = form?.get("next");
  return redirect(safeNext(typeof next === "string" ? next : null, "/auth/continue"), 303);
}
