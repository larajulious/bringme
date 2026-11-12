/** Checkout currency rules (pure; unit-tested). PHP and USD are priced independently, never converted. */
export const CHECKOUT_CURRENCIES = ["PHP", "USD"] as const;
export type CheckoutCurrency = (typeof CHECKOUT_CURRENCIES)[number];

export function parseCurrency(v: unknown): CheckoutCurrency | null {
  if (typeof v !== "string") return null;
  const c = v.trim().toUpperCase();
  return (CHECKOUT_CURRENCIES as readonly string[]).includes(c) ? (c as CheckoutCurrency) : null;
}

/**
 * Pre-selected currency (the host can always switch). Philippines (edge country header, or a
 * Philippine locale) -> PHP, everyone else -> USD. It is only a default: the host's explicit
 * choice is what the server charges, and Polar's response is verified against it.
 */
export function defaultCurrency(input: { country?: string | null; acceptLanguage?: string | null }): CheckoutCurrency {
  if (input.country?.trim().toUpperCase() === "PH") return "PHP";
  const langs = (input.acceptLanguage ?? "").toLowerCase().split(",").map((l) => l.split(";")[0].trim());
  if (langs.some((l) => l.endsWith("-ph") || l === "fil" || l.startsWith("fil-") || l === "tl" || l.startsWith("tl-"))) return "PHP";
  return "USD";
}

/** "₱99.00" / "$1.99" (fixed locales so server and client render the same). */
export function formatMoney(minor: number, currency: CheckoutCurrency): string {
  return new Intl.NumberFormat(currency === "PHP" ? "en-PH" : "en-US", { style: "currency", currency }).format(minor / 100);
}
