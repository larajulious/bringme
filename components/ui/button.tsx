import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-2xl font-display font-semibold transition-all duration-150 motion-safe:active:translate-y-[3px] motion-safe:active:shadow-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-5 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // Primary action: bright yellow
        default:
          "bg-brand-yellow text-brand-night shadow-pop hover:brightness-105 motion-safe:hover:-translate-y-0.5",
        // Deep purple
        secondary:
          "bg-primary text-primary-foreground shadow-pop-purple hover:bg-primary/90 motion-safe:hover:-translate-y-0.5",
        // Confirming / approving (e.g. Verify a claim)
        success:
          "bg-brand-success text-white shadow-[0_4px_0_0_hsl(152_60%_18%)] hover:brightness-110 motion-safe:hover:-translate-y-0.5",
        // Camera / capture actions
        camera:
          "bg-brand-coral text-white shadow-pop-coral hover:brightness-105 motion-safe:hover:-translate-y-0.5",
        outline:
          "border-2 border-primary/25 bg-card text-primary hover:border-primary/50 hover:bg-accent",
        // For use on dark purple surfaces
        "outline-light":
          "border-2 border-white/40 bg-white/10 text-white hover:bg-white/20",
        ghost: "text-primary hover:bg-accent",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        link: "rounded-md text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-11 px-5 text-base",
        sm: "h-9 rounded-xl px-4 text-sm",
        lg: "h-14 px-8 text-lg",
        icon: "size-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
