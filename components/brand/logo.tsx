import Link from "next/link";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const logoVariants = cva(
  "inline-flex items-baseline font-display font-bold leading-none tracking-tight",
  {
    variants: {
      size: {
        sm: "text-2xl",
        md: "text-3xl",
        lg: "text-5xl sm:text-6xl",
        xl: "text-6xl sm:text-8xl",
      },
      tone: {
        // On light surfaces
        default: "text-primary",
        // On deep purple surfaces
        light: "text-brand-yellow [text-shadow:0_3px_0_hsl(var(--brand-yellow-deep))]",
      },
    },
    defaultVariants: { size: "md", tone: "default" },
  },
);

type LogoProps = VariantProps<typeof logoVariants> & {
  href?: string;
  className?: string;
};

/** Text/CSS wordmark. Pass `href` to render it as a home link. */
export function Logo({ size, tone, href, className }: LogoProps) {
  const mark = (
    <span
      className={cn(logoVariants({ size, tone }), className)}
      role={href ? undefined : "img"}
      aria-label="BringMe!"
    >
      <span aria-hidden="true">Bring</span>
      <span
        aria-hidden="true"
        className={cn(
          "ml-[0.04em]",
          tone === "light" ? "text-white" : "text-brand-coral",
        )}
      >
        Me
      </span>
      <span
        aria-hidden="true"
        className="ml-[0.02em] inline-block rotate-12 text-brand-coral"
      >
        !
      </span>
    </span>
  );

  if (!href) return mark;
  return (
    <Link
      href={href}
      aria-label="BringMe! home"
      className="rounded-lg"
    >
      {mark}
    </Link>
  );
}
