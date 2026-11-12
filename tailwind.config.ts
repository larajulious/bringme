import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

export default {
  content: [
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      // Height breakpoints: screens fit the viewport exactly, so big decorative
      // pieces shrink on short screens (small phones, address bar showing, landscape).
      screens: {
        short: { raw: "(max-height: 740px)" },
        tiny: { raw: "(max-height: 580px)" },
      },
      colors: {
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        brand: {
          yellow: "hsl(var(--brand-yellow))",
          "yellow-deep": "hsl(var(--brand-yellow-deep))",
          coral: "hsl(var(--brand-coral))",
          "coral-deep": "hsl(var(--brand-coral-deep))",
          night: "hsl(var(--brand-purple-deep))",
          success: "hsl(var(--brand-success))",
        },
      },
      fontFamily: {
        sans: ["var(--font-body)", "ui-sans-serif", "system-ui", "sans-serif"],
        display: [
          "var(--font-display)",
          "ui-rounded",
          "system-ui",
          "sans-serif",
        ],
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 4px)",
        sm: "calc(var(--radius) - 8px)",
        "4xl": "2rem",
      },
      boxShadow: {
        card: "0 1px 2px hsl(263 60% 20% / 0.06), 0 8px 24px -8px hsl(263 60% 30% / 0.18)",
        pop: "0 4px 0 0 hsl(var(--brand-yellow-deep))",
        "pop-purple": "0 4px 0 0 hsl(var(--brand-purple-deep))",
        "pop-coral": "0 4px 0 0 hsl(var(--brand-coral-deep))",
      },
      animation: {
        "page-in": "page-in 0.35s cubic-bezier(0.22,1,0.36,1) both",
        "pop-in": "pop-in 0.25s cubic-bezier(0.22,1,0.36,1) both",
        float: "float 6s ease-in-out infinite",
        "confetti-fall": "confetti-fall var(--dur, 4s) linear var(--delay, 0s) infinite",
        "trophy-shine": "trophy-shine 2.4s ease-in-out infinite",
        bob: "bob 4.5s ease-in-out infinite",
        wiggle: "wiggle 0.5s ease-in-out",
        blink: "blink 5.5s cubic-bezier(0.4, 0, 0.2, 1) infinite",
        look: "look 6s ease-in-out infinite",
        twinkle: "twinkle 3.2s ease-in-out infinite",
        "tick-pop": "tick-pop 1s cubic-bezier(0.22,1,0.36,1) both",
        "tick-ring": "tick-ring 1s ease-out both",
        "go-flash": "go-flash 0.7s ease-out both",
        draw: "draw 0.55s 0.15s cubic-bezier(0.65,0,0.35,1) forwards",
        "rays-spin": "rays-spin 40s linear infinite",
        "ping-soft": "ping-soft 1.8s ease-out infinite",
        "join-in": "join-in 0.55s cubic-bezier(0.22,1,0.36,1) both",
        "pulse-soft": "pulse-soft 2.2s ease-in-out infinite",
        rise: "rise 0.6s cubic-bezier(0.22,1,0.36,1) both",
        "drop-in": "drop-in 0.9s cubic-bezier(0.22,1,0.36,1) both",
        "plus-float": "plus-float 1.6s ease-out both",
        "shutter-flash": "shutter-flash 0.28s ease-out both",
        "count-pop": "count-pop 1s ease-in-out both",
        "bounce-in": "bounce-in 0.7s cubic-bezier(0.22,1,0.36,1) both",
        "toast-in": "toast-in 0.25s cubic-bezier(0.22,1,0.36,1) both",
        "chip-loop": "chip-loop 4.5s ease-in-out infinite both",
        scan: "scan 2.2s ease-in-out infinite",
        "flash-loop": "flash-loop 2.6s ease-out infinite",
        drain: "drain 6s linear infinite",
        "winner-loop": "winner-loop 6s ease-out infinite",
        hop: "hop 0.7s cubic-bezier(0.34,1.56,0.64,1)",
        marquee: "marquee 45s linear infinite",
      },
    },
  },
  plugins: [animate],
} satisfies Config;
