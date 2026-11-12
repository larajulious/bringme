import { FormError, FormNotice } from "./form-parts";

type Params = Promise<{ reason?: string; error?: string }>;

const messages: Record<string, string> = {
  forbidden: "That account is not a Super Admin.",
  link_invalid: "That link is invalid or has expired. Please request a new one.",
  deactivated: "This account has been deactivated. Please contact support.",
  profile_missing: "We couldn't load your account. Please sign in again or contact support.",
  profile_lookup_failed: "We couldn't reach your account details right now. Please try again in a moment.",
};

/** Reads ?reason / ?error set by the proxy and auth routes (needs <Suspense>). */
export async function AuthNotice({ searchParams }: { searchParams: Params }) {
  const { reason, error } = await searchParams;
  return (
    <div className="mb-4 space-y-3 empty:hidden">
      {reason === "expired" ? <FormNotice>Your session has ended. Please sign in again.</FormNotice> : null}
      {error ? <FormError>{messages[error] ?? "Something went wrong. Please try again."}</FormError> : null}
    </div>
  );
}
