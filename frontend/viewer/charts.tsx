// Small SVG charts for the measurement panel (role B, task B-04). No chart library: points with
// error bars, optional straight lines, axes with units. Server-renderable (no hooks).

import type { ReactNode } from "react";
import styles from "./Viewer.module.css";

/**
 * About `count` evenly spaced round numbers covering [min, max] (steps of 1, 2 or 5 x 10^k).
 * Returns [min] when the range is empty.
 */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (max < min) [min, max] = [max, min];
  if (max === min) return [min];
  const raw = (max - min) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const first = Math.ceil(min / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = first; v <= max + step * 1e-9; v += step) ticks.push(Number(v.toPrecision(12)) + 0);
  return ticks;
}

/** [lo, hi] of values and their error bars, padded by `pad` of the range (or ±1 for a single value). */
export function extent(values: readonly { v: number; err?: number }[], pad = 0.08): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const { v, err } of values) {
    if (!Number.isFinite(v)) continue;
    const e = err !== undefined && Number.isFinite(err) ? Math.abs(err) : 0;
    lo = Math.min(lo, v - e);
    hi = Math.max(hi, v + e);
  }
  if (!Number.isFinite(lo)) return [0, 1];
  if (hi === lo) return [lo - 1, hi + 1];
  const p = (hi - lo) * pad;
  return [lo - p, hi + p];
}

export interface ChartPoint {
  x: number;
  y: number;
  /** One-sigma error of y; no bar if missing or 0. */
  err?: number;
  /** Drawn faint (e.g. a point the pipeline flagged). */
  faded?: boolean;
  /** Hover text. */
  title?: string;
  /** Counts for the y range when yRange is "robust". Default: not faded. */
  inRange?: boolean;
}

export type MarkerShape = "circle" | "square" | "triangle" | "diamond" | "triangleDown" | "cross";

/** One marker shape per detector, so detectors stay apart in a full spectrum. */
export const BAND_SHAPES: readonly MarkerShape[] = ["circle", "square", "triangle", "diamond", "triangleDown", "cross"];

export interface ChartSeries {
  label: string;
  color: string;
  points: ChartPoint[];
  /** Marker shape; default circle. */
  shape?: MarkerShape;
}

export interface ChartLine {
  label: string;
  color: string;
  dashed?: boolean;
  /** y as a function of x; drawn as a straight segment across the x range. */
  at: (x: number) => number;
}

export interface ChartProps {
  title: string;
  xLabel: string;
  yLabel: string;
  series: ChartSeries[];
  lines?: ChartLine[];
  xFormat?: (v: number) => string;
  yFormat?: (v: number) => string;
  /** Force the y range, e.g. to include 0. */
  yInclude?: number[];
  /** Vertical dashed lines at these x values (e.g. detector seams). */
  vlines?: number[];
  /** "all" (default): the y axis covers every point. "robust": the 1st-99th percentile of the points
   *  that count (ChartPoint.inRange, default: not faded), so a few rejected points far away cannot
   *  flatten the rest (B-11); points outside are drawn as small arrows on the edge. */
  yRange?: "all" | "robust";
  /** Force the x range to include these values (e.g. the full 0.75-5 µm of SPHEREx). */
  xInclude?: number[];
  /** No automatic colour key in the caption (the caller draws its own). */
  hideKey?: boolean;
  children?: ReactNode;
}

const W = 320;
const H = 190;
const M = { left: 46, right: 10, top: 10, bottom: 34 };

const defaultFormat = (v: number) => {
  const a = Math.abs(v);
  return a !== 0 && (a < 0.01 || a >= 1e5) ? v.toExponential(1) : String(Number(v.toPrecision(4)));
};

/** Scatter chart with error bars and lines, in a fixed 320 x 190 viewBox that scales to its box. */
/** A marker of the given shape centred on (x, y), about r in size. */
function Marker({ shape = "circle", x, y, r }: { shape?: MarkerShape; x: number; y: number; r: number }) {
  switch (shape) {
    case "square":
      return <rect x={x - r * 0.85} y={y - r * 0.85} width={r * 1.7} height={r * 1.7} />;
    case "triangle":
      return <polygon points={`${x},${y - r * 1.15} ${x - r},${y + r * 0.7} ${x + r},${y + r * 0.7}`} />;
    case "triangleDown":
      return <polygon points={`${x},${y + r * 1.15} ${x - r},${y - r * 0.7} ${x + r},${y - r * 0.7}`} />;
    case "diamond":
      return <polygon points={`${x},${y - r * 1.2} ${x + r},${y} ${x},${y + r * 1.2} ${x - r},${y}`} />;
    case "cross":
      return (
        <path d={`M${x - r},${y - r}L${x + r},${y + r}M${x - r},${y + r}L${x + r},${y - r}`} strokeWidth={1.4} fill="none" />
      );
    default:
      return <circle cx={x} cy={y} r={r} />;
  }
}

/** p-th percentile (0..100) of finite values, linear between ranks; NaN for none. */
function pct(values: number[], p: number): number {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length === 0) return NaN;
  const pos = (p / 100) * (v.length - 1);
  const i = Math.floor(pos);
  return v[i] + (v[Math.min(i + 1, v.length - 1)] - v[i]) * (pos - i);
}

/**
 * y range from the points that count (inRange, default: not faded): 1st percentile of y - err to
 * 99th percentile of y + err, plus `include`, padded by `pad`. Falls back to every point when none
 * counts. Exported for tests.
 */
