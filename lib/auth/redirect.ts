/**
 * Only same-site, absolute-path redirects are allowed (blocks open redirects
 * such as `//evil.com`, `/\evil.com` or `https://evil.com`).
 */
export function safeNext(next: string | null | undefined, fallback = "/dashboard"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return fallback;
  if (/[\u0000-\u001f]/.test(next)) return fallback;
  return next;
}
