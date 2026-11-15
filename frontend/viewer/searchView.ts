// Display helpers for the "Motion search" velocity search (role B, tasks B-05, B-06). The searches
// are role P's: velocityGrid / runGrid (search/grid.ts, search/run.ts) and falseAlarm /
// motionVerdict (search/significance.ts). This file turns their results into a heatmap and into the
// wording of search/README.md ("How to report a search result"). No new statistics here.
//
// Two separate questions (search/README.md):
//   1. Is anything there?  best grid score >= DETECT_SNR (5). Blank sky reaches 2.1-4.1 on the
//      WISE 0855 cube (8 blank regions, PR #46), because the best of ~120 motions is a maximum.
//   2. Does it move?       only the shuffle test (falseAlarm) answers this: p < 1% and the best
//      motion beats the zero vector -> "detected"; otherwise at most "consistent".
// Agreeing with a catalogue is a check of the search, never evidence that it measured the motion.

import type { GridResult, VectorScore } from "../search/grid";
import { DETECT_SNR, MOTION_ALPHA, motionVerdict, type FalseAlarmResult, type MotionVerdictKind } from "../search/significance";
import { JULIAN_YEAR_DAYS } from "../search/stack";

/** Best score below this: "nothing found" (role P's DETECT_SNR, search/significance.ts). */
export const SEARCH_SNR_MIN = DETECT_SNR;

/** Shuffles for "How sure is this?": the fewest that can reach p < MOTION_ALPHA = 1% (p >= 1/(n+1)). */
export const SHUFFLES = 100;

/** A best motion this close to the catalogue (arcsec/yr) passes the search check (P-02 acceptance). */
export const CATALOGUE_TOLERANCE = 2;

/** Score of the grid cell at (0, 0). Role P's axes always contain 0 (grid.ts axis()). */
export function zeroScore(r: Pick<GridResult, "pmRaAxis" | "pmDecAxis" | "score">): number {
  const i = r.pmRaAxis.indexOf(0);
  const j = r.pmDecAxis.indexOf(0);
  if (i < 0 || j < 0) return Number.NaN;
  return r.score[j * r.pmRaAxis.length + i];
}

export interface CatalogueCheck {
  /** Distance of the best motion from the catalogue motion, arcsec/yr. */
  distance: number;
  /** Within CATALOGUE_TOLERANCE. */
  passes: boolean;
}

export function catalogueCheck(best: Pick<VectorScore, "pmRa" | "pmDec">, catalogue?: { pmRa: number; pmDec: number }): CatalogueCheck | null {
  if (!catalogue) return null;
  const distance = Math.hypot(best.pmRa - catalogue.pmRa, best.pmDec - catalogue.pmDec);
  return { distance, passes: distance <= CATALOGUE_TOLERANCE };
}

export interface GridVerdict {
  /** "none": nothing above blank sky; "source": something is there (whether it moves is open). */
  kind: "none" | "source";
  /** Best grid score, the statistic DETECT_SNR applies to (as in motionVerdict). */
  bestSnr: number;
  /** Score of a source that does not move. */
  zeroSnr: number;
  catalogue: CatalogueCheck | null;
}

/** What one search (no shuffles) can say: question 1 only. */
export function gridVerdict(r: GridResult, catalogue?: { pmRa: number; pmDec: number }): GridVerdict {
  const bestSnr = r.gridBest.snr;
  return {
    kind: bestSnr >= SEARCH_SNR_MIN ? "source" : "none",
    bestSnr,
    zeroSnr: zeroScore(r),
    catalogue: catalogueCheck(r.best, catalogue),
  };
}

export interface ShuffleSummary {
  kind: MotionVerdictKind;
  n: number;
  nExceed: number;
  p: number;
  pMin: number;
  /** Best moving score, real time order. */
  movingSnr: number;
  zeroSnr: number;
  /** Highest score among the shuffled orders. */
  bestShuffle: number;
}

/** P-03's verdict on a falseAlarm result, plus the numbers the panel shows. */
export function summarizeShuffles(fa: FalseAlarmResult): ShuffleSummary {
  const v = motionVerdict(fa);
  return {
    kind: v.kind,
    n: fa.n,
    nExceed: fa.nExceed,
    p: fa.p,
    pMin: fa.pMin,
    movingSnr: fa.moving.snr,
    zeroSnr: fa.zero.snr,
    bestShuffle: fa.nullScores.length ? Math.max(...fa.nullScores) : Number.NaN,
  };
}

/**
 * The shuffle result in words: "None of the 100 random time orders scored this high (p < 0.01)."
 * or "3 of the 100 random time orders scored at least this high (p = 0.04)."
 */
