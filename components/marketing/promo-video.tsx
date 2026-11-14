"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { Camera, Gamepad2, Play, Volume2 } from "lucide-react";

import { Reveal } from "@/components/marketing/reveal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/**
 * Homepage "See it in action": the square promo clip (public/bringme-1x1.mp4) in the same card
 * layout as Extra Fun. It doesn't autoplay (the clip has sound): a big play button sits over the
 * poster, and native controls take over once it starts. Only metadata is preloaded.
 */
export function PromoVideo() {
  const video = useRef<HTMLVideoElement>(null);
  const [started, setStarted] = useState(false);

  const play = () => {
    setStarted(true);
    void video.current?.play().catch(() => setStarted(false));
  };

  return (
    <Reveal as="section" id="watch" aria-labelledby="watch-heading" className="relative isolate mx-auto flex w-full max-w-6xl scroll-mt-6 flex-col justify-center px-5 py-[clamp(3rem,8svh,6rem)]">
      <h2 id="watch-heading" className="reveal-item mb-3 text-center text-3xl font-bold text-primary sm:text-4xl lg:text-5xl">See it in action</h2>
      <p className="reveal-item mx-auto mb-[clamp(1.5rem,5svh,3.5rem)] max-w-xl text-center text-muted-foreground [--i:1] lg:text-lg">
        45 seconds, one round, the whole office running.
      </p>

      <article className="reveal-item grid overflow-hidden rounded-4xl bg-card shadow-card ring-1 ring-primary/10 [--i:2] md:grid-cols-[1.1fr_0.9fr]">
        <div className="relative aspect-square w-full bg-brand-night">
          <video
            ref={video}
            className="size-full object-cover"
            src="/bringme-1x1.mp4"
            poster="/bringme-1x1-poster.jpg"
            controls={started}
            playsInline
            preload="metadata"
            aria-label="BringMe! promo video"
            onPlay={() => setStarted(true)}
          />
          {!started && (
            <button
              type="button"
              onClick={play}
              aria-label="Play the BringMe! video"
              className="group absolute inset-0 grid place-items-center focus-visible:outline-none"
            >
              <span className="grid size-20 place-items-center rounded-full bg-brand-yellow text-brand-night shadow-pop transition-transform duration-200 group-hover:scale-110 group-focus-visible:scale-110 group-focus-visible:ring-4 group-focus-visible:ring-white motion-reduce:transition-none sm:size-24">
                <Play aria-hidden="true" className="ml-1 size-9 fill-current sm:size-10" />
              </span>
            </button>
          )}
        </div>

        <div className="flex flex-col justify-center gap-4 p-6 sm:p-8 lg:p-10">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="yellow">Watch</Badge>
            <span className="flex items-center gap-1 text-xs font-bold uppercase tracking-wide text-primary"><Volume2 aria-hidden="true" className="size-3.5" /> Sound on</span>
          </div>
          <h3 className="font-display text-3xl font-bold text-foreground sm:text-4xl">Find it. Snap it. Win it.</h3>
          <p className="text-lg text-muted-foreground">
            The Game Master shouts an item, everyone races to find it and snaps a photo, and the fastest
            picture wins the round on the big screen.
          </p>
          <div className="mt-2 flex flex-wrap gap-3">
            <Button asChild size="lg" className="group/btn">
              <Link href="/play"><Camera aria-hidden="true" className="group-hover/btn:animate-wiggle motion-reduce:animate-none" /> Play</Link>
            </Button>
            <Button asChild size="lg" variant="secondary" className="group/btn">
              <Link href="/dashboard"><Gamepad2 aria-hidden="true" className="group-hover/btn:animate-wiggle motion-reduce:animate-none" /> Host a game</Link>
            </Button>
          </div>
        </div>
      </article>
    </Reveal>
  );
}
