"use client";

import { ArrowLeft, KeyRound, Loader2, LogIn, Mail, MailCheck, UserPlus } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { FormError, FormNotice } from "@/components/auth/form-parts";
import { OtpCodeInput } from "@/components/auth/otp-code-input";
import { Mascot } from "@/components/brand/mascot";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DISPOSABLE_EMAIL_MESSAGE } from "@/lib/auth/disposable";
import { friendlyAuthError } from "@/lib/auth/messages";
import {
  OTP_LENGTH, PENDING_KEY, RESEND_COOLDOWN_MS, cooldownSecondsLeft, isValidEmail, normalizeEmail, parsePending, retryAfterMs,
  type PendingVerification,
} from "@/lib/auth/otp";
import { safeNext } from "@/lib/auth/redirect";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

type Area = "subscriber" | "admin";
type Mode = "signin" | "signup";

/** "a 6-digit" / "an 8-digit" (also 11 and 18, which Supabase never uses). */
const CODE_LABEL = `${OTP_LENGTH === 8 ? "an" : "a"} ${OTP_LENGTH}-digit`;

// sessionStorage can throw (private mode, blocked storage): the flow still works, it just won't survive a refresh.
const store = {
  read(): PendingVerification | null {
    try { return parsePending(window.sessionStorage.getItem(PENDING_KEY), Date.now()); } catch { return null; }
  },
  write(p: PendingVerification) {
    try { window.sessionStorage.setItem(PENDING_KEY, JSON.stringify(p)); } catch { /* ignore */ }
  },
  clear() {
    try { window.sessionStorage.removeItem(PENDING_KEY); } catch { /* ignore */ }
  },
};

/**
 * Passwordless sign-in / sign-up (Supabase Email OTP). The visitor picks the path explicitly,
 * because Supabase's response is identical for new and known emails (no enumeration):
 *   Sign in        -> shouldCreateUser=false -> code screen (unknown emails see it too, no code arrives)
 *   Create account -> shouldCreateUser=true  -> "Check your email!" link screen (a known email gets a code
 *                     instead, reachable from that screen without revealing whether the account exists)
 * The client only establishes the session; /auth/continue decides the destination from profiles.role.
 * `area="admin"` never creates accounts and always uses the code screen.
 */
