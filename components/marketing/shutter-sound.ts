"use client";

import { useRef } from "react";

type AC = typeof AudioContext;

/**
 * A short camera-shutter "click", synthesised with Web Audio (no audio files, no library). Browsers keep audio locked
 * until a user gesture, so call it from (or after) one.
 *
 * Creating the AudioContext is slow (~100–200 ms the first time: the audio device starts up). Where the click must be
 * instant (e.g. mid-animation), call `click.warm()` ahead of time, off the critical path (idle), and again from a
 * gesture (cheap once created: it only resumes, which is what unlocks audio on iOS).
 */
export function useShutterSound() {
  const ctx = useRef<AudioContext | null>(null);
  const get = () => {
    const C = window.AudioContext ?? (window as unknown as { webkitAudioContext?: AC }).webkitAudioContext;
    return C ? (ctx.current ??= new C()) : null;
  };
  const click = () => {
    try {
      const ac = get();
      if (!ac) return;
      if (ac.state === "suspended") void ac.resume();
      const t = ac.currentTime;
      // noise burst = the shutter
      const len = Math.floor(ac.sampleRate * 0.05);
      const buf = ac.createBuffer(1, len, ac.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
      const noise = ac.createBufferSource();
      noise.buffer = buf;
      const hp = ac.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 1800;
      const ng = ac.createGain();
      ng.gain.value = 0.35;
      noise.connect(hp).connect(ng).connect(ac.destination);
      noise.start(t);
      // tiny rising blip = playful "pop"
      const osc = ac.createOscillator();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(660, t);
      osc.frequency.exponentialRampToValueAtTime(1320, t + 0.08);
      const og = ac.createGain();
      og.gain.setValueAtTime(0.0001, t);
      og.gain.exponentialRampToValueAtTime(0.18, t + 0.01);
      og.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      osc.connect(og).connect(ac.destination);
      osc.start(t);
      osc.stop(t + 0.13);
    } catch { /* audio unavailable: silent */ }
  };
  const bag = useRef<number[]>([]);
  const last = useRef(-1);
  /** A random cartoon sound from BOOPS: each one plays once before any repeats, never the same twice in a row. */
  const boop = () => {
    try {
      const ac = get();
      if (!ac) return;
      if (ac.state === "suspended") void ac.resume();
      if (bag.current.length === 0) {
        bag.current = BOOPS.map((_, i) => i).sort(() => Math.random() - 0.5);
        if (bag.current[0] === last.current) bag.current.push(bag.current.shift()!);
      }
      last.current = bag.current.shift()!;
      BOOPS[last.current](ac, ac.currentTime + 0.005, 0.92 + Math.random() * 0.2);
    } catch { /* audio unavailable: silent */ }
  };
  return Object.assign(click, {
    /** Plays a random funny sound (the homepage Snappy boop). */
    boop,
    /** Creates (or resumes) the audio context without making a sound. */
    warm: () => { try { const ac = get(); if (ac?.state === "suspended") void ac.resume(); } catch { /* silent */ } },
    /** Whether the context exists yet (creating it is the slow part). */
    created: () => ctx.current !== null,
  });
}

/* ------------------------------------------------------------------------------------------------
 * Boops: tiny cartoon sounds, all synthesised. Each takes (context, start time, pitch factor ~0.92–1.12)
 * so repeats of the same sound still vary a little. Kept short (< 0.6 s) and quiet.
 * ---------------------------------------------------------------------------------------------- */

type Boop = (ac: AudioContext, t: number, p: number) => void;

/** Output gain with a quick attack and an exponential fade: the envelope every boop goes through. */
function env(ac: AudioContext, t: number, peak: number, dur: number, attack = 0.01) {
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  g.connect(ac.destination);
  return g;
}

function tone(ac: AudioContext, type: OscillatorType, t: number, dur: number, dest: AudioNode) {
  const o = ac.createOscillator();
  o.type = type;
  o.connect(dest);
  o.start(t);
  o.stop(t + dur + 0.02);
  return o;
}

/** Wobbles an oscillator's pitch (rate in Hz, depth in Hz, fading out over `dur` when `fade`). */
function vibrato(ac: AudioContext, o: OscillatorNode, t: number, dur: number, rate: number, depth: number, fade = false) {
  const lfo = ac.createOscillator();
  lfo.frequency.value = rate;
  const d = ac.createGain();
  d.gain.setValueAtTime(depth, t);
  if (fade) d.gain.exponentialRampToValueAtTime(1, t + dur);
  lfo.connect(d).connect(o.frequency);
  lfo.start(t);
  lfo.stop(t + dur + 0.02);
}

const BOOPS: Boop[] = [
  // boing: a spring that wobbles and settles
  (ac, t, p) => {
    const o = tone(ac, "sine", t, 0.5, env(ac, t, 0.3, 0.5));
    o.frequency.setValueAtTime(170 * p, t);
    o.frequency.exponentialRampToValueAtTime(260 * p, t + 0.5);
    vibrato(ac, o, t, 0.5, 13, 90, true);
  },
  // rubber duck squeak-squeak
  (ac, t, p) => {
    for (const [s, up] of [[0, 1], [0.17, 1.12]] as const) {
      const bp = ac.createBiquadFilter();
      bp.type = "bandpass"; bp.frequency.value = 2200; bp.Q.value = 3;
      bp.connect(env(ac, t + s, 0.22, 0.15, 0.015));
      const o = tone(ac, "square", t + s, 0.15, bp);
      o.frequency.setValueAtTime(900 * p * up, t + s);
      o.frequency.exponentialRampToValueAtTime(1700 * p * up, t + s + 0.05);
      o.frequency.exponentialRampToValueAtTime(1150 * p * up, t + s + 0.15);
    }
  },
  // slide whistle up
  (ac, t, p) => {
    const o = tone(ac, "sine", t, 0.4, env(ac, t, 0.2, 0.4, 0.04));
    o.frequency.setValueAtTime(380 * p, t);
    o.frequency.exponentialRampToValueAtTime(1700 * p, t + 0.36);
    vibrato(ac, o, t, 0.4, 7, 30);
  },
  // bloop-bloop: water drops
  (ac, t, p) => {
    for (const [s, f, v] of [[0, 1, 0.32], [0.11, 1.35, 0.2]] as const) {
      const o = tone(ac, "sine", t + s, 0.12, env(ac, t + s, v, 0.12, 0.005));
      o.frequency.setValueAtTime(950 * p * f, t + s);
      o.frequency.exponentialRampToValueAtTime(220 * p * f, t + s + 0.1);
    }
  },
  // clown horn: honk honk
  (ac, t, p) => {
    for (const s of [0, 0.24]) {
      const lp = ac.createBiquadFilter();
      lp.type = "lowpass"; lp.frequency.value = 1500;
      lp.connect(env(ac, t + s, 0.14, 0.2, 0.02));
      for (const f of [330, 336]) {
        const o = tone(ac, "sawtooth", t + s, 0.2, lp);
        o.frequency.setValueAtTime(f * p, t + s);
        o.frequency.linearRampToValueAtTime(f * p * 0.94, t + s + 0.2);
      }
    }
  },
  // raspberry: pbbbt
  (ac, t, p) => {
    const lp = ac.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 900;
    lp.connect(env(ac, t, 0.35, 0.38, 0.02));
    const am = ac.createGain();
    am.gain.value = 0.5;
    am.connect(lp);
    const o = tone(ac, "sawtooth", t, 0.38, am);
    o.frequency.setValueAtTime(95 * p, t);
    o.frequency.linearRampToValueAtTime(75 * p, t + 0.38);
    const flutter = ac.createOscillator();
    flutter.type = "square"; flutter.frequency.value = 32;
    const depth = ac.createGain();
    depth.gain.value = 0.5;
    flutter.connect(depth).connect(am.gain);
    flutter.start(t); flutter.stop(t + 0.4);
  },
  // giggle: hee-hee-hee-hee
  (ac, t, p) => {
    [760, 980, 860, 1180].forEach((f, i) => {
      const s = t + i * 0.07;
      const o = tone(ac, "triangle", s, 0.06, env(ac, s, 0.2, 0.06, 0.005));
      o.frequency.setValueAtTime(f * p, s);
      o.frequency.exponentialRampToValueAtTime(f * p * 1.25, s + 0.05);
    });
  },
  // slide whistle down: whooop
  (ac, t, p) => {
    const o = tone(ac, "triangle", t, 0.45, env(ac, t, 0.22, 0.45, 0.02));
    o.frequency.setValueAtTime(1500 * p, t);
    o.frequency.exponentialRampToValueAtTime(260 * p, t + 0.42);
    vibrato(ac, o, t, 0.45, 9, 40);
  },
  // wah-wah: a filter that opens and closes twice
  (ac, t, p) => {
    const lp = ac.createBiquadFilter();
    lp.type = "lowpass"; lp.Q.value = 8;
    lp.frequency.setValueAtTime(350, t);
    lp.frequency.exponentialRampToValueAtTime(2200, t + 0.12);
    lp.frequency.exponentialRampToValueAtTime(350, t + 0.26);
    lp.frequency.exponentialRampToValueAtTime(2000, t + 0.38);
    lp.frequency.exponentialRampToValueAtTime(300, t + 0.55);
    lp.connect(env(ac, t, 0.12, 0.58, 0.02));
    const o = tone(ac, "sawtooth", t, 0.58, lp);
    o.frequency.setValueAtTime(200 * p, t);
    o.frequency.linearRampToValueAtTime(170 * p, t + 0.58);
  },
  // cork pop
  (ac, t, p) => {
    const o = tone(ac, "sine", t, 0.09, env(ac, t, 0.4, 0.09, 0.003));
    o.frequency.setValueAtTime(1100 * p, t);
    o.frequency.exponentialRampToValueAtTime(120 * p, t + 0.07);
    const len = Math.floor(ac.sampleRate * 0.03);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
    const n = ac.createBufferSource();
    n.buffer = buf;
    n.connect(env(ac, t, 0.25, 0.04, 0.002));
    n.start(t);
  },
];
