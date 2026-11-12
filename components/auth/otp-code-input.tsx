"use client";

import { forwardRef, useState } from "react";

import { OTP_LENGTH, sanitizeCode } from "@/lib/auth/otp";
import { cn } from "@/lib/utils";

type Props = {
  id: string;
  value: string;
  onChange: (code: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
};

/**
 * One real <input> (numeric keyboard, `one-time-code` autofill, paste, native
 * deletion and screen-reader support) layered over six decorative boxes. The
 * text is transparent; the boxes mirror it. No per-digit inputs to juggle focus.
 */
export const OtpCodeInput = forwardRef<HTMLInputElement, Props>(function OtpCodeInput(
  { id, value, onChange, disabled, invalid, describedBy },
  ref,
) {
  const [focused, setFocused] = useState(false);
  const active = Math.min(value.length, OTP_LENGTH - 1);
  const wide = OTP_LENGTH > 6; // 7–10 boxes: tighter gaps and smaller digits so they fit a 320 px phone
  // Keep the caret at the end so typing/deleting always matches the highlighted box.
  const toEnd = (el: HTMLInputElement) => {
    const n = el.value.length;
    if (el.selectionStart !== n || el.selectionEnd !== n) el.setSelectionRange(n, n);
  };

  return (
    <div className="relative">
      <input
        ref={ref}
        id={id}
        name="code"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={OTP_LENGTH + 6 /* allow "1234 5678" pastes; sanitised below */}
        spellCheck={false}
        value={value}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onChange={(e) => onChange(sanitizeCode(e.target.value))}
        onFocus={(e) => { setFocused(true); toEnd(e.currentTarget); }}
        onBlur={() => setFocused(false)}
        onSelect={(e) => toEnd(e.currentTarget)}
        className="absolute inset-0 z-10 h-full w-full cursor-text rounded-2xl bg-transparent text-transparent caret-transparent outline-none selection:bg-transparent disabled:cursor-not-allowed"
      />
      <div
        aria-hidden="true"
        style={{ gridTemplateColumns: `repeat(${OTP_LENGTH}, minmax(0, 1fr))` }}
        className={cn("grid", wide ? "gap-1.5 sm:gap-2" : "gap-2 sm:gap-3", disabled && "opacity-60")}
      >
        {Array.from({ length: OTP_LENGTH }, (_, i) => {
          const digit = value[i];
          const isActive = focused && i === active && !disabled;
          return (
            <div
              key={i}
              className={cn(
                "relative flex items-center justify-center border-2 bg-card font-display font-bold text-primary transition-colors",
                wide ? "h-12 rounded-xl text-xl sm:h-14 sm:text-2xl" : "h-14 rounded-2xl text-2xl sm:h-16 sm:text-3xl",
                invalid ? "border-destructive" : isActive ? "border-primary ring-4 ring-ring/30" : digit ? "border-primary/40" : "border-input",
              )}
            >
              {digit ? (
                <span className="motion-safe:animate-in motion-safe:zoom-in-75 motion-safe:fade-in-0 motion-safe:duration-150">{digit}</span>
              ) : isActive && value.length < OTP_LENGTH ? (
                <span className="h-7 w-0.5 rounded-full bg-primary motion-safe:animate-pulse" />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
});
