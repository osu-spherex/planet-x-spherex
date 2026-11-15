// How much to trust a velocity search (role P, task P-03).
//
// A search answers two different questions, and each needs its own check.
//
// 1. Is anything there?  The best score is the maximum over ~120 vectors x ~50 pixels, so blank
//    sky already reaches SNR 1.5-4.1 (grid.ts, look-elsewhere effect). A source has to beat what
//    blank sky gives: DETECT_SNR = 5, from the blank-sky controls of P-02 (real control cube: #21).
//
// 2. Does it move?  A source that does not move also stacks well, and a slow mover is stacked
//    almost as well with no shift at all (WISE 0855: zero vector 18.7, best 21.0). Only the time
//    order of the frames carries motion. So we shuffle the MJDs among the frames and search again:
//    the images, their noise and wavelengths, and the set of shifts per vector all stay the same;
//    only the link between each frame and its time is broken. If the real order scores higher
//    than (almost) every shuffle, the motion is unlikely to be luck. This is a Monte Carlo permutation test.
//
// Statistic: the best grid score over all vectors EXCEPT (0, 0). The zero vector shifts nothing,
// so its score is identical for every order and says nothing about motion. Leaving it in would
// make every shuffle score at least the zero score, and whenever the real order's best is the
// zero vector p would be exactly 1. It is reported separately instead (`zero`) and used in the
// verdict: motion counts as detected only if the best moving vector also beats standing still.
//
// p = (1 + number of shuffles scoring >= the real order) / (n + 1). The +1 counts the real order
// as one of the possible orders, so p is never 0 and the smallest possible p is 1 / (n + 1):
// Phipson & Smyth 2010, "Permutation P-values Should Never Be Zero",
// https://doi.org/10.2202/1544-6115.1585
//
// Why "best motion minus zero score" alone is not a motion test: every shifted stack is
// interpolated (bilinear), which averages neighbouring pixels and lowers the noise; the zero vector
// is never interpolated. On independent pixel noise that alone lifts a non-moving source's best
// "moving" score ~35% above its zero score (synthetic, 11/14). The real cubes are oversampled
// (3″ grid, 6.16″ native pixels; neighbours correlate r = 0.72 on WISE 0855 D6), so there the
// effect is ~3% (stack sigma 0.00802 at zero vs 0.00775 at the catalogue vector). Shuffles get
// exactly the same interpolation, so p is immune to it.
//
// Bright targets (A-13): when single frames see the target, every search (the real order and each
// shuffle) first divides each frame by the target's brightness in it (stack.ts brightnessScale).
// That brightness is measured from the frame's pixels alone, around the search centre: it does not
// use the frame's time or the motion tried, so it travels with the frame through every shuffle
// and the permutation test is unchanged. Before A-13 the frame-noise clip dropped most of such a
// target's light in an order-dependent way and Epsilon Indi B came out as "consistent" (6 of 100
// shuffles reached the real order, search/README.md).
//
// Limits: shuffling keeps each frame's flux. A source that does not move but whose flux changes
// with time (a variable star, or LVF wavelengths that drift from visit to visit) can make the
// real order look better than shuffles; the "beats the zero vector" rule guards against most of
// that. Parallax (0.45″ for WISE 0855) is not modelled.

import { scoreGrid, type GridOptions, type ScoreGrid, type VectorScore } from "./grid";
import type { StackableCube } from "./stack";

/** Best score needed to say "something is there". Blank sky reaches 1.5-4.1 (see grid.ts). */
export const DETECT_SNR = 5;

/** Motion counts as detected when p is below this. Needs n >= 100 shuffles to be reachable. */
export const MOTION_ALPHA = 0.01;

export interface SignificanceOptions extends Omit<GridOptions, "onProgress"> {
  /** Seed for the shuffles; the same seed gives the same result. Default 1. */
  seed?: number;
  /** Called after each grid search with (done, n + 1): the real order first, then the shuffles. */
  onProgress?: (done: number, total: number) => void;
}

export interface FalseAlarmResult {
  /** The search on the real time order (grid scores; for the fitted best vector use velocityGrid). */
  grid: ScoreGrid;
  /** Score of the zero vector (no motion), the same for every order. */
  zero: VectorScore;
  /** Best grid cell except (0, 0), real order: the test statistic. */
  moving: VectorScore;
  /** The same statistic for each shuffled order. */
  nullScores: number[];
  /** Number of shuffles. */
  n: number;
  /** Shuffles that scored at least as high as the real order. */
  nExceed: number;
  /** Chance that a random time order scores this high: (1 + nExceed) / (n + 1). */
  p: number;
  /** Smallest p this n can give, 1 / (n + 1). */
  pMin: number;
  /** (statistic - mean of shuffles) / their standard deviation. Indicative only: the shuffle
   *  scores are maxima, not Gaussian. Useful when p sits at pMin. */
  z: number;
  seed: number;
  elapsedMs: number;
}

