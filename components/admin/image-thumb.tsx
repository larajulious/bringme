"use client";

import { useState } from "react";

import { Modal } from "@/components/ui/modal";

/** Table thumbnail (a button) that opens the full photo in a modal. URL is a short-lived signed URL. */
export function ImageThumb({ src, title, details }: { src: string; title: string; details?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
        className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
        {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL, not optimisable */}
        <img src={src} alt="" loading="lazy" decoding="async"
          className="size-14 rounded-xl border object-cover transition-transform motion-safe:hover:scale-105" />
        <span className="sr-only">View photo from {title}</span>
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={title} description={details} className="max-w-3xl">
        {open ? (
          // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL, not optimisable
          <img src={src} alt={`Photo from ${title}`} decoding="async"
            className="mx-auto max-h-[70vh] w-auto max-w-full rounded-2xl border bg-muted object-contain" />
        ) : null}
      </Modal>
    </>
  );
}
