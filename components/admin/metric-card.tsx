import Link from "next/link";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** One headline number. Pass `href` to make the whole card a drill-down link. */
export function MetricCard({
  label,
  value,
  hint,
  href,
  accent = "primary",
  icon,
}: {
  label: string;
  value: number;
  hint?: string;
  href?: string;
  accent?: "primary" | "success" | "yellow" | "coral";
  icon?: ReactNode;
}) {
  const bar = { primary: "bg-primary", success: "bg-brand-success", yellow: "bg-brand-yellow", coral: "bg-brand-coral" }[accent];
  const body = (
    <div className="relative h-full overflow-hidden rounded-2xl border bg-card p-3 pl-4 shadow-card transition-transform motion-safe:group-hover:-translate-y-0.5 sm:rounded-3xl sm:p-5">
      <span aria-hidden="true" className={cn("absolute inset-y-0 left-0 w-1 sm:w-1.5", bar)} />
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-semibold leading-tight text-muted-foreground sm:text-sm">{label}</p>
        {icon ? <span aria-hidden="true" className="hidden text-primary sm:inline [&_svg]:size-5">{icon}</span> : null}
      </div>
      <p className="mt-1 font-display text-2xl font-bold text-foreground tabular-nums sm:mt-2 sm:text-4xl">{value.toLocaleString("en-US")}</p>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
  return href ? (
    <Link href={href} className="group block rounded-3xl">
      {body}
    </Link>
  ) : (
    body
  );
}
