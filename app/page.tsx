import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Camera, Gamepad2 } from "lucide-react";

import { Backdrop } from "@/components/brand/backdrop";
import { Logo } from "@/components/brand/logo";
import { SiteHeader } from "@/components/layout/site-header";
import { Audience } from "@/components/marketing/audience";
import { ExtraFun } from "@/components/marketing/extra-fun";
import { HeroScene } from "@/components/marketing/hero-scene";
import { HowItWorks } from "@/components/marketing/how-it-works";
import { Pricing, PricingSection, PricingSkeleton } from "@/components/marketing/pricing";
import { SiteFooter } from "@/components/marketing/legal-page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SITE_DESCRIPTION, SITE_NAME } from "@/lib/site/seo";
import { getSiteUrl } from "@/lib/site/url";

export const metadata: Metadata = { alternates: { canonical: "/" } };

/** Structured data for search engines: the site, who publishes it, and what the app is. */
function StructuredData() {
  const site = getSiteUrl().url;
  const data = {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "WebSite", "@id": `${site}/#website`, url: `${site}/`, name: SITE_NAME, description: SITE_DESCRIPTION, inLanguage: "en", publisher: { "@id": `${site}/#org` } },
      { "@type": "Organization", "@id": `${site}/#org`, name: SITE_NAME, url: `${site}/`, logo: `${site}/icon-512.png` },
      {
        "@type": "WebApplication", "@id": `${site}/#app`, name: SITE_NAME, url: `${site}/`, description: SITE_DESCRIPTION,
        applicationCategory: "GameApplication", operatingSystem: "Any (web browser)",
        browserRequirements: "A modern web browser. Players need a phone camera.",
        image: `${site}/opengraph-image.png`, publisher: { "@id": `${site}/#org` },
      },
    ],
  };
  // "<" is escaped so the JSON can never close the script tag.
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }} />;
}


export default function Home() {
  return (
    <>
      <StructuredData />
      <div className="paper-edge-bottom relative isolate flex min-h-svh flex-col overflow-hidden bg-gradient-to-b from-primary to-brand-night text-white">
        <Backdrop />
        <SiteHeader />

        <section className="mx-auto grid w-full max-w-6xl flex-1 items-center gap-6 px-5 pb-16 pt-2 text-center md:grid-cols-[1.1fr_0.9fr] md:gap-4 md:pb-28 md:pt-12 md:text-left">
          <div className="flex flex-col items-center gap-4 sm:gap-5 md:items-start">
            <Badge variant="yellow" className="animate-rise">Real-time party game</Badge>
            <h1 className="sr-only">BringMe!</h1>
            <div className="animate-rise [animation-delay:80ms]"><Logo size="xl" tone="light" /></div>
            <p className="max-w-md animate-rise text-lg text-white/90 [animation-delay:160ms] sm:text-2xl">
              Find it, snap it, win it. The office party game where the whole team races to bring the goods<span className="hidden sm:inline"> — perfect for team building, town halls and Christmas parties</span>.
            </p>
            <div className="mt-1 grid w-full animate-rise grid-cols-2 gap-3 [animation-delay:240ms] sm:mt-2 sm:flex sm:w-auto">
              <Button asChild size="lg" className="group">
                <Link href="/play"><Camera aria-hidden="true" className="group-hover:animate-wiggle motion-reduce:animate-none" /> Play</Link>
              </Button>
              <Button asChild size="lg" variant="outline-light" className="group">
                <Link href="/dashboard"><Gamepad2 aria-hidden="true" className="group-hover:animate-wiggle motion-reduce:animate-none" /> Host a game</Link>
              </Button>
            </div>
            <p className="animate-rise text-sm text-white/75 [animation-delay:320ms]">Players don&apos;t need an account. Just scan and go. <a href="#pricing" className="font-semibold text-brand-yellow underline-offset-4 hover:underline">See pricing</a></p>
          </div>

          <HeroScene />
        </section>
      </div>

      <main>
        <HowItWorks />
        <Audience />
        <ExtraFun />
        <PricingSection>
          <Suspense fallback={<PricingSkeleton />}>
            <Pricing />
          </Suspense>
        </PricingSection>
      </main>

      <SiteFooter />
    </>
  );
}
