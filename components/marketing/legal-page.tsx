import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { BadgeCheck } from "lucide-react";

import { Backdrop } from "@/components/brand/backdrop";
import { Logo } from "@/components/brand/logo";
import { Mascot } from "@/components/brand/mascot";
import { SiteHeader } from "@/components/layout/site-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export type LegalSection = { id: string; icon: LucideIcon; tone: string; title: string; body: React.ReactNode };

/** Optional public support address (not a secret). Set NEXT_PUBLIC_SUPPORT_EMAIL to show a mail link. */
const SUPPORT_EMAIL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL || null;

/** Shared footer for public pages, with links to the legal pages. */
export function SiteFooter() {
  return (
    <footer className="paper-edge-top relative isolate overflow-hidden bg-brand-night px-5 pb-10 pt-14 text-center text-sm text-white/80">
      <Logo size="sm" tone="light" className="mb-2" />
      <p>The real-time party game.</p>
      <nav aria-label="Legal" className="mt-3 flex justify-center gap-4">
        <Link href="/terms" className="font-semibold underline underline-offset-4 hover:text-brand-yellow">Terms &amp; Conditions</Link>
        <Link href="/privacy" className="font-semibold underline underline-offset-4 hover:text-brand-yellow">Privacy Policy</Link>
      </nav>
    </footer>
  );
}

export function SupportLine({ fallback }: { fallback: string }) {
  return SUPPORT_EMAIL ? (
    <>Email us at <a className="font-semibold text-primary underline underline-offset-4" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.</>
  ) : (
    <>{fallback}</>
  );
}

/** Playful-but-readable layout for Terms, Privacy and similar pages. */
export function LegalPage({
  title, intro, updated, mood, summary, sections, question,
}: {
  title: string; intro: string; updated: string; mood: "happy" | "waiting" | "cheer" | "judging";
  summary: string[]; sections: LegalSection[]; question: string;
}) {
  return (
    <>
      <div className="relative isolate overflow-hidden bg-gradient-to-b from-primary to-brand-night text-white">
        <Backdrop />
        <SiteHeader />
        <section className="mx-auto flex max-w-3xl flex-col items-center gap-4 px-5 pb-16 pt-4 text-center sm:pb-20">
          <Mascot mood={mood} className="w-24 animate-rise sm:w-28" />
          <Badge variant="yellow" className="animate-rise [animation-delay:80ms]">Last updated {updated}</Badge>
          <h1 className="animate-rise font-display text-4xl font-bold [animation-delay:120ms] sm:text-5xl">{title}</h1>
          <p className="max-w-xl animate-rise text-lg text-white/85 [animation-delay:160ms]">{intro}</p>
        </section>
      </div>

      <main className="mx-auto -mt-10 grid max-w-3xl gap-6 px-5 pb-16">
        <Card className="animate-rise border-brand-yellow/60 [animation-delay:200ms]">
          <CardHeader><CardTitle>In short</CardTitle></CardHeader>
          <CardContent>
            <ul className="grid gap-3">
              {summary.map((s) => (
                <li key={s} className="flex items-start gap-3">
                  <BadgeCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-brand-success" />
                  <span>{s}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <nav aria-label="Sections" className="flex flex-wrap justify-center gap-2">
          {sections.map((s, i) => (
            <a key={s.id} href={`#${s.id}`} className="rounded-full bg-secondary px-3 py-1.5 text-sm font-semibold text-secondary-foreground transition-colors hover:bg-primary hover:text-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring">
              {i + 1}. {s.title}
            </a>
          ))}
        </nav>

        <ol className="grid gap-5">
          {sections.map(({ id, icon: Icon, tone, title: heading, body }, i) => (
            <li key={id} id={id} className="scroll-mt-6">
              <Card className="group">
                <CardHeader className="flex-row items-center gap-4 space-y-0">
                  <span aria-hidden="true" className={`grid size-12 shrink-0 place-items-center rounded-2xl ${tone} group-hover:animate-wiggle motion-reduce:animate-none`}>
                    <Icon className="size-6" />
                  </span>
                  <CardTitle className="text-xl sm:text-2xl"><span className="mr-1 text-brand-coral">{i + 1}.</span>{heading}</CardTitle>
                </CardHeader>
                <CardContent className="text-muted-foreground [&_li]:pl-1 [&_p+p]:mt-3 [&_p+ul]:mt-3 [&_ul+p]:mt-4 [&_strong]:text-foreground [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-5">
                  {body}
                </CardContent>
              </Card>
            </li>
          ))}
        </ol>

        <Card className="bg-secondary text-center">
          <CardContent className="grid justify-items-center gap-3 p-6">
            <p className="font-display text-xl font-bold text-primary">{question}</p>
            <p className="text-muted-foreground"><SupportLine fallback="Reach out to the BringMe! team and we'll be happy to help." /></p>
            <Button asChild variant="outline"><Link href="/">Back to home</Link></Button>
          </CardContent>
        </Card>
      </main>

      <SiteFooter />
    </>
  );
}
