import * as React from "react";

import { cn } from "@/lib/utils";

/** Styled native <select>: accessible, keyboard- and mobile-friendly. */
const Select = React.forwardRef<HTMLSelectElement, React.ComponentProps<"select">>(
  ({ className, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        "h-12 w-full rounded-2xl border-2 border-input bg-card px-3 text-base text-foreground transition-colors hover:border-primary/40 focus-visible:border-primary disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Select.displayName = "Select";

export { Select };
