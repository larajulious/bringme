import type { EmailOtpType } from "@supabase/supabase-js";

/** OTP types an emailed token_hash link may carry (anything else is rejected before calling Supabase). */
const EMAIL_OTP_TYPES: readonly EmailOtpType[] = ["email", "signup", "magiclink", "invite", "recovery", "email_change"];

export function parseEmailOtpType(value: string | null): EmailOtpType | null {
  return EMAIL_OTP_TYPES.includes(value as EmailOtpType) ? (value as EmailOtpType) : null;
}

/** /auth/login?error=… keys shown by AuthNotice. */
export type ConfirmFailure = "link_expired" | "link_other_browser" | "link_invalid";

/**
 * Maps a failed confirmation to a friendly notice. Supabase reports both "expired" and
 * "already used" as otp_expired. A missing PKCE verifier means an old ?code= link was opened
 * in a browser other than the one that requested it.
 */
export function confirmFailure(error: { code?: string; name?: string } | null | undefined): ConfirmFailure {
  if (error?.code === "otp_expired") return "link_expired";
  if (error?.name === "AuthPKCECodeVerifierMissingError" || error?.code === "pkce_code_verifier_not_found") {
    return "link_other_browser";
  }
  return "link_invalid";
}

/**
 * Login-CSRF guard for the confirm POST: another site must not be able to auto-submit a form that
 * signs the visitor into someone else's account. Modern browsers send Sec-Fetch-Site; Origin is the
 * fallback. A request carrying neither (non-browser client) is allowed: it gains nothing a GET couldn't.
 */
export function isSameOriginPost(headers: { get(name: string): string | null }, allowedOrigins: readonly string[]): boolean {
  const site = headers.get("sec-fetch-site");
  if (site) return site === "same-origin" || site === "none";
  const origin = headers.get("origin");
  return origin === null || allowedOrigins.includes(origin);
}
