"use client";

import { Loader2, MailCheck } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";

/**
 * Submit button for the native confirm form (works without JS). With JS it blocks a second submit:
 * the token is single-use, so a double tap would otherwise end on "link already used".
 */
export function ConfirmEmailButton() {
  const [submitted, setSubmitted] = useState(false);
  return (
    <Button
      type="submit"
      size="lg"
      className="w-full"
      aria-disabled={submitted}
      onClick={(e) => {
        if (submitted) e.preventDefault();
        else setSubmitted(true);
      }}
    >
      {submitted ? <Loader2 className="motion-safe:animate-spin" aria-hidden="true" /> : <MailCheck aria-hidden="true" />}
      {submitted ? "Confirming…" : "Confirm my email"}
    </Button>
  );
}
