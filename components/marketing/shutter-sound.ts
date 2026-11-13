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
  return Object.assign(click, {
    /** Creates (or resumes) the audio context without making a sound. */
    warm: () => { try { const ac = get(); if (ac?.state === "suspended") void ac.resume(); } catch { /* silent */ } },
    /** Whether the context exists yet (creating it is the slow part). */
    created: () => ctx.current !== null,
  });
}
