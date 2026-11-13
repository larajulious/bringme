"use client";

import { Hand, Sparkles, StickyNote, Timer, Trophy, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Mascot } from "@/components/brand/mascot";
import { setPreference } from "@/lib/site/consent";
import { useShutterSound } from "@/components/marketing/shutter-sound";
import { useBoopCounter } from "@/components/marketing/use-boop-counter";
import { cn } from "@/lib/utils";

/** Office-flavoured "Bring me…" prompts the visitor can shuffle by tapping Snappy. */
const PROMPTS = [
  "a red stapler", "your company ID", "a mug that says #1", "pandesal from the pantry", "a yellow sticky note",
  "a calculator", "the aircon remote", "a ballpen that clicks", "someone's lanyard", "a tumbler with stickers",
];

const MUTE_KEY = "bm_snappy_muted";

/** Browser storage can be missing or throw (private mode, blocked site data): never let that break the hero. */
function read(key: string) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string) {
  setPreference(key, value);
}

/**
 * Homepage hero visual: Snappy front and centre. Tapping draws a new "Bring me…" prompt, plays a shutter click,
 * starts a playful timer and adds a "boop" to the global counter (batched + rate limited; see use-boop-counter.ts).
 * Transform/opacity animations only; reduced motion keeps everything static (text and counter still update).
 */
export function HeroScene() {
  const [n, setN] = useState(0);
  const [muted, setMuted] = useState(false);
  const [ms, setMs] = useState<number | null>(null);
  const started = useRef(0);
  const click = useShutterSound();
  const boops = useBoopCounter();

  useEffect(() => {
    // Restore per-visitor prefs after hydration (storage is client-only).
    setMuted(read(MUTE_KEY) === "1");
  }, []);

  useEffect(() => {
    if (n === 0) return;
    started.current = performance.now();
    const id = window.setInterval(() => {
      const t = performance.now() - started.current;
      if (t >= 9_999) { setMs(9_999); window.clearInterval(id); } else setMs(t);
    }, 47);
    return () => window.clearInterval(id);
  }, [n]);

  const tap = () => {
    if (!muted) click();
    setN((x) => x + 1);
    boops.tap();
  };
  const toggleMute = () => setMuted((m) => { write(MUTE_KEY, m ? "0" : "1"); return !m; });

  const prompt = PROMPTS[n % PROMPTS.length];

  return (
    <div className="relative mx-auto grid w-full max-w-md justify-items-center gap-3 py-2 md:py-6">
      <div aria-hidden="true" className="absolute left-1/2 top-1/2 size-64 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/10 sm:size-96" />

      <div key={n} className="relative animate-pop-in rounded-2xl bg-white px-5 py-2.5 text-center text-brand-night shadow-card" aria-live="polite">
        <span className="block text-xs font-bold uppercase tracking-widest text-primary">Bring me…</span>
        <span className="font-display text-lg font-bold sm:text-xl">{prompt}</span>
      </div>

      <div className="relative">
        <button
          type="button"
          onClick={tap}
          className="group relative block rounded-full outline-none focus-visible:ring-4 focus-visible:ring-brand-yellow"
          aria-label="Tap Snappy for another item to bring"
        >
          <span aria-hidden="true" className="absolute inset-2 animate-ping-soft rounded-full border-2 border-brand-yellow/60 motion-reduce:hidden" />
          <span key={n} className={cn("block", n > 0 && "animate-wiggle motion-reduce:animate-none")}>
            <Mascot mood="cheer" className="w-36 transition-transform duration-200 group-hover:scale-105 group-active:scale-95 sm:w-60" />
          </span>
        </button>
        <span aria-hidden="true" className="absolute -left-16 top-4 hidden -rotate-6 animate-bob items-center gap-1.5 rounded-2xl bg-white px-3 py-1.5 font-display text-sm font-bold text-primary shadow-card motion-reduce:animate-none sm:inline-flex [animation-delay:2.1s]">
          <StickyNote className="size-4 text-brand-coral" /> 3 · 2 · 1
        </span>
        <span aria-hidden="true" className="absolute -right-16 bottom-10 hidden rotate-6 animate-bob items-center gap-1.5 rounded-2xl bg-brand-coral px-3 py-1.5 font-display text-sm font-bold text-white shadow-card motion-reduce:animate-none sm:inline-flex [animation-delay:1.2s]">
          <Trophy className="size-4" /> Winner!
        </span>
      </div>

      <div className="relative flex flex-wrap items-center justify-center gap-2 font-mono text-sm font-bold tabular-nums">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-night/70 px-3 py-1.5 text-brand-yellow">
          {ms === null ? <><Sparkles aria-hidden="true" className="size-4" /> Tap Snappy!</> : <><Timer aria-hidden="true" className="size-4" /> {(ms / 1000).toFixed(3)}s</>}
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5 text-white" title="Boops from everyone, everywhere">
          <Hand aria-hidden="true" className="size-4" />
          {boops.total === null && !boops.settled ? (
            <span aria-hidden="true" className="inline-block h-4 w-14 rounded-full bg-white/25 motion-safe:animate-pulse" />
          ) : boops.total === null ? (
            <span className="font-sans font-semibold">{boops.mine.toLocaleString()} {boops.mine === 1 ? "boop" : "boops"}</span>
          ) : (
            <>
              <span key={boops.total} className="inline-block animate-pop-in">{boops.total.toLocaleString()}</span>
              <span className="font-sans font-semibold">{boops.total === 1 ? "boop" : "boops"}</span>
            </>
          )}
        </span>
        <button
          type="button"
          onClick={toggleMute}
          aria-pressed={!muted}
          aria-label="Tap sound"
          title={muted ? "Sound off" : "Sound on"}
          className="grid size-9 place-items-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-yellow"
        >
          {muted ? <VolumeX aria-hidden="true" className="size-4" /> : <Volume2 aria-hidden="true" className="size-4" />}
        </button>
      </div>
    </div>
  );
}
