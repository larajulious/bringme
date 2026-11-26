import Link from "next/link";
import { ArrowRight, BadgeCheck, Camera, ChevronDown, Gamepad2 } from "lucide-react";

import { Backdrop } from "@/components/brand/backdrop";
import { Mascot } from "@/components/brand/mascot";
import { SiteHeader } from "@/components/layout/site-header";
import { JsonLd } from "@/components/marketing/json-ld";
import { SiteFooter } from "@/components/marketing/legal-page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { GUIDES, guidePath, type Guide } from "@/lib/site/guides";
import { SITE_NAME } from "@/lib/site/seo";
import { getSiteUrl } from "@/lib/site/url";

type Crumb = { name: string; href: string };

const linkClass = "font-semibold underline-offset-4 hover:text-brand-yellow hover:underline focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring rounded";

/** Purple hero shared by the guides and the /party-games hub, with a visible breadcrumb trail. */
function GuideHero({ crumbs, mood, badge, title, intro }: { crumbs: Crumb[]; mood: Guide["mood"]; badge: string; title: string; intro: string }) {
  return (
    <div className="relative isolate overflow-hidden bg-gradient-to-b from-primary to-brand-night text-white">
      <Backdrop />
      <SiteHeader />
      <nav aria-label="Breadcrumb" className="mx-auto max-w-3xl px-5 text-sm text-white/75">
        <ol className="flex flex-wrap justify-center gap-x-2">
          {crumbs.map((c, i) => (
            <li key={c.href} className="flex items-center gap-2">
              {i > 0 ? <span aria-hidden="true">/</span> : null}
              {i < crumbs.length - 1 ? <Link href={c.href} className={linkClass}>{c.name}</Link> : <span aria-current="page">{c.name}</span>}
            </li>
          ))}
        </ol>
      </nav>
      <section className="mx-auto flex max-w-3xl flex-col items-center gap-4 px-5 pb-16 pt-6 text-center sm:pb-20">
        <Mascot mood={mood} className="w-24 animate-rise sm:w-28" />
        <Badge variant="yellow" className="animate-rise [animation-delay:80ms]">{badge}</Badge>
        <h1 className="animate-rise font-display text-4xl font-bold [animation-delay:120ms] sm:text-5xl">{title}</h1>
        <p className="max-w-xl animate-rise text-lg text-white/85 [animation-delay:160ms]">{intro}</p>
        <div className="mt-2 flex animate-rise flex-wrap justify-center gap-3 [animation-delay:200ms]">
          <Button asChild size="lg" className="group">
            <Link href="/auth/login?mode=signup&next=/dashboard"><Gamepad2 aria-hidden="true" className="group-hover:animate-wiggle motion-reduce:animate-none" /> Host a game free</Link>
          </Button>
          <Button asChild size="lg" variant="outline-light" className="group">
            <Link href="/play"><Camera aria-hidden="true" className="group-hover:animate-wiggle motion-reduce:animate-none" /> Join a game</Link>
          </Button>
        </div>
      </section>
    </div>
  );
}

