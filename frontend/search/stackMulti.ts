// Stack several SPHEREx detectors at once (role P, task P-06).
//
// NASA suggests combining the six detectors (D1-D6) to improve the SNR. Each detector sees the
// same patch of sky in its own wavelength range, so for one motion we can put every frame of every
// detector into one weighted mean, each frame weighted by 1 / noise^2 (inverse variance: the
// weighting that gives the lowest noise when every frame measures the same signal).
//
// More data is not always better. A source shows up in a detector only if it is bright at that
// detector's wavelengths. WISE 0855 is a very cold brown dwarf, bright near 4.5 µm (D6) and faint
// at shorter wavelengths. If a detector carries no signal, its frames add noise and no signal:
// combining a detector with signal s and one without, at equal noise, gives
//   SNR = (s w N) / sqrt(2 w N) = SNR_alone / sqrt(2),
// worse than the good detector alone. Weighting by the source's expected spectrum would avoid that,
// but choosing weights from the data being tested inflates the SNR (the weights chase noise), so
// the weights here come from the noise only and the README reports what combining actually gives.
//
// Outlier clipping is done inside each detector, against that detector's own per-pixel median,
// with the frame-noise rule of stack.ts. Clipping across detectors would compare a source's D6
// flux with its near-zero D1 flux and throw the real light away (the P-07 lesson).

import { velocityGridOn, type GridOptions, type GridResult, type StackSource } from "./grid";
import {
  DEFAULT_CLIP_SIGMA,
  clampBox,
  frameShift,
  medianInPlace,
  robustStats,
  sampleBilinear,
  type PixelBox,
  type PixelShift,
  type StackableCube,
  type StackResult,
} from "./stack";

export interface MultiStackOptions {
  /** "clipped" (default): drop outliers within each detector, then combine. "mean": no clipping. */
  mode?: "clipped" | "mean";
  /** Clipping threshold in frame-noise units. Default 5 (stack.ts DEFAULT_CLIP_SIGMA). */
  clipSigma?: number;
  /** Only compute pixels inside this box, as in stack.ts. */
  region?: { x0: number; y0: number; x1: number; y1: number };
  /** Use only the cube pixels inside this box, as in stack.ts StackOptions.window (P-10). */
  window?: PixelBox;
}

/** Centre recorded in cube.json (optional in StackableCube). */
function centreOf(cube: StackableCube): { ra: number; dec: number } | undefined {
  return (cube.meta as { center?: { ra: number; dec: number } }).center;
}

/** Cubes must share the grid: same size, pixel scale and, where recorded, centre (within 0.1 px). */
export function checkSameGrid(cubes: readonly StackableCube[]): void {
  if (cubes.length === 0) throw new Error("stackMulti needs at least one cube");
  const a = cubes[0];
  const ca = centreOf(a);
  for (const b of cubes.slice(1)) {
    if (b.w !== a.w || b.h !== a.h) throw new Error(`cubes differ in size: ${a.w}x${a.h} vs ${b.w}x${b.h}`);
    if (b.meta.pixscale_arcsec !== a.meta.pixscale_arcsec) {
      throw new Error(`cubes differ in pixel scale: ${a.meta.pixscale_arcsec} vs ${b.meta.pixscale_arcsec}`);
    }
    const cb = centreOf(b);
    if (ca && cb) {
      const dRa = (cb.ra - ca.ra) * Math.cos((ca.dec * Math.PI) / 180) * 3600;
      const dDec = (cb.dec - ca.dec) * 3600;
      if (Math.hypot(dRa, dDec) > 0.1 * a.meta.pixscale_arcsec) {
        throw new Error(`cubes have different centres (${Math.hypot(dRa, dDec).toFixed(2)}″ apart)`);
      }
    }
  }
}

/**
 * Shift every frame of every cube by the motion (as stack.ts) and combine them with weights
 * 1 / noise^2. Same result shape as stack(); `frames` index the cubes' frames in order (cube 0's
 * frames first), and `count` is the number of frames kept per pixel.
 */
