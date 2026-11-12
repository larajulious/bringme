import Link from "next/link";
import { Check, Grid3x3, ShieldCheck, Sparkles } from "lucide-react";

import { BingoMark } from "@/components/bingosnap/bingo-mark";
import { Reveal } from "@/components/marketing/reveal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const points = [
  { icon: Grid3x3, text: "Build a 3×3, 4×4 or 5×5 card of things to find" },
  { icon: Sparkles, text: "Play Traditional Bingo (any line) or the Full Card Challenge" },
  { icon: ShieldCheck, text: "Photos stay on players' phones: you check every Bingo in person" },
];

/**
 * Homepage "Extra Fun" section: introduces BingoSnap, the photo Bingo game included with the
 * same Game Pass. Static (server component); motion comes from the shared Reveal (none with
 * reduced motion or without JS).
 */
export function ExtraFun() {
  return (
    <Reveal as="section" id="extra-fun" aria-labelledby="extra-fun-heading" className="relative isolate mx-auto flex w-full max-w-6xl scroll-mt-6 flex-col justify-center px-5 py-[clamp(3rem,8svh,6rem)]">
      <h2 id="extra-fun-heading" className="reveal-item mb-3 text-center text-3xl font-bold text-primary sm:text-4xl lg:text-5xl">Extra Fun</h2>
      <p className="reveal-item mx-auto mb-[clamp(1.5rem,5svh,3.5rem)] max-w-xl text-center text-muted-foreground [--i:1] lg:text-lg">
        More ways to play with the same Game Pass. No extra purchase needed.
      </p>

      <article className="reveal-item grid overflow-hidden rounded-4xl bg-card shadow-card ring-1 ring-primary/10 [--i:2] md:grid-cols-[0.9fr_1.1fr]">
        <div className="relative isolate grid min-h-64 place-items-center overflow-hidden bg-brand-yellow p-8">
          <span aria-hidden="true" className="absolute inset-0 -z-10 opacity-25 [background-image:radial-gradient(hsl(var(--brand-yellow-deep))_1.5px,transparent_1.5px)] [background-size:18px_18px]" />
          <BingoMark className="w-40 sm:w-48" />
        </div>
        <div className="flex flex-col gap-4 p-6 sm:p-8">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="coral">New</Badge>
            <span className="text-xs font-bold uppercase tracking-wide text-brand-coral">Photo Bingo</span>
          </div>
          <h3 className="font-display text-3xl font-bold text-foreground sm:text-4xl">BingoSnap</h3>
          <p className="text-lg text-muted-foreground">Turn everyday objects into a photo Bingo challenge. Everyone gets the same card in their own order: snap a full line (or the whole card) and call Bingo.</p>
          <ul className="grid gap-2.5">
            {points.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-start gap-3">
                <span aria-hidden="true" className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-secondary text-primary"><Icon className="size-3.5" /></span>
                <span>{text}</span>
              </li>
            ))}
          </ul>
          <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-2 pt-2">
            <Button asChild size="lg">
              <Link href="/dashboard/extra-fun">Try BingoSnap</Link>
            </Button>
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground"><Check aria-hidden="true" className="size-4 text-brand-success" /> Included with every Game Pass</p>
          </div>
        </div>
      </article>
    </Reveal>
  );
}
