/** Shared copy for search results and social cards (Facebook / X / WhatsApp / LinkedIn previews). */
export const SITE_NAME = "BringMe!";
export const SITE_TITLE = "BringMe! — Office Party & Team Building Photo Game";
export const SITE_DESCRIPTION =
  "The real-time photo scavenger hunt for office parties and team building: everyone races to find and snap the item. Players join by QR code, no app or sign-up.";

/** The share image (app/opengraph-image.png, 1200×630). Pages that set their own `openGraph` must
 *  list it again: Next replaces the parent's openGraph / twitter objects instead of merging them. */
export const SHARE_IMAGE_ALT =
  "BringMe! — the real-time party game. Find it, snap it, win it: everyone races to bring the item, and players join by scanning a QR code.";
export const OG_IMAGES = [{ url: "/opengraph-image.png", width: 1200, height: 630, alt: SHARE_IMAGE_ALT, type: "image/png" }];
export const TWITTER_IMAGES = [{ url: "/twitter-image.png", width: 1200, height: 630, alt: SHARE_IMAGE_ALT }];

/** Page-level metadata that also updates the social card title / description (Next doesn't copy them over). */
export function pageMeta(o: { title: string; description: string; path: string }) {
  const full = `${o.title} · ${SITE_NAME}`;
  return {
    title: o.title,
    description: o.description,
    alternates: { canonical: o.path },
    openGraph: { title: full, description: o.description, url: o.path, siteName: SITE_NAME, type: "website" as const, images: OG_IMAGES },
    twitter: { card: "summary_large_image" as const, title: full, description: o.description, images: TWITTER_IMAGES },
  };
}