export function stackMulti(
  cubes: readonly StackableCube[],
  pmRa: number,
  pmDec: number,
  refMjd: number,
  options: MultiStackOptions = {},
): StackResult {
  checkSameGrid(cubes);
  const { w, h } = cubes[0];
  const pix = cubes[0].meta.pixscale_arcsec;
  const npix = w * h;
  const mode = options.mode ?? "clipped";
  const clipSigma = options.clipSigma ?? DEFAULT_CLIP_SIGMA;

  // Per cube: frame offsets in the data, shifts and noise.
  const per = cubes.map((cube) => {
    if (cube.data.length !== cube.n * npix) throw new Error(`cube data has ${cube.data.length} values, expected ${cube.n * npix}`);
    const shifts: PixelShift[] = cube.meta.frames.map((f) => frameShift(pmRa, pmDec, f.mjd, refMjd, pix));
    const noise = cube.meta.frames.map((f, k) =>
      f.noise !== undefined && f.noise > 0 ? f.noise : robustStats(cube.data.subarray(k * npix, (k + 1) * npix)).sigma,
    );
    return { cube, shifts, noise, weight: noise.map((s) => 1 / (s * s)) };
  });
  const maxN = Math.max(...cubes.map((c) => c.n));
  const vals = new Float64Array(maxN);
  const wts = new Float64Array(maxN);
  const nse = new Float64Array(maxN);
  const tmp = new Float64Array(maxN);

  const image = new Float32Array(npix).fill(NaN);
  const count = new Uint16Array(npix);
  const weightSum = new Float64Array(npix);
  const reg = clampBox(options.region, w, h);
  const win = clampBox(options.window, w, h);
  const xa = Math.max(reg.x0, win.x0);
  const xb = Math.min(reg.x1, win.x1);
  const ya = Math.max(reg.y0, win.y0);
  const yb = Math.min(reg.y1, win.y1);

  for (let y = ya; y < yb; y++) {
    for (let x = xa; x < xb; x++) {
      let W = 0;
      let S = 0;
      let kept = 0;
      for (const { cube, shifts, noise, weight } of per) {
        let len = 0;
        for (let k = 0; k < cube.n; k++) {
          const v = sampleBilinear(cube.data, k * npix, w, h, x + shifts[k].dx, y + shifts[k].dy, win.x0, win.y0, win.x1, win.y1);
          if (Number.isNaN(v)) continue;
          vals[len] = v;
          wts[len] = weight[k];
          nse[len] = noise[k];
          len++;
        }
        if (len === 0) continue;
        let m = 0;
        if (mode === "clipped") {
          tmp.set(vals.subarray(0, len));
          m = medianInPlace(tmp, len);
        }
        for (let i = 0; i < len; i++) {
          if (mode === "clipped" && Math.abs(vals[i] - m) > clipSigma * nse[i]) continue;
          W += wts[i];
          S += wts[i] * vals[i];
          kept++;
        }
      }
      const p = y * w + x;
      count[p] = kept;
      weightSum[p] = W;
      image[p] = kept === 0 ? NaN : S / W;
    }
  }

  // Noise map as in stack(): scale each pixel to the typical total weight, measure one robust
  // sigma, then noise = sigma * sqrt(Wtypical / W). With equal frame noise, W is proportional to
  // the frame count and this is exactly stack()'s coverage scaling.
  const ws: number[] = [];
  for (let p = 0; p < npix; p++) if (count[p] > 0) ws.push(weightSum[p]);
  const wTypical = robustStats(ws).median;
  const { median: background } = robustStats(image);
  const scaled = new Float32Array(npix);
  for (let p = 0; p < npix; p++) {
    scaled[p] = count[p] > 0 ? (image[p] - background) * Math.sqrt(weightSum[p] / wTypical) : NaN;
  }
  const { sigma } = robustStats(scaled);
  const noise = new Float32Array(npix);
  const snr = new Float32Array(npix);
  for (let p = 0; p < npix; p++) {
    if (count[p] === 0) {
      noise[p] = NaN;
      snr[p] = NaN;
    } else {
      noise[p] = sigma * Math.sqrt(wTypical / weightSum[p]);
      snr[p] = (image[p] - background) / noise[p];
    }
  }
  const counts: number[] = [];
  for (let p = 0; p < npix; p++) if (count[p] > 0) counts.push(count[p]);

  return {
    w,
    h,
    image,
    count,
    background,
    sigma,
    nTypical: robustStats(counts).median,
    noise,
    snr,
    shifts: per.flatMap((c) => c.shifts),
    frames: per.flatMap((c, i) => c.shifts.map((_, k) => per.slice(0, i).reduce((a, q) => a + q.cube.n, 0) + k)),
  };
}

/** Several detectors as one StackSource for the grid search. One cube also goes through
 *  stackMulti (weighted), so "one detector" and "combined" are compared with the same stacking. */
export function multiSource(cubes: readonly StackableCube[]): StackSource {
  checkSameGrid(cubes);
  return {
    w: cubes[0].w,
    h: cubes[0].h,
    pixscale_arcsec: cubes[0].meta.pixscale_arcsec,
    mjds: cubes.flatMap((c) => c.meta.frames.map((f) => f.mjd)),
    stackAt: (pmRa, pmDec, refMjd, mode, opts) => {
      if (mode === "median") throw new Error("stackMulti supports modes 'clipped' and 'mean'");
      if (opts.clipScale === "pixel") throw new Error("stackMulti clips with the frame noise only");
      return stackMulti(cubes, pmRa, pmDec, refMjd, { mode, clipSigma: opts.clipSigma, region: opts.region, window: opts.window });
    },
  };
}

/** velocityGrid (grid.ts) over several detectors at once. */
export function velocityGridMulti(cubes: readonly StackableCube[], options: GridOptions = {}): GridResult {
  return velocityGridOn(multiSource(cubes), options);
}
