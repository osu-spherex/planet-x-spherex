// Epochs and difference images (role B, task B-02).
//
// SPHEREx looks at a given patch of sky in short bursts ("visits") months apart. Frames closer
// than EPOCH_GAP_DAYS belong to one epoch. Within an epoch a star moves far less than a pixel, so
// the per-pixel median of its frames is a clean, cosmic-ray-free image of the field at that time.
// Subtracting two epoch medians (B - A) cancels everything that stayed put; a moving star leaves a
// pair of spots: positive (red) where it is in B, negative (blue) where it was in A.
//
// Caveat shown in the UI: each frame is taken at its own wavelength (LVF), so an epoch median mixes
// wavelengths, and two epochs mix them a little differently. Faint residuals at fixed stars are
// expected; brightness changes are measured in Python at matched wavelengths, not from this image.
//
// Display maths only. Cube layout as in cube.ts: data[n * H * W + y * W + x], row 0 = north,
// column 0 = east, background already subtracted per frame, NaN = no valid data.

import type { Cube, StretchLimits } from "./cube";
import { percentile, stretchLimits } from "./cube";
import { robustStats, stack } from "../search/stack";

/** Frames separated by more than this many days start a new epoch (task B-02; same rule as data/cube.py). */
export const EPOCH_GAP_DAYS = 20;

export interface Epoch {
  /** 0-based, in time order. */
  epoch: number;
  /** Cube frame indices in this epoch, in time order. */
  frames: number[];
  mjdMin: number;
  mjdMax: number;
  /** Mean MJD of the frames: the time an epoch median refers to. */
  mjdMean: number;
  /** Wavelength range covered by the frames (um); NaN if the frames carry no lam_um. */
  lamMin: number;
  lamMax: number;
}

/**
 * Group frames into epochs: sort by MJD and start a new group wherever two consecutive frames are
 * more than `gapDays` apart. Frames need not be sorted; indices refer to the input order.
 */
export function groupEpochs(
  frames: ReadonlyArray<{ mjd: number; lam_um?: number }>,
  gapDays: number = EPOCH_GAP_DAYS,
): Epoch[] {
  const order = frames.map((_, i) => i).filter((i) => Number.isFinite(frames[i].mjd));
  order.sort((a, b) => frames[a].mjd - frames[b].mjd || a - b);

  const groups: number[][] = [];
  for (const i of order) {
    const last = groups[groups.length - 1];
    if (last && frames[i].mjd - frames[last[last.length - 1]].mjd <= gapDays) last.push(i);
    else groups.push([i]);
  }

  return groups.map((idx, epoch) => {
    const mjds = idx.map((i) => frames[i].mjd);
    const lams = idx.map((i) => frames[i].lam_um).filter((l): l is number => Number.isFinite(l));
    return {
      epoch,
      frames: idx,
      mjdMin: mjds[0],
      mjdMax: mjds[mjds.length - 1],
      mjdMean: mjds.reduce((s, m) => s + m, 0) / mjds.length,
      lamMin: lams.length ? Math.min(...lams) : NaN,
      lamMax: lams.length ? Math.max(...lams) : NaN,
    };
  });
}

/**
 * Default pair for the difference view: the first and the last epoch with at least `minFrames`
 * frames (longest time baseline, so the largest motion). Falls back to the first and last epoch.
 * Returns null when there are fewer than two epochs.
 */
export function defaultEpochPair(epochs: readonly Epoch[], minFrames = 3): [number, number] | null {
  if (epochs.length < 2) return null;
  const good = epochs.filter((e) => e.frames.length >= minFrames);
  if (good.length >= 2) return [good[0].epoch, good[good.length - 1].epoch];
  return [epochs[0].epoch, epochs[epochs.length - 1].epoch];
}

export interface EpochImage {
  /** Per-pixel median of the epoch's frames (MJy/sr). NaN where no frame has data. */
  image: Float32Array;
  /** Number of frames that contributed to each pixel. */
  count: Uint16Array;
  /** Robust background sigma of the median image (MJy/sr). */
  sigma: number;
}

/**
 * Median image of one epoch. Uses role P's stack() with zero motion: within one epoch (at most
 * ~20 days) even Barnard's Star moves 10.4"/yr * 20/365 = 0.6", a fifth of a 3" cube pixel.
 */
