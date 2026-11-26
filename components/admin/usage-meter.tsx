import { usageTone } from "@/lib/admin/utilization";
import { cn } from "@/lib/utils";

const TONE = {
  ok: { bar: "bg-brand-success", text: "text-brand-success", label: "Plenty of room" },
  watch: { bar: "bg-brand-yellow", text: "text-brand-night", label: "Keep an eye on it" },
  act: { bar: "bg-brand-coral", text: "text-brand-coral", label: "Act soon" },
  urgent: { bar: "bg-destructive", text: "text-destructive", label: "Act now" },
} as const;

/** One plan limit: how much is used, as a labelled meter (the colour is backed by text, never colour alone). */
export function UsageMeter({ label, used, limit, usedLabel, limitLabel, hint }: {
  label: string; used: number; limit: number; usedLabel: string; limitLabel: string; hint?: string;
}) {
  const ratio = limit > 0 ? used / limit : 0;
  const tone = TONE[usageTone(ratio)];
  const width = Math.min(100, Math.max(ratio > 0 ? 2 : 0, ratio * 100));
  return (
    <div className="rounded-2xl border bg-card p-4 shadow-card sm:rounded-3xl sm:p-5">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-semibold text-muted-foreground">{label}</p>
        <p className={cn("text-xs font-bold", tone.text)}>{tone.label}</p>
      </div>
      <p className="mt-1 font-display text-2xl font-bold tabular-nums text-foreground sm:text-3xl">
        {usedLabel} <span className="text-base font-semibold text-muted-foreground">/ {limitLabel}</span>
      </p>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={Math.min(used, limit)}
        aria-valuetext={`${usedLabel} of ${limitLabel} (${Math.round(ratio * 100)}%)`}
        className="mt-3 h-3 overflow-hidden rounded-full bg-secondary"
      >
        <div className={cn("h-full rounded-full", tone.bar)} style={{ width: `${width}%` }} />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {Math.round(ratio * 100)}% used{hint ? ` · ${hint}` : ""}
      </p>
    </div>
  );
}
