/** Max taps one request may carry (matches add_snappy_taps' bound). The browser sends early if it reaches this. */
export const MAX_BATCH = 500;
/** The browser sends its taps once the visitor has stopped tapping for this long. */
export const IDLE_FLUSH_MS = 2_000;
