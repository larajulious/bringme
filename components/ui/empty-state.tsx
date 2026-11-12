import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 rounded-3xl border-2 border-dashed border-primary/25 bg-card px-4 py-8 text-center sm:px-6 sm:py-12",
        className,
      )}
    >
      {icon ? (
        <div
          aria-hidden="true"
          className="grid size-16 place-items-center rounded-full bg-secondary text-primary [&_svg]:size-8"
        >
          {icon}
        </div>
      ) : null}
      <h2 className="text-xl font-bold text-foreground">{title}</h2>
      {description ? (
        <p className="max-w-sm text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
