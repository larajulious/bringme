"use client";

import { ArrowLeft, Loader2, LogIn, Mail, UserPlus } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { FormError, FormNotice } from "@/components/auth/form-parts";
import { OtpCodeInput } from "@/components/auth/otp-code-input";
import { Mascot } from "@/components/brand/mascot";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { friendlyAuthError } from "@/lib/auth/messages";
import {
  OTP_LENGTH, PENDING_KEY, RESEND_COOLDOWN_MS, cooldownSecondsLeft, isValidEmail, normalizeEmail, parsePending, retryAfterMs,
  type PendingVerification,
} from "@/lib/auth/otp";
import { safeNext } from "@/lib/auth/redirect";
import { createClient } from "@/lib/supabase/client";

type Area = "subscriber" | "admin";

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
 * Unified passwordless sign-in / sign-up (Supabase Email OTP). New and returning
 * hosts use the same two steps; the client only establishes the session and
 * /auth/continue decides the destination on the server from profiles.role.
 * `area="admin"` never creates accounts (unknown emails get the same screen, no code).
 */
export function EmailOtpForm({ area = "subscriber" }: { area?: Area }) {
  const isAdmin = area === "admin";
  const rawNext = useSearchParams().get("next");
  const next = rawNext ? safeNext(rawNext, "") || null : null;

  const [step, setStep] = useState<"email" | "verify">("email");
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

  // Refresh during verification: restore the code step (email + cooldown only). Never sends a code.
  useEffect(() => {
    const pending = store.read();
    if (!pending) return;
    lastSent.current = pending;
    setEmail(pending.email);
    setAvailableAt(pending.sentAt + RESEND_COOLDOWN_MS);
    setStep("verify");
  }, []);

  // Focus the field for the current step (also after "Change email" / restore).
  useEffect(() => {
    (step === "email" ? emailRef : codeRef).current?.focus();
  }, [step]);

  // After a rejected code the field is re-enabled: refocus and select the digits so a fix or a new code can overwrite them.
  useEffect(() => {
    if (step === "verify" && error && !verifying) codeRef.current?.select();
  }, [step, error, verifying]);

  // Verified in another tab: this tab shares the session cookie, so just move on.
  useEffect(() => {
    if (step !== "verify") return;
    const { data } = createClient().auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_IN" && session) goContinue();
    });
    return () => data.subscription.unsubscribe();
  }, [step, goContinue]);

  const requestCode = async (target: string): Promise<boolean> => {
    const { error } = await createClient().auth.signInWithOtp({
      email: target,
      // If the email also contains a link, it must come back to THIS site's confirm route (not Supabase's
      // Site URL, which may still be localhost): a used/expired link then lands on a friendly error page.
      options: { shouldCreateUser: !isAdmin, emailRedirectTo: `${window.location.origin}/auth/confirm` },
    });
    // Admin area: an unknown email must look exactly like a known one (no enumeration, no account created).
    if (error && !(isAdmin && (error.code === "otp_disabled" || error.code === "signup_disabled"))) {
      const wait = retryAfterMs(error);
      if (wait) setAvailableAt(Date.now() + wait);
      setError(friendlyAuthError(error));
      return false;
    }
    const sentAt = Date.now();
    lastSent.current = { email: target, sentAt };
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
    const prev = lastSent.current;
    if (prev && prev.email === target && Date.now() < prev.sentAt + RESEND_COOLDOWN_MS) {
      // Same email again within the cooldown: reuse the code already on its way.
      store.write(prev);
      setEmail(target);
      setAvailableAt(prev.sentAt + RESEND_COOLDOWN_MS);
      setStep("verify");
      return;
    }
    busy.current = true;
    setSending(true);
    try {
      if (await requestCode(target)) {
        setEmail(target);
        setCode("");
        lastTried.current = null;
        setStep("verify");
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
        // The new code replaces the old one in Supabase; clear what was typed.
        setCode("");
        lastTried.current = null;
        setNotice("A new code is on its way. Only the newest code will work.");
        codeRef.current?.focus();
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
              <p id="otp-hint" className="text-xs text-muted-foreground">Can&apos;t find it? Check your spam or promotions folder.</p>
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
          title={isAdmin ? "Super Admin sign in" : "Welcome to Bring Me"}
          description={isAdmin ? `Restricted area. We'll email you ${CODE_LABEL} code.` : "Enter your email to get started. No password needed."}
        />
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
            {sending ? <><Loader2 className="motion-safe:animate-spin" aria-hidden="true" /> Sending code…</> : <><Mail aria-hidden="true" /> Continue with Email</>}
          </Button>
          {!isAdmin ? (
            // One form for everyone: say so plainly, so new hosts don't go hunting for a "Sign up" link.
            <ul aria-label="Signing in and signing up are the same step" className="grid gap-2 rounded-2xl bg-secondary/60 p-4 text-sm text-secondary-foreground">
              <li className="flex items-start gap-3">
                <UserPlus className="mt-0.5 !size-4 shrink-0 text-primary" aria-hidden="true" />
                <span><strong className="font-bold">New here?</strong> No sign-up form. We create your account when you enter the code, and your free trial starts.</span>
              </li>
              <li className="flex items-start gap-3">
                <LogIn className="mt-0.5 !size-4 shrink-0 text-primary" aria-hidden="true" />
                <span><strong className="font-bold">Been here before?</strong> Use the same email to sign back in to your games and passes.</span>
              </li>
            </ul>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
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
function ResendButton({ availableAt, sending, disabled, onResend }: { availableAt: number; sending: boolean; disabled: boolean; onResend: () => void }) {
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
        Resend code in <span className="ml-1 tabular-nums">{left}s</span>
      </p>
    );
  }
  return (
    <Button type="button" variant="link" size="sm" onClick={onResend} disabled={sending || disabled}>
      {sending ? "Sending…" : "Resend Code"}
    </Button>
  );
}
