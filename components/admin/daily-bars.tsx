"use client";

import { useState, type KeyboardEvent, type PointerEvent } from "react";

import { niceTicks, type DayPoint } from "@/lib/admin/series";
import { formatMoney } from "@/lib/billing/currency";

export type ChartSeries = { key: string; label: string; color: string };

const W = 640, H = 220, L = 44, R = 8, T = 12, B = 26;
const PLOT_W = W - L - R, PLOT_H = H - T - B;
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const shortDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const longDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

/** Rect with a 4px rounded top (data end) and a square baseline. */
function topRounded(x: number, y: number, w: number, h: number) {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}a${r},${r} 0 0 1 ${r},${-r}H${x + w - r}a${r},${r} 0 0 1 ${r},${r}V${y + h}Z`;
}

/**
 * Daily columns (one or more stacked series) as inline SVG: hairline grid, 24px max columns, 4px rounded
 * data end, 2px surface gap between stacked segments, hover/keyboard tooltip, legend for 2+ series and a
 * table view. Pass `currency` when values are minor units of PHP/USD. No animation, so nothing to reduce.
 */
export function DailyBars({ points, series, label, currency }: {
  points: DayPoint[]; series: ChartSeries[]; label: string; currency?: "PHP" | "USD";
}) {
  const [hover, setHover] = useState<number | null>(null);
  const n = points.length;
  const totals = points.map((p) => series.reduce((a, s) => a + (p.values[s.key] ?? 0), 0));
  const grand = totals.reduce((a, b) => a + b, 0);
  const ticks = niceTicks(Math.max(0, ...totals), currency ? 100 : 1);
  const top = ticks[ticks.length - 1];
  const slot = PLOT_W / n;
  const bw = Math.min(24, slot * 0.7);
  const y = (v: number) => T + PLOT_H - (v / top) * PLOT_H;
  const fmt = (v: number) => (currency ? formatMoney(v, currency) : v.toLocaleString("en-US"));
  const tick = (v: number) => (currency ? `${currency === "PHP" ? "₱" : "$"}${compact.format(v / 100)}` : compact.format(v));

  const at = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const i = Math.floor(((e.clientX - box.left) / box.width) * W - L) / slot;
    setHover(i >= 0 && i < n ? Math.floor(i) : null);
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? n) - 1));
    else if (e.key === "ArrowRight") setHover((h) => Math.min(n - 1, (h ?? -1) + 1));
    else if (e.key === "Escape") setHover(null);
  };

  if (grand === 0) {
    return <p className="grid h-40 place-items-center rounded-2xl bg-secondary/60 text-sm text-muted-foreground">Nothing in the last {n} days yet.</p>;
  }

  const hp = hover === null ? null : points[hover];
  const pct = hover === null ? 0 : Math.min(85, Math.max(15, ((L + (hover + 0.5) * slot) / W) * 100));

  return (
    <figure className="m-0">
      {series.length > 1 ? (
        <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label="Legend">
          {series.map((s) => (
            <li key={s.key} className="flex items-center gap-2 text-muted-foreground">
              <span aria-hidden="true" className="size-2.5 rounded-full" style={{ background: s.color }} />{s.label}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full touch-pan-y" role="img" tabIndex={0}
          aria-label={`${label}: ${fmt(grand)} in the last ${n} days. Use arrow keys to read each day.`}
          onPointerMove={at} onPointerDown={at} onPointerLeave={() => setHover(null)} onKeyDown={key} onBlur={() => setHover(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="hsl(var(--border))" strokeWidth={1} />
              <text x={L - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill="hsl(var(--muted-foreground))">{tick(t)}</text>
            </g>
          ))}
          {points.map((p, i) => ((n - 1 - i) % 7 === 0 ? (
            <text key={p.day} x={L + (i + 0.5) * slot} y={H - 6} textAnchor="middle" fontSize={11} fill="hsl(var(--muted-foreground))">{shortDay(p.day)}</text>
          ) : null))}

          {hover !== null ? <rect x={L + hover * slot} y={T} width={slot} height={PLOT_H} fill="hsl(var(--muted))" /> : null}

          {points.map((p, i) => {
            const x = L + i * slot + (slot - bw) / 2;
            let cum = 0;
            const segs = series.filter((s) => (p.values[s.key] ?? 0) > 0);
            return segs.map((s, j) => {
              const v = p.values[s.key];
              const yTop = y(cum + v), yBot = y(cum);
              cum += v;
              const isTop = j === segs.length - 1;
              const h = Math.max(1, yBot - yTop - (j > 0 ? 2 : 0)); // 2px surface gap above the segment below
              return isTop
                ? <path key={`${p.day}-${s.key}`} d={topRounded(x, yTop, bw, h)} fill={s.color} />
                : <rect key={`${p.day}-${s.key}`} x={x} y={yTop} width={bw} height={h} fill={s.color} />;
            });
          })}
        </svg>

        {hp ? (
          <div role="status" className="pointer-events-none absolute top-0 z-10 w-max min-w-32 -translate-x-1/2 rounded-xl border bg-card px-3 py-2 text-sm shadow-card" style={{ left: `${pct}%` }}>
            <p className="font-semibold text-foreground">{longDay(hp.day)}</p>
            {series.map((s) => (
              <p key={s.key} className="flex items-center justify-between gap-4 text-muted-foreground">
                <span className="flex items-center gap-2"><span aria-hidden="true" className="size-2.5 rounded-full" style={{ background: s.color }} />{s.label}</span>
                <span className="font-semibold tabular-nums text-foreground">{fmt(hp.values[s.key] ?? 0)}</span>
              </p>
            ))}
          </div>
        ) : null}
      </div>

      <details className="mt-2 text-sm">
        <summary className="w-fit cursor-pointer font-semibold text-primary underline-offset-4 hover:underline">View as table</summary>
        <div className="mt-2 max-h-56 overflow-auto rounded-xl border">
          <table className="w-full text-left">
            <caption className="sr-only">{label}, by day (UTC)</caption>
            <thead className="sticky top-0 bg-secondary text-secondary-foreground">
              <tr><th scope="col" className="px-3 py-2">Day</th>{series.map((s) => <th key={s.key} scope="col" className="px-3 py-2">{s.label}</th>)}</tr>
            </thead>
            <tbody className="divide-y">
              {[...points].reverse().map((p) => (
                <tr key={p.day}><th scope="row" className="px-3 py-1.5 font-normal">{longDay(p.day)}</th>{series.map((s) => <td key={s.key} className="px-3 py-1.5 tabular-nums">{fmt(p.values[s.key] ?? 0)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <figcaption className="mt-1 text-xs text-muted-foreground">Days are UTC.</figcaption>
    </figure>
  );
}
