import { type EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";

import { safeNext } from "@/lib/auth/redirect";
import { redirectBase } from "@/lib/site/url";
import { createClient } from "@/lib/supabase/server";

/**
 * Email links land here (older confirmation/magic links, email change). Sign-in itself uses
 * the emailed code on /auth/login; this route stays for links already sitting in inboxes.
 * Supports both the token_hash template and the default PKCE `code` link.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin: requestOrigin } = new URL(request.url);
  const origin = redirectBase(requestOrigin);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const code = searchParams.get("code");
  const next = safeNext(searchParams.get("next"), "/auth/continue");

  const supabase = await createClient();
  let failed = true;

  if (tokenHash && type) {
    failed = !!(await supabase.auth.verifyOtp({ type, token_hash: tokenHash })).error;
  } else if (code) {
    failed = !!(await supabase.auth.exchangeCodeForSession(code)).error;
  }

  if (failed) {
    return NextResponse.redirect(new URL("/auth/error?error=link_invalid", origin));
  }
  return NextResponse.redirect(new URL(next, origin));
}
