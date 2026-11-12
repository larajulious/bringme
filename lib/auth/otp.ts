/**
 * Pure helpers for the passwordless (Supabase Email OTP) flow. Supabase owns
 * code generation, validation and expiry; nothing here stores or checks codes.
 */

/** Must equal Supabase → Auth → Providers → Email → "Email OTP Length" (Supabase allows 6–10). */
export function parseOtpLength(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 6 && n <= 10 ? n : 6;
}
export const OTP_LENGTH = parseOtpLength(process.env.NEXT_PUBLIC_AUTH_OTP_LENGTH);
/** Minimum wait between code requests (UI only; Supabase enforces its own limit too). */
export const RESEND_COOLDOWN_MS = 60_000;
/** How long a refreshed tab may restore the "Check your email" step. UI recovery only, not an OTP expiry. */
export const PENDING_TTL_MS = 60 * 60_000;
export const PENDING_KEY = "bringme:otp-pending";

/** Trim + lowercase (Supabase stores emails lowercased), so "A@B.com " and "a@b.com" are one account. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  if (email.length < 3 || email.length > 254) return false;
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email) && !/\.\./.test(email);
}

/** Keeps digits only (handles pasted "123 456", "123-456", autofill with spaces), capped at the code length. */
export function sanitizeCode(raw: string, length = OTP_LENGTH): string {
  return raw.replace(/\D/g, "").slice(0, length);
}

/** Whole seconds left before another code may be requested (0 = allowed now). */
export function cooldownSecondsLeft(availableAt: number, now: number): number {
  return Math.max(0, Math.ceil((availableAt - now) / 1000));
}

/** Supabase's per-email limit says e.g. "...only request this after 42 seconds." */
export function retryAfterMs(error: unknown): number | null {
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message !== "string") return null;
  const m = /after (\d{1,4}) seconds?/i.exec(message);
  return m ? Number(m[1]) * 1000 : null;
}

/** Minimal state kept in sessionStorage across a refresh: never the code, never a token. */
export type PendingVerification = { email: string; sentAt: number };

export function parsePending(raw: string | null, now: number): PendingVerification | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<PendingVerification>;
    if (typeof v.email !== "string" || typeof v.sentAt !== "number") return null;
    if (!isValidEmail(v.email) || v.sentAt > now + 5_000 || now - v.sentAt > PENDING_TTL_MS) return null;
    return { email: v.email, sentAt: v.sentAt };
  } catch {
    return null;
  }
}
