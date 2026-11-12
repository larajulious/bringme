/**
 * Polar webhook signature verification (pure; unit-tested with the Standard Webhooks spec
 * vector). Polar docs: secrets generated on/after 2026-09-08 are Standard Webhooks (pass the
 * `whsec_…` secret as-is: key = base64-decode of the part after `whsec_`); older secrets are
 * "Polar HMAC" (key = the UTF-8 bytes of the FULL `whsec_…` string). Like Polar's SDKs we
 * try both. Signed content = `${webhook-id}.${webhook-timestamp}.${raw body}`, HMAC-SHA256,
 * header `webhook-signature: v1,<base64> [v1,<base64> …]`.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export type SignatureResult = { ok: true } | { ok: false; reason: "missing_headers" | "bad_timestamp" | "stale_timestamp" | "bad_signature" | "no_secret" };

function keys(secret: string): Buffer[] {
  const out: Buffer[] = [];
  const s = secret.trim();
  if (s.startsWith("whsec_")) {
    const b64 = s.slice("whsec_".length);
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
      const k = Buffer.from(b64, "base64");
      if (k.length > 0) out.push(k);                     // Standard Webhooks
    }
  }
  if (s) out.push(Buffer.from(s, "utf8"));                 // Polar HMAC (legacy secrets)
  return out;
}

export function verifyWebhookSignature(input: {
  secret: string | undefined;
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  body: string;
  nowSeconds?: number;
}): SignatureResult {
  if (!input.secret?.trim()) return { ok: false, reason: "no_secret" };
  const { id, timestamp, signature, body } = input;
  if (!id || !timestamp || !signature) return { ok: false, reason: "missing_headers" };
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: "bad_timestamp" };
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > WEBHOOK_TOLERANCE_SECONDS) return { ok: false, reason: "stale_timestamp" };

  const content = `${id}.${timestamp}.${body}`;
  const given = signature.split(" ").map((p) => p.trim()).filter((p) => p.startsWith("v1,")).map((p) => Buffer.from(p.slice(3), "base64"));
  if (given.length === 0) return { ok: false, reason: "bad_signature" };
  for (const key of keys(input.secret)) {
    const expected = createHmac("sha256", key).update(content).digest();
    for (const g of given) {
      if (g.length === expected.length && timingSafeEqual(g, expected)) return { ok: true };
    }
  }
  return { ok: false, reason: "bad_signature" };
}