function RelatedGuides({ current }: { current?: string }) {
  const others = GUIDES.filter((g) => g.slug !== current);
  return (
    <section aria-labelledby="related-heading">
      <h2 id="related-heading" className="mb-4 text-center font-display text-2xl font-bold text-primary sm:text-3xl">
        {current ? "More party game ideas" : "All guides"}
      </h2>
      <ul className="grid gap-4 sm:grid-cols-2">
        {others.map((g) => (
          <li key={g.slug}>
            <Link href={guidePath(g.slug)} className="group block h-full rounded-3xl focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring">
              <Card className="h-full transition-transform duration-150 group-hover:-translate-y-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-y-0">
                <CardContent className="grid gap-2 p-5">
                  <span className="text-xs font-bold uppercase tracking-wide text-brand-coral">{g.badge}</span>
                  <span className="font-display text-lg font-bold text-foreground">{g.title}</span>
                  <span className="text-sm text-muted-foreground">{g.description}</span>
                  <span className="mt-1 inline-flex items-center gap-1 text-sm font-semibold text-primary">
                    Read guide <ArrowRight aria-hidden="true" className="size-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
                  </span>
                </CardContent>
              </Card>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PlayCta() {
  return (
    <Card className="bg-secondary text-center">
      <CardContent className="grid justify-items-center gap-3 p-6 sm:p-8">
        <p className="font-display text-2xl font-bold text-primary">Play it live with {SITE_NAME}</p>
        <p className="max-w-lg text-muted-foreground">
          Put the game on the big screen, let everyone scan the QR code, and race to snap each item. No app, no sign-up for players.
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          <Button asChild><Link href="/auth/login?mode=signup&next=/dashboard">Start free</Link></Button>
          <Button asChild variant="outline"><Link href="/">See how it works</Link></Button>
        </div>
      </CardContent>
    </Card>
  );
}

const formatDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** One guide: hero, how-to sections, idea lists, FAQ, related guides. Emits Breadcrumb, Article and FAQPage JSON-LD. */
export function GuidePage({ guide }: { guide: Guide }) {
  const site = getSiteUrl().url;
  const path = guidePath(guide.slug);
  const url = `${site}${path}`;
  const crumbs: Crumb[] = [{ name: "Home", href: "/" }, { name: "Party games", href: "/party-games" }, { name: guide.short, href: path }];
  const org = { "@type": "Organization", name: SITE_NAME, url: `${site}/`, logo: `${site}/icon-512.png` };

  const data = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BreadcrumbList",
        itemListElement: crumbs.map((c, i) => ({ "@type": "ListItem", position: i + 1, name: c.name, item: `${site}${c.href === "/" ? "/" : c.href}` })),
      },
      {
        "@type": "Article", "@id": `${url}#article`, headline: guide.title, description: guide.description, inLanguage: "en",
        mainEntityOfPage: url, image: `${site}/opengraph-image.png`, datePublished: guide.updated, dateModified: guide.updated,
        author: org, publisher: org,
      },
      {
        "@type": "FAQPage",
        mainEntity: guide.faq.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
      },
    ],
  };

  return (
    <>
      <JsonLd data={data} />
      <GuideHero crumbs={crumbs} mood={guide.mood} badge={guide.badge} title={guide.title} intro={guide.intro} />

      <main className="mx-auto -mt-10 grid max-w-3xl gap-6 px-5 pb-16">
        <article className="grid gap-6">
          {guide.sections.map((s) => (
            <Card key={s.heading} className="animate-rise [animation-delay:200ms]">
              <CardHeader><h2 className="font-display text-xl font-semibold leading-tight tracking-tight sm:text-2xl">{s.heading}</h2></CardHeader>
              <CardContent className="grid gap-3 text-muted-foreground">
                {s.paragraphs?.map((p) => <p key={p}>{p}</p>)}
                {s.list ? (
                  <ul className="grid gap-3">
                    {s.list.map((item) => (
                      <li key={item} className="flex items-start gap-3">
                        <BadgeCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-brand-success" />
                        <span className="text-foreground">{item}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </CardContent>
            </Card>
          ))}

          <Card className="border-brand-yellow/60">
            <CardHeader>
              <h2 className="font-display text-xl font-semibold leading-tight tracking-tight sm:text-2xl">{guide.ideas.heading}</h2>
              <p className="text-muted-foreground">{guide.ideas.intro}</p>
            </CardHeader>
            <CardContent className="grid gap-6">
              {guide.ideas.groups.map((g) => (
                <div key={g.name}>
                  <h3 className="mb-2 font-display text-lg font-bold text-primary">{g.name}</h3>
                  <ul className="flex flex-wrap gap-2">
                    {g.items.map((item) => (
                      <li key={item} className="rounded-full bg-secondary px-3 py-1.5 text-sm font-semibold text-secondary-foreground">{item}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </CardContent>
          </Card>
        </article>

        <PlayCta />

        <section aria-labelledby="faq-heading">
          <h2 id="faq-heading" className="mb-4 text-center font-display text-2xl font-bold text-primary sm:text-3xl">Frequently asked questions</h2>
          <div className="grid gap-3">
            {guide.faq.map((f) => (
              <details key={f.q} className="group rounded-3xl bg-card shadow-card ring-1 ring-primary/10 [&_summary::-webkit-details-marker]:hidden">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-3xl p-5 font-display text-lg font-bold text-foreground focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring">
                  {f.q}
                  <ChevronDown aria-hidden="true" className="size-5 shrink-0 text-primary transition-transform group-open:rotate-180 motion-reduce:transition-none" />
                </summary>
                <p className="px-5 pb-5 text-muted-foreground">{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        <RelatedGuides current={guide.slug} />
        <p className="text-center text-sm text-muted-foreground">Updated {formatDate(guide.updated)}</p>
      </main>

      <SiteFooter />
    </>
  );
}

/** /party-games: every guide in one place. */
export function GuidesHub() {
  const site = getSiteUrl().url;
  const data = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "Party game ideas",
    url: `${site}/party-games`,
    hasPart: GUIDES.map((g) => ({ "@type": "Article", headline: g.title, url: `${site}${guidePath(g.slug)}` })),
  };
  return (
    <>
      <JsonLd data={data} />
      <GuideHero
        crumbs={[{ name: "Home", href: "/" }, { name: "Party games", href: "/party-games" }]}
        mood="cheer"
        badge="Free guides"
        title="Party game ideas for work, teams and holidays"
        intro="Ready-to-use ideas for the Bring Me game, photo scavenger hunts, photo bingo, Christmas parties and team icebreakers, plus how to run each one live."
      />
      <main className="mx-auto grid max-w-3xl gap-8 px-5 pb-16 pt-10">
        <RelatedGuides />
        <PlayCta />
      </main>
      <SiteFooter />
    </>
  );
}
