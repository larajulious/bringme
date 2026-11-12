/**
 * Public site URL used for join links and QR codes. Comes from configuration,
 * never from request headers (a spoofed Host header must not change the QR).
 */
export type SiteUrl = { url: string; configured: boolean };

/** The public production address, used by production builds that have no NEXT_PUBLIC_SITE_URL. */
export const PRODUCTION_SITE_URL = "https://bringme.fun";

export function resolveSiteUrl(env: Record<string, string | undefined>): SiteUrl {
  const explicit = env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) {
    try {
      const u = new URL(explicit);
      if (u.protocol === "https:" || u.protocol === "http:") {
        return { url: u.origin, configured: true };
      }
    } catch {
      /* fall through */
    }
  }
  const vercel = env.VERCEL_PROJECT_PRODUCTION_URL || env.VERCEL_URL;
  if (vercel) return { url: `https://${vercel}`, configured: false };
  // A production build must never hand out (or redirect to) localhost, e.g. behind a reverse proxy whose
  // internal address is http://localhost:3000. Treated as configured so redirects use it, not the request origin.
  if (env.NODE_ENV === "production") return { url: PRODUCTION_SITE_URL, configured: true };
  return { url: "http://localhost:3000", configured: false };
}

export const getSiteUrl = () => resolveSiteUrl(process.env);

/** Room codes are 6 chars from [A-Z0-9]. */
export const ROOM_CODE = /^[A-Z0-9]{6}$/;

export function joinUrl(siteUrl: string, code: string): string {
  if (!ROOM_CODE.test(code)) throw new Error("invalid room code");
  return `${siteUrl}/join/${code}`;
}

/**
 * Base for server-side redirects. Behind a proxy `request.url` can carry the internal
 * address (http://localhost:3000), so prefer the configured public URL; fall back to the
 * request origin (local dev, previews) when none is configured.
 */
export function redirectBase(requestOrigin: string, env: Record<string, string | undefined> = process.env): string {
  const site = resolveSiteUrl(env);
  return site.configured ? site.url : requestOrigin;
}
