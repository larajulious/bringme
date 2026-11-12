/**
 * Disposable email blocklist maintenance (supabase/README.md, "Disposable email protection").
 *
 *   npm run disposable:update -- --status              active version, counts, stored versions
 *   npm run disposable:update -- --dry-run             download + validate + show the change, apply nothing
 *   npm run disposable:update                          download, validate, apply (new active version)
 *   npm run disposable:update -- --file list.txt       apply a local file instead of downloading
 *   npm run disposable:update -- --rollback [id]       re-activate a stored version (default: the previous one)
 *   add --allow-shrink to accept a list more than 20% smaller than the active one
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SECRET_KEY (server key; never ship it to a browser).
 * Validation runs here AND again in public.apply_disposable_email_list; any failure leaves the active list
 * untouched. Signups never make network requests: the hook reads the list from the database.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { checkDomainList, parseDomainList } from "../lib/auth/disposable.ts";

const SOURCE = "disposable-email-domains";
const LIST_URL = "https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/disposable_email_blocklist.conf";
const COMMIT_URL = "https://api.github.com/repos/disposable-email-domains/disposable-email-domains/commits/main";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const valueAfter = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null;
};

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY (e.g. node --env-file=.env.local ...).");
  process.exit(2);
}

async function rpc<T>(fn: string, body: object): Promise<T> {
  const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: key!, authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try { message = (JSON.parse(text) as { message?: string }).message ?? text; } catch { /* raw text */ }
    throw new Error(`${fn} failed (HTTP ${res.status}): ${message}`);
  }
  return JSON.parse(text) as T;
}

type Status = {
  active: { version: number; source_ref: string | null; domains: number; applied_at: string } | null;
  live_domains: number;
  allowlist: number;
  providers: string[];
  versions: { version: number; source_ref: string | null; domains: number; applied_at: string; active: boolean }[];
};

async function download(): Promise<{ text: string; ref: string }> {
  const res = await fetch(LIST_URL, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}); the active list was not changed.`);
  const text = await res.text();
  let ref = `sha256:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
  try {
    const c = await fetch(COMMIT_URL, { signal: AbortSignal.timeout(15_000), headers: { accept: "application/vnd.github+json" } });
    if (c.ok) ref = ((await c.json()) as { sha?: string }).sha ?? ref;
  } catch { /* the checksum is enough to identify the list */ }
  return { text, ref };
}

try {
  const status = await rpc<Status>("disposable_email_list_status", {});

  if (flag("--status")) {
    console.log(JSON.stringify(status, null, 2));
    process.exit(0);
  }

  if (flag("--rollback")) {
    const id = valueAfter("--rollback");
    const result = await rpc("rollback_disposable_email_list", { p_version_id: id ? Number(id) : null });
    console.log("Rolled back:", JSON.stringify(result));
    process.exit(0);
  }

  const file = valueAfter("--file");
  const { text, ref } = file
    ? { text: readFileSync(file, "utf8"), ref: `file:${createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16)}` }
    : await download();
  const { domains, invalid } = parseDomainList(text);
  const problems = checkDomainList(domains, {
    currentCount: status.live_domains,
    providers: status.providers,
    allowShrink: flag("--allow-shrink"),
  });
  if (invalid.length) problems.unshift(`${invalid.length} unparseable lines (e.g. ${invalid.slice(0, 3).join(", ")})`);

  console.log(`Source: ${file ?? LIST_URL}\nRef: ${ref}\nDomains: ${domains.length} (active: ${status.live_domains}, version ${status.active?.version ?? "none"})`);
  if (status.active?.source_ref === ref) console.log("Note: this is the same list as the active version.");
  if (problems.length) {
    console.error(`Refusing to apply:\n - ${problems.join("\n - ")}\nThe active list was not changed.`);
    process.exit(1);
  }
  if (flag("--dry-run")) {
    console.log("Dry run: validation passed, nothing applied.");
    process.exit(0);
  }
  const result = await rpc("apply_disposable_email_list", {
    p_domains: domains, p_source: file ? "file" : SOURCE, p_source_ref: ref, p_allow_shrink: flag("--allow-shrink"),
  });
  console.log("Applied:", JSON.stringify(result));
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  console.error("The active list was not changed.");
  process.exit(1);
}
