"use client";

import { Check, Copy } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

/** Read-only field + copy button. Falls back to selecting the text if the clipboard API is blocked. */
export function CopyField({ value, label }: { value: string; label: string }) {
  const { toast } = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast("Link copied", "success");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      input.current?.select();
      toast("Press Ctrl/Cmd + C to copy", "info");
    }
  };

  return (
    <div className="flex gap-2">
      <input
        ref={input}
        readOnly
        value={value}
        aria-label={label}
        onFocus={(e) => e.currentTarget.select()}
        className="h-12 min-w-0 flex-1 rounded-2xl border-2 border-input bg-card px-4 font-mono text-sm text-foreground"
      />
      <Button type="button" variant="secondary" onClick={copy}>
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
