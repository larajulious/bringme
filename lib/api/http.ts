import { unstable_rethrow } from "next/navigation";
import { NextResponse } from "next/server";

/** Error with an HTTP status and a stable, non-leaky machine code. */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}

export function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** Wrap a route handler: HttpError -> JSON error, anything else -> opaque 500. */
export async function handle(fn: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await fn();
  } catch (e) {
    unstable_rethrow(e); // let Next's own control-flow errors (dynamic bail-out, redirects) pass through
    if (e instanceof HttpError) return json({ error: e.code }, e.status);
    console.error("Unhandled API error", e);
    return json({ error: "internal_error" }, 500);
  }
}

const MAX_BODY_BYTES = 8 * 1024;

/**
 * Parse a small JSON body. Requiring `application/json` doubles as CSRF
 * protection: cross-site forms cannot send that content type without a
 * CORS preflight, which we never approve.
 */
export async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "json_required");
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, "body_too_large");
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  throw new HttpError(400, "invalid_json");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