export function EmailOtpForm({ area = "subscriber" }: { area?: Area }) {
  const isAdmin = area === "admin";
  const params = useSearchParams();
  const rawNext = params.get("next");
  const next = rawNext ? safeNext(rawNext, "") || null : null;

  const [mode, setMode] = useState<Mode>(() => (!isAdmin && params.get("mode") === "signup" ? "signup" : "signin"));
  const [step, setStep] = useState<"email" | "verify" | "link">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [availableAt, setAvailableAt] = useState(0);

  const busy = useRef(false); // synchronous guard against double submits / double taps
  const lastTried = useRef<string | null>(null); // auto-submit each distinct full-length code once
  const leaving = useRef(false);
  const lastSent = useRef<PendingVerification | null>(null); // survives "Change email", so switching back doesn't re-send
  const emailRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  const continueUrl = useCallback(() => {
    const qs = new URLSearchParams();
    if (isAdmin) qs.set("area", "admin");
    else if (next) qs.set("next", next);
    return `/auth/continue?${qs}`;
  }, [isAdmin, next]);

  const goContinue = useCallback(() => {
    if (leaving.current) return;
    leaving.current = true;
    store.clear();
    // Full navigation so the fresh session cookie reaches the server route.
    window.location.assign(continueUrl());
  }, [continueUrl]);

  // Refresh during verification: restore the code or link step (email + cooldown only). Never sends an email.
  useEffect(() => {
    const pending = store.read();
    if (!pending) return;
    lastSent.current = pending;
    setEmail(pending.email);
    setAvailableAt(pending.sentAt + RESEND_COOLDOWN_MS);
    if (pending.kind === "link" && !isAdmin) {
      setMode("signup");
      setStep("link");
    } else {
      setStep("verify");
    }
  }, [isAdmin]);

  // Focus the field for the current step (also after "Change email" / restore). The link step has no field.
  useEffect(() => {
    if (step === "email") emailRef.current?.focus();
    else if (step === "verify") codeRef.current?.focus();
  }, [step]);

  // After a rejected code the field is re-enabled: refocus and select the digits so a fix or a new code can overwrite them.
  useEffect(() => {
    if (step === "verify" && error && !verifying) codeRef.current?.select();
  }, [step, error, verifying]);

  // Verified (code) or confirmed (link) in another tab: this tab shares the session cookie, so just move on.
  useEffect(() => {
    if (step === "email") return;
    const { data } = createClient().auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_IN" && session) goContinue();
    });
    return () => data.subscription.unsubscribe();
  }, [step, goContinue]);

  /** One Supabase request per call. "Create account" may create the user; "Sign in" and admin never do. */
  const requestCode = async (target: string): Promise<boolean> => {
    const createUser = !isAdmin && mode === "signup";
    // New accounts only: temporary inboxes are refused before anything is sent (the Supabase Auth hook
    // enforces the same rule for every signup, so this is just the early, friendly answer).
    if (createUser && (await isTemporaryEmail(target))) {
      setError(DISPOSABLE_EMAIL_MESSAGE);
      return false;
    }
    const { error } = await createClient().auth.signInWithOtp({
      email: target,
      // The confirmation link must come back to THIS site's confirm route (not Supabase's Site URL,
      // which may still be localhost): a used/expired link then lands on a friendly error page.
      options: { shouldCreateUser: createUser, emailRedirectTo: `${window.location.origin}/auth/confirm` },
    });
    // Sign-in only: an unknown email must look exactly like a known one (no enumeration, no account created).
    if (error && !(!createUser && (error.code === "otp_disabled" || error.code === "signup_disabled"))) {
      const wait = retryAfterMs(error);
      if (wait) setAvailableAt(Date.now() + wait);
      setError(friendlyAuthError(error));
      return false;
    }
    const sentAt = Date.now();
    lastSent.current = createUser ? { email: target, sentAt, kind: "link" } : { email: target, sentAt };
    store.write(lastSent.current);
    setAvailableAt(sentAt + RESEND_COOLDOWN_MS);
    return true;
  };

  const submitEmail = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy.current) return;
    const target = normalizeEmail(email);
    setError(null);
    setNotice(null);
    if (!target) return setError("Please enter your email address.");
    if (!isValidEmail(target)) return setError("That doesn't look like an email address. Please check it.");
    const kind: "link" | undefined = !isAdmin && mode === "signup" ? "link" : undefined;
    const prev = lastSent.current;
    if (prev && prev.email === target && prev.kind === kind && Date.now() < prev.sentAt + RESEND_COOLDOWN_MS) {
      // Same email and path again within the cooldown: reuse the email already on its way.
      store.write(prev);
      setEmail(target);
      setAvailableAt(prev.sentAt + RESEND_COOLDOWN_MS);
      setStep(kind === "link" ? "link" : "verify");
      return;
    }
    busy.current = true;
    setSending(true);
    try {
      if (await requestCode(target)) {
        setEmail(target);
        setCode("");
        lastTried.current = null;
        setStep(kind === "link" ? "link" : "verify");
      }
    } finally {
      busy.current = false;
      setSending(false);
    }
  };

  const verify = async (candidate: string) => {
    if (busy.current || leaving.current || candidate.length !== OTP_LENGTH) return;
    busy.current = true;
    lastTried.current = candidate;
    setVerifying(true);
    setError(null);
    setNotice(null);
    try {
      const { data, error } = await createClient().auth.verifyOtp({ email, token: candidate, type: "email" });
      if (error || !data.session) {
        // Digits are kept (see the refocus effect) so a typo can be fixed.
        setError(friendlyAuthError(error ?? { code: "otp_expired" }));
        return;
      }
      goContinue();
    } finally {
      busy.current = false;
      if (!leaving.current) setVerifying(false);
    }
  };

  const onCodeChange = (value: string) => {
    setCode(value);
    if (error) setError(null);
    if (value.length === OTP_LENGTH && value !== lastTried.current) void verify(value);
  };

  const resend = async () => {
    if (busy.current || Date.now() < availableAt) return;
    busy.current = true;
    setSending(true);
    setError(null);
    setNotice(null);
    try {
      if (await requestCode(email)) {
        // The new code/link replaces the old one in Supabase; clear what was typed.
        setCode("");
        lastTried.current = null;
        if (step === "link") {
          setNotice("A new confirmation email is on its way. Only the newest link will work.");
        } else {
          setNotice("A new code is on its way. Only the newest code will work.");
          codeRef.current?.focus();
        }
      }
    } finally {
      busy.current = false;
      setSending(false);
    }
  };

  const changeEmail = () => {
    if (verifying) return;
    store.clear();
    setCode("");
    setError(null);
    setNotice(null);
    lastTried.current = null;
    setStep("email");
  };

  // Link screen -> code screen for the same email, without sending anything (a known email got a code).
  const enterCodeInstead = () => {
    if (lastSent.current) store.write({ email: lastSent.current.email, sentAt: lastSent.current.sentAt });
    setError(null);
    setNotice(null);
    setStep("verify");
  };

  // Code screen (sign-in) -> create-account form, keeping the typed email.
  const switchToSignup = () => {
    if (verifying) return;
    changeEmail();
    setMode("signup");
  };

  const pickMode = (m: Mode) => {
    if (sending) return;
    setMode(m);
    setError(null);
  };

  if (step === "link") {
    return (
      <Card>
        <CardContent className="flex flex-col gap-6 p-6 sm:p-8">
          <div className="flex flex-col items-center gap-3 text-center">
            <span className="grid size-16 place-items-center rounded-full bg-secondary text-primary" aria-hidden="true">
              <MailCheck className="!size-8" />
            </span>
            <h1 className="font-display text-2xl font-bold text-primary sm:text-3xl">Check your email!</h1>
            <p className="text-muted-foreground">
              We&apos;ve sent a confirmation link to
              <strong className="mt-1 block break-words font-bold text-foreground">{email}</strong>
            </p>
            <p className="text-muted-foreground">
              Open your inbox and click the link to verify your account and start using Bring Me.
            </p>
          </div>
          <p className="rounded-2xl bg-secondary/60 p-4 text-sm text-secondary-foreground">
            Open the link on this device, in this browser. Can&apos;t find the email? Check your spam or promotions folder.
          </p>
          <FormError>{error}</FormError>
          <FormNotice>{notice}</FormNotice>
          <div className="flex flex-col items-center gap-1 text-sm">
            <ResendButton availableAt={availableAt} sending={sending} disabled={false} onResend={resend}
              label="Resend confirmation email" waitLabel="Resend email in" />
            <Button type="button" variant="link" size="sm" onClick={changeEmail} className="text-muted-foreground">
              <ArrowLeft className="!size-4" aria-hidden="true" /> Use a different email
            </Button>
          </div>
          <p className="border-t border-border pt-4 text-center text-sm text-muted-foreground">
            Already have an account? Then we&apos;ve emailed you a sign-in code instead.{" "}
            <Button type="button" variant="link" size="sm" onClick={enterCodeInstead} className="h-auto p-0 align-baseline">
              <KeyRound className="!size-4" aria-hidden="true" /> Enter code
            </Button>
          </p>
        </CardContent>
      </Card>
    );
  }

  if (step === "verify") {
    return (
      <Card>
        <CardContent className="flex flex-col gap-6 p-6 sm:p-8">
          <Header
            mood="waiting"
            title="Check your email"
            description={<>We sent {CODE_LABEL} verification code to <strong className="break-words font-bold text-foreground">{email}</strong>.</>}
          />
          <form onSubmit={(e) => { e.preventDefault(); void verify(code); }} className="flex flex-col gap-5" noValidate>
            <div className="grid gap-2">
              <Label htmlFor="otp-code">Verification code</Label>
              <OtpCodeInput
                ref={codeRef}
                id="otp-code"
                value={code}
                onChange={onCodeChange}
                disabled={verifying}
                invalid={!!error}
                describedBy={error ? "otp-error" : "otp-hint"}
              />
              <p id="otp-hint" className="text-xs text-muted-foreground">
                Can&apos;t find it? Check your spam or promotions folder.
                {!isAdmin ? " If the email has a confirmation link instead, click that link to finish." : null}
              </p>
            </div>
            <FormError id="otp-error">{error}</FormError>
            <FormNotice>{notice}</FormNotice>
            <Button type="submit" size="lg" className="w-full" disabled={verifying || code.length !== OTP_LENGTH}>
              {verifying ? <><Loader2 className="motion-safe:animate-spin" aria-hidden="true" /> Verifying…</> : "Verify & Continue"}
            </Button>
          </form>
          <div className="flex flex-col items-center gap-1 text-sm">
            <ResendButton availableAt={availableAt} sending={sending} disabled={verifying} onResend={resend} />
            <Button type="button" variant="link" size="sm" onClick={changeEmail} disabled={verifying} className="text-muted-foreground">
              <ArrowLeft className="!size-4" aria-hidden="true" /> Change email
            </Button>
            {!isAdmin && mode === "signin" ? (
              <p className="mt-2 text-center text-muted-foreground">
                New to Bring Me?{" "}
                <Button type="button" variant="link" size="sm" onClick={switchToSignup} disabled={verifying} className="h-auto p-0 align-baseline">
                  Create an account
                </Button>
              </p>
            ) : null}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-6 p-6 sm:p-8">
        <Header
          mood="happy"
          title={isAdmin ? "Super Admin sign in" : mode === "signup" ? "Create your account" : "Welcome back"}
          description={
            isAdmin ? `Restricted area. We'll email you ${CODE_LABEL} code.`
              : mode === "signup" ? "Enter your email and we'll send you a confirmation link. No password needed."
                : `Enter your email and we'll send you ${CODE_LABEL} sign-in code. No password needed.`
          }
        />
        {!isAdmin ? (
          <div role="radiogroup" aria-label="Sign in or create an account" className="grid grid-cols-2 gap-1 rounded-2xl bg-secondary p-1">
            {([["signin", "Sign in", LogIn], ["signup", "Create account", UserPlus]] as const).map(([m, label, Icon]) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                onClick={() => pickMode(m)}
                disabled={sending}
                className={cn(
                  "flex items-center justify-center gap-2 rounded-xl px-3 py-2 font-display text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring disabled:opacity-60 sm:text-base",
                  mode === m ? "bg-primary text-primary-foreground shadow-pop-purple" : "text-primary hover:bg-primary/10",
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden="true" /> {label}
              </button>
            ))}
          </div>
        ) : null}
        <form onSubmit={submitEmail} className="flex flex-col gap-5" noValidate>
          <div className="grid gap-2">
            <Label htmlFor="email">Email address</Label>
            <Input
              ref={emailRef}
              id="email"
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="you@example.com"
              maxLength={254}
              required
              value={email}
              disabled={sending}
              onChange={(e) => { setEmail(e.target.value); if (error) setError(null); }}
              aria-invalid={!!error || undefined}
              aria-describedby={error ? "email-error" : undefined}
            />
          </div>
          <FormError id="email-error">{error}</FormError>
          <Button type="submit" size="lg" className="w-full" disabled={sending}>
            {sending ? (
              <><Loader2 className="motion-safe:animate-spin" aria-hidden="true" /> {!isAdmin && mode === "signup" ? "Sending link…" : "Sending code…"}</>
            ) : !isAdmin && mode === "signup" ? (
              <><UserPlus aria-hidden="true" /> Create account</>
            ) : (
              <><Mail aria-hidden="true" /> Email me a code</>
            )}
          </Button>
          {!isAdmin ? (
            <p className="text-center text-sm text-muted-foreground">
              {mode === "signup"
                ? "Your free trial starts as soon as you confirm your email."
                : "Use the same email to get back to your games and passes."}
            </p>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * Server pre-check for "Create account". Only a definite "not allowed" blocks; if the check can't be
 * reached the signup continues and the Supabase Auth hook makes the decision.
 */
async function isTemporaryEmail(email: string): Promise<boolean> {
  try {
    const res = await fetch("/api/auth/email-check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { allowed?: unknown };
    return body.allowed === false;
  } catch {
    return false;
  }
}

function Header({ title, description, mood }: { title: string; description: React.ReactNode; mood: "happy" | "waiting" }) {
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <Mascot mood={mood} className="h-14 w-16" />
      <h1 className="font-display text-2xl font-bold text-primary sm:text-3xl">{title}</h1>
      <p className="text-muted-foreground">{description}</p>
    </div>
  );
}

/** Owns its own 1 s tick so the countdown never re-renders (or resets) the code field. */
function ResendButton({ availableAt, sending, disabled, onResend, label = "Resend Code", waitLabel = "Resend code in" }: {
  availableAt: number; sending: boolean; disabled: boolean; onResend: () => void; label?: string; waitLabel?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  const left = cooldownSecondsLeft(availableAt, now);

  useEffect(() => {
    setNow(Date.now());
    if (availableAt <= Date.now()) return;
    const t = window.setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (n >= availableAt) window.clearInterval(t);
    }, 1000);
    return () => window.clearInterval(t);
  }, [availableAt]);

  if (left > 0) {
    return (
      <p className="flex h-9 items-center font-semibold text-muted-foreground">
        {waitLabel} <span className="ml-1 tabular-nums">{left}s</span>
      </p>
    );
  }
  return (
    <Button type="button" variant="link" size="sm" onClick={onResend} disabled={sending || disabled}>
      {sending ? "Sending…" : label}
    </Button>
  );
}
