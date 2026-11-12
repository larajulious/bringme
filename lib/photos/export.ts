"use client";

/**
 * "Save a copy": only ever on an explicit tap, never automatically. Uses the share sheet where
 * the device offers file sharing (the player chooses "Save Image" / an app), otherwise a normal
 * browser download. Nothing is uploaded by this app.
 */
export type SaveResult = "shared" | "downloaded" | "cancelled";

const slug = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_-]+/g, "-").slice(0, 40) || "photo";

export const photoFileName = (prefix: string, label: string, n?: number) =>
  `${slug(prefix)}-${n ? `${String(n).padStart(2, "0")}-` : ""}${slug(label)}.jpg`;

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function savePhotoCopies(items: { blob: Blob; name: string }[], title: string): Promise<SaveResult> {
  if (!items.length) return "cancelled";
  const files = items.map((i) => new File([i.blob], i.name, { type: i.blob.type || "image/jpeg" }));
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.share && nav.canShare?.({ files })) {
    try {
      await nav.share({ files, title });
      return "shared";
    } catch (e) {
      if ((e as { name?: string }).name === "AbortError") return "cancelled";
      // NotAllowedError etc.: fall through to downloads.
    }
  }
  for (const [i, f] of files.entries()) {
    download(f, f.name);
    if (i < files.length - 1) await new Promise((r) => setTimeout(r, 250));
  }
  return "downloaded";
}
