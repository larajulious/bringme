/** "6 days 4 hours left" / "3 hours 12 minutes left" / "8 minutes left" (pure, unit-tested). */
export function formatRemaining(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "Ended";
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  if (d > 0) return `${plural(d, "day")}${h ? ` ${plural(h, "hour")}` : ""} left`;
  if (h > 0) return `${plural(h, "hour")}${m ? ` ${plural(m, "minute")}` : ""} left`;
  if (m > 0) return `${plural(m, "minute")} left`;
  return "Less than a minute left";
}