/** Seeded uniform generator in [0, 1) (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random permutation of 0..n-1 (Fisher-Yates). */
export function permutation(n: number, rand: () => number): number[] {
  const p = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  return p;
}

/** The same cube with frame k given the MJD of frame order[k]. Pixel data are shared, not copied. */
export function withTimes(cube: StackableCube, order: readonly number[]): StackableCube {
  const frames = cube.meta.frames;
  if (order.length !== frames.length) throw new Error("order must list every frame once");
  return {
    ...cube,
    meta: { ...cube.meta, frames: frames.map((f, k) => ({ ...f, mjd: frames[order[k]].mjd })) },
  };
}

/** Best cell of a score grid, skipping the zero vector. */
export function bestMoving(g: Pick<ScoreGrid, "cells">): VectorScore {
  let best: VectorScore | null = null;
  for (const c of g.cells) {
    if (c.pmRa === 0 && c.pmDec === 0) continue;
    if (best === null || c.snr > best.snr) best = c;
  }
  if (best === null) throw new Error("the grid has no vector other than (0, 0)");
  return best;
}

/**
 * Search the cube, then repeat the search `n` times with the frame times shuffled, and return how
 * often a random time order scores as high as the real one. Runtime is about (n + 1) searches:
 * ~0.7-1.3 s each on a 61x61x45 cube, so run it in a worker and keep n small in the UI.
 */
export function falseAlarm(cube: StackableCube, n = 100, options: SignificanceOptions = {}): FalseAlarmResult {
  if (!Number.isInteger(n) || n < 1) throw new Error(`n must be a positive integer, got ${n}`);
  const t0 = performance.now();
  const { seed = 1, onProgress, ...gridOptions } = options;

  const grid = scoreGrid(cube, gridOptions);
  onProgress?.(1, n + 1);
  const moving = bestMoving(grid);

  const rand = mulberry32(seed);
  const nullScores: number[] = [];
  for (let r = 0; r < n; r++) {
    const shuffled = withTimes(cube, permutation(cube.meta.frames.length, rand));
    const g = scoreGrid(shuffled, gridOptions);
    nullScores.push(bestMoving(g).snr);
    onProgress?.(r + 2, n + 1);
  }

  const nExceed = nullScores.filter((v) => v >= moving.snr).length;
  const mean = nullScores.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(nullScores.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : NaN;
  return {
    grid,
    zero: grid.zero,
    moving,
    nullScores,
    n,
    nExceed,
    p: (1 + nExceed) / (n + 1),
    pMin: 1 / (n + 1),
    z: sd > 0 ? (moving.snr - mean) / sd : NaN,
    seed,
    elapsedMs: performance.now() - t0,
  };
}

/**
 * - "none":       best score below DETECT_SNR: nothing above what blank sky gives.
 * - "detected":   a source, and its motion is unlikely to be luck: shuffled time orders score this high in less
 *                 than MOTION_ALPHA of cases, and the best moving vector beats the zero vector.
 * - "consistent": a source, but the motion is not established. Report the vector as "consistent
 *                 with", never as a detection of motion.
 */
export type MotionVerdictKind = "none" | "consistent" | "detected";

export interface MotionVerdict {
  kind: MotionVerdictKind;
  /** Best score of the search (any vector, including zero). */
  bestSnr: number;
  zeroSnr: number;
  /** Best moving score minus zero score. */
  gain: number;
  p: number;
  pMin: number;
}

export function motionVerdict(
  fa: FalseAlarmResult,
  { detectSnr = DETECT_SNR, alpha = MOTION_ALPHA }: { detectSnr?: number; alpha?: number } = {},
): MotionVerdict {
  const bestSnr = fa.grid.gridBest.snr;
  const gain = fa.moving.snr - fa.zero.snr;
  let kind: MotionVerdictKind;
  if (!(bestSnr >= detectSnr)) kind = "none";
  else if (fa.p < alpha && gain > 0) kind = "detected";
  else kind = "consistent";
  return { kind, bestSnr, zeroSnr: fa.zero.snr, gain, p: fa.p, pMin: fa.pMin };
}