export function epochMedian(cube: Cube, epoch: Epoch): EpochImage {
  const s = stack(cube, 0, 0, epoch.mjdMean, "median", { frames: epoch.frames });
  return { image: s.image, count: s.count, sigma: s.sigma };
}

/** B - A per pixel; NaN where either is NaN. */
export function differenceImage(a: Float32Array, b: Float32Array): Float32Array {
  if (a.length !== b.length) throw new Error(`images differ in size: ${a.length} vs ${b.length}`);
  const d = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) d[i] = b[i] - a[i];
  return d;
}

/** Display limits shared by two images, so that blinking between them compares like with like. */
export function sharedLimits(a: Float32Array, b: Float32Array, loPct = 1, hiPct = 99.5): StretchLimits {
  const both = new Float32Array(a.length + b.length);
  both.set(a);
  both.set(b, a.length);
  return stretchLimits(both, loPct, hiPct);
}

/** A difference brighter than this many robust sigmas is never drawn at less than full colour. */
export const DIFF_MIN_SIGMAS = 5;

/**
 * Symmetric colour limit for a difference image: the 99.5th percentile of |B - A|, but at least
 * DIFF_MIN_SIGMAS robust sigmas. The floor keeps pure noise dim, so an empty difference looks empty
 * instead of being stretched into fake spots. NaN if there is no valid pixel.
 */
export function differenceLimit(diff: Float32Array, pct = 99.5): number {
  const abs = diff.map((v) => Math.abs(v));
  const p = percentile(abs, pct);
  const { sigma } = robustStats(diff);
  if (!Number.isFinite(p)) return NaN;
  return Math.max(p, DIFF_MIN_SIGMAS * (Number.isFinite(sigma) ? sigma : 0));
}

/** Full-strength colour for B brighter than A (where the object is now). */
export const DIFF_POS_RGB: readonly [number, number, number] = [255, 72, 56];
/** Full-strength colour for A brighter than B (where the object was). */
export const DIFF_NEG_RGB: readonly [number, number, number] = [64, 150, 255];
/**
 * No data in either epoch. Neutral grey: the difference colour map runs black -> red and
 * black -> blue, so a grey can never be read as a measured value (cube.ts NAN_RGB is blue-grey and
 * could be mistaken for a faint negative here).
 */
export const DIFF_NAN_RGB: readonly [number, number, number] = [96, 96, 96];

/**
 * RGBA bytes for a difference image: 0 is black, +limit full red, -limit full blue (clipped),
 * NaN grey. Pass `out` to reuse a buffer.
 */
export function renderDifference(diff: Float32Array, limit: number, out?: Uint8ClampedArray): Uint8ClampedArray {
  const rgba = out ?? new Uint8ClampedArray(diff.length * 4);
  const ok = limit > 0 && Number.isFinite(limit);
  for (let i = 0, j = 0; i < diff.length; i++, j += 4) {
    const v = diff[i];
    if (!ok || !Number.isFinite(v)) {
      rgba[j] = DIFF_NAN_RGB[0];
      rgba[j + 1] = DIFF_NAN_RGB[1];
      rgba[j + 2] = DIFF_NAN_RGB[2];
    } else {
      const t = Math.min(1, Math.abs(v) / limit);
      const c = v >= 0 ? DIFF_POS_RGB : DIFF_NEG_RGB;
      rgba[j] = Math.round(c[0] * t);
      rgba[j + 1] = Math.round(c[1] * t);
      rgba[j + 2] = Math.round(c[2] * t);
    }
    rgba[j + 3] = 255;
  }
  return rgba;
}

/** Pixel of the largest (sign = +1) or most negative (sign = -1) finite value, or null. */
export function extremum(img: Float32Array, w: number, sign: 1 | -1): { x: number; y: number; value: number } | null {
  let best = -Infinity;
  let at = -1;
  for (let i = 0; i < img.length; i++) {
    const v = sign * img[i];
    if (Number.isFinite(v) && v > best) {
      best = v;
      at = i;
    }
  }
  return at < 0 ? null : { x: at % w, y: Math.floor(at / w), value: img[at] };
}
