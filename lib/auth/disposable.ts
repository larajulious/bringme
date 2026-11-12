/**
 * Disposable (temporary) email protection: pure helpers shared by the signup pre-check route,
 * the blocklist update script and tests. The authoritative check runs in the database
 * (public.is_disposable_email + the Supabase "Before User Created" hook); see
 * supabase/migrations/20261112000029_disposable_email_guard.sql. Nothing here ships the list to the browser.
 */

/** Shown below the email field. Must match the message in public.hook_before_user_created. */
export const DISPOSABLE_EMAIL_MESSAGE =
  "Temporary email addresses aren't supported. Please use a permanent email address to continue.";

/** Domains every genuine list contains. A download missing one is treated as corrupt (mirrored in SQL). */
export const SENTINEL_DOMAINS = ["mailinator.com", "guerrillamail.com", "yopmail.com", "10minutemail.com"] as const;

/** Refuse lists smaller than this unless overridden (the upstream list has ~10,000 entries). */
export const MIN_LIST_SIZE = 1000;
/** Refuse an update that removes more than 20% of the active list unless explicitly allowed. */
export const MAX_SHRINK_RATIO = 0.8;

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
/** Hostname with at least two labels (a bare TLD such as "com" is never a valid entry). Mirrored in SQL. */
const DOMAIN_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);

export function normalizeDomain(raw: string): string {
  return raw.trim().toLowerCase().replace(/\.+$/, "");
}

export function isDomainLike(domain: string): boolean {
  return domain.length <= 253 && DOMAIN_RE.test(domain);
}

/** The part after the LAST "@", normalised; null when there is none. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const d = normalizeDomain(email.slice(at + 1));
  return d || null;
}

/**
 * The domain and each parent with at least two labels, most specific first:
 *   "a.b.mailinator.com" -> ["a.b.mailinator.com", "b.mailinator.com", "mailinator.com"].
 * Matching is exact per candidate (never substring): "bringmailinator.com" never matches "mailinator.com".
 * The upstream list stores registrable domains, so a subdomain of a listed domain is the same service.
 */
export function domainCandidates(domain: string): string[] {
  const labels = normalizeDomain(domain).split(".").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < labels.length - 1; i++) out.push(labels.slice(i).join("."));
  return out;
}

/**
 * Same decision as public.is_disposable_email_domain: walk from most to least specific;
 * at each level an allowlisted domain wins over a blocked one, and the first hit decides.
 */
export function isDisposableDomain(domain: string, blocked: ReadonlySet<string>, allowed: ReadonlySet<string> = new Set()): boolean {
  for (const c of domainCandidates(domain)) {
    if (allowed.has(c)) return false;
    if (blocked.has(c)) return true;
  }
  return false;
}

/** Parses a blocklist file (one domain per line, "#" comments, blank lines ignored). */
export function parseDomainList(text: string): { domains: string[]; invalid: string[] } {
  const seen = new Set<string>();
  const invalid: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const d = normalizeDomain(line.replace(/#.*$/, ""));
    if (!d) continue;
    if (isDomainLike(d)) seen.add(d);
    else invalid.push(d);
  }
  return { domains: [...seen].sort(), invalid };
}

/**
 * Pre-flight checks before an update is sent to the database (the database repeats them).
 * Returns human-readable problems; an empty array means the list may be applied.
 */
export function checkDomainList(
  domains: readonly string[],
  opts: { currentCount?: number; providers?: readonly string[]; minCount?: number; allowShrink?: boolean } = {},
): string[] {
  const problems: string[] = [];
  const set = new Set(domains);
  const min = opts.minCount ?? MIN_LIST_SIZE;
  const bad = domains.filter((d) => !isDomainLike(d));
  if (bad.length) problems.push(`${bad.length} invalid entries (e.g. ${bad.slice(0, 3).join(", ")})`);
  if (set.size < min) problems.push(`only ${set.size} domains (minimum ${min})`);
  const missing = SENTINEL_DOMAINS.filter((s) => !set.has(s));
  if (missing.length) problems.push(`missing expected domains: ${missing.join(", ")}`);
  const providers = (opts.providers ?? []).filter((p) => set.has(p));
  if (providers.length) problems.push(`contains protected email providers: ${providers.join(", ")}`);
  const current = opts.currentCount ?? 0;
  if (!opts.allowShrink && current > 0 && set.size < current * MAX_SHRINK_RATIO) {
    problems.push(`would shrink the list from ${current} to ${set.size} domains (pass --allow-shrink if intended)`);
  }
  return problems;
}
