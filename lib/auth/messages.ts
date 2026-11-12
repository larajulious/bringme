/** Maps Supabase auth errors to friendly, non-leaky copy. */
export function friendlyAuthError(error: unknown): string {
  const e = error as { code?: string; name?: string; status?: number } | null;
  if (isNetworkError(e)) return "We couldn't reach Bring Me. Check your connection and try again.";
  switch (e?.code) {
    case "otp_expired":
      return "That code is incorrect or has expired. Check it, or request a new code.";
    case "email_address_invalid":
    case "validation_failed":
      return "Please enter a valid email address.";
    case "over_request_rate_limit":
    case "over_email_send_rate_limit":
      return "Too many attempts. Please wait a minute and try again.";
    case "email_address_not_authorized":
    case "unexpected_failure":
      return "We couldn't send your code right now. Please try again in a few minutes.";
    case "user_banned":
      return "This account has been deactivated. Please contact support.";
    case "session_not_found":
    case "refresh_token_not_found":
      return "Your session has expired. Please sign in again.";
    default:
      return "Something went wrong. Please try again.";
  }
}

function isNetworkError(e: { name?: string; status?: number } | null): boolean {
  if (!e) return false;
  if (e.name === "AuthRetryableFetchError") return true;
  return e.name === "TypeError" && e.status === undefined;
}