export function shuffleSentence(s: Pick<ShuffleSummary, "n" | "nExceed" | "p">): string {
  const orders = `random time order${s.n === 1 ? "" : "s"}`;
  if (s.nExceed === 0) {
    const bound = s.p < MOTION_ALPHA ? `p < ${MOTION_ALPHA}` : `p = ${s.p.toFixed(2)}`;
    return `None of the ${s.n} ${orders} scored this high (${bound}).`;
  }
  return `${s.nExceed} of the ${s.n} ${orders} scored at least this high (p = ${s.p.toFixed(2)}).`;
}

/** Number of stacks velocityGrid will compute with its defaults (grid plus one refit), for the wait message. */
export function expectedStacks(frames: readonly { mjd: number }[], pixscale: number, pmMax = 15): number {
  if (frames.length < 2) return 0;
  const mjds = frames.map((f) => f.mjd);
  const years = (Math.max(...mjds) - Math.min(...mjds)) / JULIAN_YEAR_DAYS;
  if (!(years > 0)) return 0;
  const step = pixscale / years;
  const n = 2 * Math.floor(pmMax / step + 1e-9) + 1; // same as grid.ts axis()
  return n * n + 1;
}

// Viridis colour map (perceptually uniform, readable for colour-blind viewers), five stops from
// matplotlib's definition: https://bids.github.io/colormap/
const VIRIDIS: readonly [number, number, number][] = [
  [68, 1, 84],
  [59, 82, 139],
  [33, 145, 140],
  [94, 201, 98],
  [253, 231, 37],
];

/** Viridis colour for t in 0..1 (clipped), linear between the five stops. */
export function viridis(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * (VIRIDIS.length - 1);
  const i = Math.min(VIRIDIS.length - 2, Math.floor(x));
  const f = x - i;
  const a = VIRIDIS[i];
  const b = VIRIDIS[i + 1];
  return [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * f)) as [number, number, number];
}

/**
 * RGBA bytes for the score heatmap, drawn with +pmDec (north) up and +pmRa to the right:
 * output row 0 is the LAST row of `score` (its row 0 is the most negative pmDec, grid.ts).
 * Colour runs from the lowest to the highest finite score; NaN cells are dark grey.
 */
export function renderHeatmap(score: Float32Array, nx: number, ny: number): { rgba: Uint8ClampedArray; lo: number; hi: number } {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of score) {
    if (Number.isFinite(v)) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  const rgba = new Uint8ClampedArray(nx * ny * 4);
  for (let row = 0; row < ny; row++) {
    const j = ny - 1 - row;
    for (let i = 0; i < nx; i++) {
      const v = score[j * nx + i];
      const o = (row * nx + i) * 4;
      const c = Number.isFinite(v) ? viridis(hi > lo ? (v - lo) / (hi - lo) : 1) : [40, 40, 40];
      rgba[o] = c[0];
      rgba[o + 1] = c[1];
      rgba[o + 2] = c[2];
      rgba[o + 3] = 255;
    }
  }
  return { rgba, lo, hi };
}

/**
 * Map between motion (arcsec/yr) and heatmap position in cell units (0..nx, 0..ny, y down).
 * Cell i covers pmRaAxis[i] ± step/2.
 */
export function vectorToCell(r: Pick<GridResult, "pmRaAxis" | "pmDecAxis" | "step">, pmRa: number, pmDec: number) {
  const ny = r.pmDecAxis.length;
  return {
    x: (pmRa - r.pmRaAxis[0]) / r.step + 0.5,
    y: ny - ((pmDec - r.pmDecAxis[0]) / r.step + 0.5),
  };
}

export function cellToVector(r: Pick<GridResult, "pmRaAxis" | "pmDecAxis" | "step">, x: number, y: number) {
  const ny = r.pmDecAxis.length;
  return {
    pmRa: r.pmRaAxis[0] + (x - 0.5) * r.step,
    pmDec: r.pmDecAxis[0] + (ny - y - 0.5) * r.step,
  };
}

/**
 * Which stacking path the search took (A-13, issue #79), in one line for the visitor. role P's
 * velocityGrid sets `normalised` (bright target: every frame divided by the target's summed flux
 * first, frames without the target left out) and `framesUsed`; older results have neither, and
 * then nothing is said.
 */
export function searchPathLine(r: { normalised?: boolean; framesUsed?: number }, nFrames: number): string {
  if (r.normalised === undefined) return "";
  if (r.normalised) {
    const used = r.framesUsed ?? nFrames;
    return `Bright target: ${used} of ${nFrames} images put on a common brightness before stacking, so its brightness changes between images (different wavelengths) do not swamp the motion.`;
  }
  return "Faint target: images stacked as they are.";
}
