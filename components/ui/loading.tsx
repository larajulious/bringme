import { cn } from "@/lib/utils";

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-6 animate-spin rounded-full border-[3px] border-primary/20 border-t-primary motion-reduce:animate-none",
        className,
      )}
    />
  );
}

/** Centered loading state for route-level `loading.tsx` files. */
export function Loading({
  label = "Loading…",
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex min-h-[50vh] flex-col items-center justify-center gap-4 p-6 text-center",
        className,
      )}
    >
      <div className="flex gap-2" aria-hidden="true">
        {["bg-primary", "bg-brand-yellow", "bg-brand-coral"].map((c, i) => (
          <span
            key={c}
            className={cn(
              "size-4 animate-bounce rounded-full motion-reduce:animate-none",
              c,
            )}
            style={{ animationDelay: `${i * 120}ms` }}
          />
        ))}
      </div>
      <p className="font-display text-lg font-semibold text-primary">{label}</p>
    </div>
  );
}
