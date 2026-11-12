/**
 * Storage consent. Essential cookies (login, 12 h player session) are always on. "Preferences" covers optional
 * localStorage niceties (homepage boop count, sound setting, hunt view). Off until the visitor opts in;
 * turning it off deletes what was stored.
 */
export const CONSENT_KEY = "bm_cookie_consent"; // "all" | "essential"
const PREF_KEYS = ["bm_snappy_taps", "bm_snappy_muted", "bingosnap:view"];


export function getConsent(): "all" | "essential" | null {
  try {
    const v = window.localStorage.getItem(CONSENT_KEY);
    return v === "all" || v === "essential" ? v : null;
  } catch { return null; }
}

export function preferencesAllowed(): boolean {
  return getConsent() === "all";
}

export function setConsent(value: "all" | "essential") {
  try {
    window.localStorage.setItem(CONSENT_KEY, value);
    if (value === "essential") PREF_KEYS.forEach((k) => window.localStorage.removeItem(k));
  } catch { /* storage blocked: nothing is stored anyway */ }
}

/** Write an optional preference only if the visitor allowed it. */
export function setPreference(key: string, value: string) {
  if (!preferencesAllowed()) return;
  try { window.localStorage.setItem(key, value); } catch { /* not remembered */ }
}
