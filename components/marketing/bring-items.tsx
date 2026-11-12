import {
  Calculator, Coffee, Cookie, Croissant, CupSoda, Glasses, Headphones, IdCard, Key, Paperclip, Pizza, Sparkles,
  StickyNote, TvMinimal, Umbrella, Wallet,
} from "lucide-react";

import { cn } from "@/lib/utils";

/** The running joke: a little red stapler (no stock icon exists, so it's drawn here). */
function Stapler({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 32" className={className} aria-hidden="true">
      <rect x="3" y="22" width="42" height="7" rx="3.5" fill="#2a0f5c" opacity=".85" />
      <path d="M6 20c0-4 3-7 7-7h24c4 0 7 2 7 5v2H6z" fill="#e11d48" />
      <path d="M8 14 40 9c2-.3 3.5 1 3.5 2.6V13H10z" fill="#be123c" />
      <circle cx="11" cy="19" r="2" fill="#fff" opacity=".9" />
    </svg>
  );
}

type Icon = React.ComponentType<{ className?: string }>;
export type BringItem = { key: string; label: string; icon: Icon; tone: string };

/** Things Game Masters love to ask for (also used by the hero prompts). */
export const ITEMS: Record<string, BringItem> = {
  stapler: { key: "stapler", label: "red stapler", icon: Stapler, tone: "bg-white" },
  mug: { key: "mug", label: "mug that says #1", icon: Coffee, tone: "bg-white text-primary" },
  id: { key: "id", label: "company ID", icon: IdCard, tone: "bg-brand-coral text-white" },
  note: { key: "note", label: "sticky note", icon: StickyNote, tone: "bg-brand-yellow text-brand-night" },
  pandesal: { key: "pandesal", label: "pandesal", icon: Croissant, tone: "bg-white text-amber-600" },
  calc: { key: "calc", label: "calculator", icon: Calculator, tone: "bg-primary text-white" },
  tumbler: { key: "tumbler", label: "tumbler", icon: CupSoda, tone: "bg-white text-brand-coral" },
  clip: { key: "clip", label: "paperclip", icon: Paperclip, tone: "bg-white text-primary" },
  remote: { key: "remote", label: "aircon remote", icon: TvMinimal, tone: "bg-white text-primary" },
  umbrella: { key: "umbrella", label: "umbrella", icon: Umbrella, tone: "bg-brand-yellow text-brand-night" },
  headphones: { key: "headphones", label: "headphones", icon: Headphones, tone: "bg-white text-brand-coral" },
  key: { key: "key", label: "keys", icon: Key, tone: "bg-white text-amber-600" },
  wallet: { key: "wallet", label: "wallet", icon: Wallet, tone: "bg-primary text-white" },
  pizza: { key: "pizza", label: "leftover pizza", icon: Pizza, tone: "bg-white text-brand-coral" },
  glasses: { key: "glasses", label: "sunglasses", icon: Glasses, tone: "bg-white text-primary" },
  cookie: { key: "cookie", label: "a cookie", icon: Cookie, tone: "bg-brand-yellow text-brand-night" },
};

/**
 * Full-width "Bring me…" ribbon between sections: a static, wrapping row (no scrolling motion).
 * Purely decorative.
 */
export function ItemTicker({ tone = "yellow", items }: { tone?: "yellow" | "purple"; reverse?: boolean; items: (keyof typeof ITEMS)[] }) {
  const seq = (
    <ul className="flex flex-wrap items-center justify-center gap-x-6 gap-y-3 px-4">
      {items.map((k) => {
        const it = ITEMS[k];
        return (
          <li key={k} className="flex items-center gap-6">
            <span className="flex items-center gap-2 whitespace-nowrap font-display text-lg font-bold sm:text-xl">
              <span className={cn("grid size-9 place-items-center rounded-xl ring-1 ring-black/5", it.tone)}><it.icon className="size-5" /></span>
              <span className={tone === "yellow" ? "text-primary/70" : "text-white/70"}>Bring me…</span> {it.label}
            </span>
            <Sparkles className={cn("size-5 shrink-0", tone === "yellow" ? "text-brand-coral" : "text-brand-yellow")} />
          </li>
        );
      })}
    </ul>
  );
  return (
    <div aria-hidden="true" className="relative z-10 -my-3 overflow-hidden py-3">
      <div className={cn("-mx-4 py-3 shadow-[0_12px_30px_-16px_hsl(263_60%_30%/0.5)]", tone === "yellow" ? "-rotate-1 bg-brand-yellow text-brand-night" : "rotate-1 bg-brand-night text-white")}>
        {seq}
      </div>
    </div>
  );
}
