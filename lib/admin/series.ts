/** Daily bucketing for the admin charts (pure, unit-tested). Days are UTC calendar days. */
export type DayPoint = { day: string; values: Record<string, number> };

/** The last `days` UTC dates (YYYY-MM-DD), oldest first, ending today. */
export function lastDays(days: number, now: Date = new Date()): string[] {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: days }, (_, i) => new Date(end - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10));
}

/** Sums `value` per day and `key`. Rows outside the window, with a bad date or an unknown key are ignored. */
export function bucketDaily(
  rows: readonly { at: string | null; key: string; value: number }[],
  days: number,
  keys: readonly string[],
  now: Date = new Date(),
): DayPoint[] {
  const points = lastDays(days, now).map((day) => ({ day, values: Object.fromEntries(keys.map((k) => [k, 0])) as Record<string, number> }));
  const byDay = new Map(points.map((p) => [p.day, p]));
  for (const r of rows) {
    const t = r.at ? Date.parse(r.at) : NaN;
    if (Number.isNaN(t)) continue;
    const p = byDay.get(new Date(t).toISOString().slice(0, 10));
    if (p && r.key in p.values) p.values[r.key] += r.value;
  }
  return points;
}

/** Y-axis ticks: clean steps (1/2/5 × 10^k), at most ~5 intervals, never below `minStep`. */
export function niceTicks(max: number, minStep = 1): number[] {
  const v = Math.max(max, minStep * 4);
  const raw = v / 4;
  const k = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max([1, 2, 5, 10].map((m) => m * k).find((s) => s >= raw) ?? raw, minStep);
  const top = Math.ceil(v / step) * step;
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
}
