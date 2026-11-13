import Link from "next/link";
import { Check, Gamepad2, QrCode } from "lucide-react";

import { Backdrop } from "@/components/brand/backdrop";
import { PhoneScene, ProjectorScene } from "@/components/marketing/audience-scenes";
import { Reveal } from "@/components/marketing/reveal";
import { OffscreenPause } from "@/components/layout/offscreen-pause";
import { StoryStage } from "@/components/marketing/story/stage";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Role = {
  badge: { label: string; variant: "default" | "coral" };
  title: string;
  lead: string;
  points: string[];
  cta: { href: string; label: string; icon: typeof QrCode; variant: "default" | "secondary" };
  note: string;
  panel: React.ReactNode;
  scene: React.ReactNode;
};

const roles: Role[] = [
  {
    badge: { label: "Players", variant: "default" },
    title: "Join in seconds",
    lead: "Everyone plays on the phone in their pocket.",
    points: ["Scan the QR code: no app, no account", "Race around and snap the item", "See the winner live on the big screen"],
    cta: { href: "/play", label: "Join a game", icon: QrCode, variant: "default" },
    note: "Free for players, always.",
    panel: (
      <>
        <span aria-hidden="true" className="absolute inset-0 -z-10 bg-brand-yellow" />
        <span aria-hidden="true" className="absolute inset-0 -z-10 opacity-25 [background-image:radial-gradient(hsl(var(--brand-yellow-deep))_1.5px,transparent_1.5px)] [background-size:18px_18px]" />
      </>
    ),
    scene: <PhoneScene />,
  },
  {
    badge: { label: "Game Masters", variant: "coral" },
    title: "Run the show",
    lead: "You host from a laptop, everyone watches the big screen.",
    points: ["Set up rounds and items in a minute", "Put it on the projector with presenter mode", "Judge photos and crown the winners"],
    cta: { href: "/dashboard", label: "Host a game", icon: Gamepad2, variant: "secondary" },
    note: "Free 7-day trial for up to 3 players.",
    panel: (
      <>
        <span aria-hidden="true" className="absolute inset-0 -z-20 bg-gradient-to-br from-primary to-brand-night" />
        <Backdrop />
      </>
    ),
    scene: <ProjectorScene />,
  },
];

/**
 * "Who is it for?": the two sides of every game (players on their phones, the Game Master on
 * the big screen) as alternating rows, each with a tappable
 * mini demo, three benefits and one clear action. Motion is the shared scroll Reveal (none with
 * reduced motion or without JS); the demos' loops wait until the section is on screen.
 */
export function Audience() {
  return (
    <section aria-labelledby="roles-heading" className="paper-section relative z-10 my-6 flex min-h-svh flex-col justify-center overflow-x-clip px-5 py-[clamp(3rem,8svh,6rem)]">
      <StoryStage name="audience" tone="paper" />
      <OffscreenPause />
      <Reveal className="relative isolate z-[2] mx-auto grid w-full max-w-6xl gap-[clamp(1.5rem,5svh,3rem)]">
        <div className="text-center">
          <h2 id="roles-heading" className="reveal-item mb-3 text-3xl font-bold text-primary sm:text-4xl lg:text-5xl">Who is it for?</h2>
          <p className="reveal-item mx-auto max-w-xl text-muted-foreground [--i:1] lg:text-lg">
            Any team that gets together. Everyone in the room can play.
          </p>
        </div>

        <div className="grid gap-6">
          {roles.map((r, i) => (
            <article
              key={r.title}
              aria-labelledby={`role-${i}`}
              className={cn("reveal-item grid overflow-hidden rounded-4xl bg-card shadow-card ring-1 ring-primary/10 md:grid-cols-2", i % 2 ? "reveal-right" : "reveal-left")}
              style={{ "--i": i + 2 } as React.CSSProperties}
            >
              <div className={cn("relative isolate grid min-h-72 place-items-center overflow-hidden px-6 py-8 sm:p-8", i % 2 && "md:order-2")}>
                {r.panel}
                {r.scene}
              </div>
              <div className="flex flex-col justify-center gap-4 p-6 sm:p-8 lg:p-10">
                <Badge variant={r.badge.variant} className="w-fit">{r.badge.label}</Badge>
                <div className="grid gap-1">
                  <h3 id={`role-${i}`} className="font-display text-2xl font-bold text-foreground sm:text-3xl">{r.title}</h3>
                  <p className="text-muted-foreground lg:text-lg">{r.lead}</p>
                </div>
                <ul className="grid gap-2.5">
                  {r.points.map((t) => (
                    <li key={t} className="flex items-start gap-2.5">
                      <span aria-hidden="true" className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-brand-success/15 text-brand-success">
                        <Check className="size-3.5" strokeWidth={3} />
                      </span>
                      {t}
                    </li>
                  ))}
                </ul>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1">
                  <Button asChild variant={r.cta.variant} className="group/btn">
                    <Link href={r.cta.href}><r.cta.icon aria-hidden="true" className="group-hover/btn:animate-wiggle motion-reduce:animate-none" /> {r.cta.label}</Link>
                  </Button>
                  <span className="text-sm text-muted-foreground">{r.note}</span>
                </div>
              </div>
            </article>
          ))}
        </div>
      </Reveal>
    </section>
  );
}