export function robustYRange(points: readonly ChartPoint[], include: readonly number[] = [], pad = 0.08): [number, number] {
  const counted = points.filter((p) => p.inRange ?? !p.faded);
  const use = counted.length ? counted : points;
  const e = (p: ChartPoint) => (p.err !== undefined && Number.isFinite(p.err) ? Math.abs(p.err) : 0);
  const lo = pct(use.map((p) => p.y - e(p)), 1);
  const hi = pct(use.map((p) => p.y + e(p)), 99);
  return extent([{ v: lo }, { v: hi }, ...include.map((v) => ({ v }))], pad);
}

export function Chart({
  title,
  xLabel,
  yLabel,
  series,
  lines = [],
  xFormat,
  yFormat,
  yInclude = [],
  vlines = [],
  hideKey = false,
  yRange = "all",
  xInclude = [],
  children,
}: ChartProps) {
  const all = series.flatMap((s) => s.points);
  const [x0, x1] = extent([...all.map((p) => ({ v: p.x })), ...xInclude.map((v) => ({ v }))], 0.05);
  const [y0, y1] =
    yRange === "robust"
      ? robustYRange(all, yInclude)
      : extent([...all.map((p) => ({ v: p.y, err: p.err })), ...yInclude.map((v) => ({ v }))]);
  const pw = W - M.left - M.right;
  const ph = H - M.top - M.bottom;
  const sx = (x: number) => M.left + ((x - x0) / (x1 - x0)) * pw;
  const sy = (y: number) => M.top + (1 - (y - y0) / (y1 - y0)) * ph;
  const fx = xFormat ?? defaultFormat;
  const fy = yFormat ?? defaultFormat;
  const xt = niceTicks(x0, x1, 4);
  const yt = niceTicks(y0, y1, 4);

  return (
    <figure className={styles.chart}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}. ${yLabel} against ${xLabel}.`}>
        <rect x={M.left} y={M.top} width={pw} height={ph} className={styles.chartFrame} />
        {yt.map((v) => (
          <g key={`y${v}`}>
            <line x1={M.left} x2={M.left + pw} y1={sy(v)} y2={sy(v)} className={styles.chartGrid} />
            <text x={M.left - 4} y={sy(v) + 3} textAnchor="end" className={styles.chartTick}>
              {fy(v)}
            </text>
          </g>
        ))}
        {xt.map((v) => (
          <g key={`x${v}`}>
            <line x1={sx(v)} x2={sx(v)} y1={M.top + ph} y2={M.top + ph + 3} className={styles.chartAxis} />
            <text x={sx(v)} y={M.top + ph + 13} textAnchor="middle" className={styles.chartTick}>
              {fx(v)}
            </text>
          </g>
        ))}
        <text x={M.left + pw / 2} y={H - 4} textAnchor="middle" className={styles.chartLabel}>
          {xLabel}
        </text>
        <text
          x={11}
          y={M.top + ph / 2}
          textAnchor="middle"
          transform={`rotate(-90 11 ${M.top + ph / 2})`}
          className={styles.chartLabel}
        >
          {yLabel}
        </text>
        <svg x={M.left} y={M.top} width={pw} height={ph} viewBox={`${M.left} ${M.top} ${pw} ${ph}`} overflow="hidden">
          {vlines.map((v) => (
            <line
              key={`v${v}`}
              data-vline=""
              x1={sx(v)}
              x2={sx(v)}
              y1={M.top}
              y2={M.top + ph}
              className={styles.chartAxis}
              strokeDasharray="3 3"
            />
          ))}
          {lines.map((l) => (
            <line
              key={l.label}
              x1={sx(x0)}
              x2={sx(x1)}
              y1={sy(l.at(x0))}
              y2={sy(l.at(x1))}
              stroke={l.color}
              strokeWidth={1.5}
              strokeDasharray={l.dashed ? "5 4" : undefined}
            />
          ))}
        </svg>
        {series.map((s) =>
          s.points.map((p, i) => {
            const clamp = (v: number) => Math.min(M.top + ph, Math.max(M.top, v));
            const above = p.y > y1;
            const below = p.y < y0;
            if (above || below) {
              // Off the scale: a small faint arrow on the edge, pointing to where the point is.
              const ex = sx(p.x);
              const ey = above ? M.top + 1 : M.top + ph - 1;
              const d = above ? -1 : 1;
              return (
                <g key={`${s.label}-${i}`} fill={s.color} opacity={0.35} data-offscale={above ? "above" : "below"}>
                  {p.title && <title>{`${p.title} (off the scale: ${fy(p.y)})`}</title>}
                  <polygon points={`${ex},${ey + d * 2} ${ex - 2.2},${ey - d * 2} ${ex + 2.2},${ey - d * 2}`} />
                </g>
              );
            }
            return (
              <g key={`${s.label}-${i}`} stroke={s.color} fill={s.color} opacity={p.faded ? 0.3 : undefined} data-faded={p.faded ? "" : undefined}>
                {p.title && <title>{p.title}</title>}
                {p.err !== undefined && p.err > 0 && (
                  <line
                    data-errbar=""
                    x1={sx(p.x)}
                    x2={sx(p.x)}
                    y1={clamp(sy(p.y - p.err))}
                    y2={clamp(sy(p.y + p.err))}
                    strokeWidth={1.2}
                  />
                )}
                <Marker shape={s.shape} x={sx(p.x)} y={sy(p.y)} r={2.6} />
              </g>
            );
          }),
        )}
      </svg>
      <figcaption>
        <strong>{title}</strong>
        {!hideKey && [...series, ...lines].length > 1 && (
          <span className={styles.chartKey}>
            {series.map((s) => (
              <span key={s.label}>
                <i style={{ background: s.color }} /> {s.label}
              </span>
            ))}
            {lines.map((l) => (
              <span key={l.label}>
                <i className={l.dashed ? styles.dashKey : undefined} style={{ background: l.color }} /> {l.label}
              </span>
            ))}
          </span>
        )}
        {children}
      </figcaption>
    </figure>
  );
}
