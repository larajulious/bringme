"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

const MESSAGES: Record<string, string> = {
  email_unconfirmed: "Please confirm your email address first.",
  has_paid_history: "This account already had a Game Pass, so the free trial isn't available.",
  has_pass_history: "This account already had access, so the free trial isn't available.",
  suspended: "Your account is paused. Please contact the BringMe! team.",
  trial_unavailable: "The free trial is not available right now. Please try again later.",
};

/** Only shown to eligible hosts who somehow don't have their trial yet (e.g. accounts confirmed before trials existed). */
export function StartTrialButton() {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/host/trial", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast(MESSAGES[data.error ?? ""] ?? "Couldn't start the trial. Please try again.", "error");
        return;
      }
      toast("Your 7-day free trial has started. Have fun!", "success");
      router.refresh();
    } catch {
      toast("You seem to be offline. Please try again.", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button onClick={start} disabled={busy} size="lg">
      <Sparkles aria-hidden="true" /> {busy ? "Starting…" : "Start my free trial"}
    </Button>
  );
}
