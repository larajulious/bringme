/** TV link tokens (migration 20261113000003): 12 symbols, no look-alike characters. Same rule as the database. */
export const SCREEN_TOKEN = /^[23456789abcdefghjkmnpqrstuvwxyz]{12}$/;

/** Accepts what a person may type on a TV remote: any case, spaces or dashes between groups. */
export function normalizeScreenToken(raw: string): string | null {
  const t = raw.toLowerCase().replace(/[\s-]/g, "");
  return SCREEN_TOKEN.test(t) ? t : null;
}

/** "abcd-efgh-jkmn": easier to read out and type. */
export const formatScreenToken = (t: string) => t.match(/.{1,4}/g)?.join("-") ?? t;

export const screenPath = (token: string) => `/tv/${formatScreenToken(token)}`;
