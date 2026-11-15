// Shift-and-stack (role P, task P-01).
//
// A faint moving object (WISE 0855 is SNR 2-7 per SPHEREx frame) disappears in any single frame.
// If we guess its motion, we can shift every frame back so that the object sits on the same pixel,
// then average: the object adds up coherently (N times the signal) while independent noise only
// grows as sqrt(N), so the SNR of the stack rises by about sqrt(N). With a wrong motion vector the
// object lands on different pixels in different frames and the stack does not gain.
//
// Cube layout (docs/ARCHITECTURE.md "Интерфейс", data/cubes/README.md):
//   data[n * H * W + y * W + x], row y = 0 is the NORTH edge, column x = 0 is the EAST edge,
//   background already subtracted per frame, NaN = no valid data.
// Therefore +RA (east) motion means x DEcreases and +Dec (north) motion means y DEcreases.
//
// This module is display/search maths only. Positions and fluxes for the science numbers are
// measured in Python on the raw cutouts (data/).

/** Julian year in days. Proper motions (arcsec/yr, as in Gaia and CatWISE) use the Julian year.
 *  IAU Style Manual, units: "a (year, Julian) = 365.25 d",
 *  https://www.iau.org/publications/proceedings_rules/units/ */
export const JULIAN_YEAR_DAYS = 365.25;

/** 1.4826 * MAD = sigma for Gaussian noise (1 / Phi^-1(3/4)). */
const MAD_TO_SIGMA = 1.4826;

/** Bilinear weights below this are treated as zero, so float dust such as 1e-15 does not pull a
 *  NaN or out-of-bounds neighbour into an otherwise exact sample. */
const WEIGHT_EPS = 1e-9;

/** The part of a cube that stacking needs. viewer/cube.ts `Cube` satisfies it as is. */
export interface StackableCube {
  data: Float32Array;
  n: number;
  h: number;
  w: number;
  meta: {
    pixscale_arcsec: number;
    /** `noise` (robust sigma of the frame, MJy/sr) is used by mode "clipped"; computed if missing. */
    frames: ReadonlyArray<{ mjd: number; noise?: number }>;
  };
}

/**
 * - "mean":    plain mean. Best SNR on clean data, but one cosmic ray or hot pixel ruins it.
 * - "median":  robust, about 1.25x noisier than the mean for Gaussian noise.
 * - "clipped": mean after dropping outliers: samples more than `clipSigma` x scale from the pixel's
 *              median across frames. Real SPHEREx cubes need this: the WISE 0855 D6 static cube
 *              has single-frame pixels up to ~14000 sigma (checked 11/14), which swamp a plain mean.
 *              The scale is each frame's noise (StackOptions.clipScale, see DEFAULT_CLIP_SIGMA).
 */
export type StackMode = "mean" | "median" | "clipped";

export interface StackOptions {
  /** Use only these frame indices (default: all frames). */
  frames?: ArrayLike<number>;
  /** Rejection threshold for mode "clipped", in units of the scale below. Default 5. */
  clipSigma?: number;
  /** Scale for mode "clipped". "frame" (default): each frame's noise. "pixel": the larger of the
   *  frame's noise and this pixel's own spread across frames (1.4826 x MAD). "pixel" is the P-07
   *  experiment, kept so it can be reproduced; it is not the default and must not be picked per
   *  object to improve a result (see DEFAULT_CLIP_SIGMA and search/README.md). */
  clipScale?: "pixel" | "frame";
  /** Only compute pixels with x0 <= x < x1, y0 <= y < y1 (clamped to the cube); the rest are NaN
   *  with count 0, and background/sigma come from this box. Used by the grid search for speed. */
  region?: { x0: number; y0: number; x1: number; y1: number };
  /** Use only the cube pixels with x0 <= x < x1, y0 <= y < y1 (clamped to the cube), as if the cube
   *  ended there: a sample from outside counts as missing, stack pixels outside are not computed,
   *  and a frame noise measured here (no `noise` in the cube) comes from inside only. The grid search
   *  sets it to the static cubes' 3′ field around its centre, so that a larger live cube gives the
   *  same answer as the static one (issue #100). Default: the whole cube. */
  window?: PixelBox;
  /** Relative brightness of the target in every cube frame (one value per frame of the cube, from
   *  `brightnessScale`). Frame k and its noise are divided by scale[k] before combining, so a
   *  target seen at a different wavelength in every frame has the same brightness in all of them.
   *  Frames whose scale is not a positive finite number are left out. Default: none. */
  scale?: ArrayLike<number>;
}

/** Default for StackOptions.clipSigma. The target is cosmic rays and hot pixels: one frame far off
 *  while the others agree. An LVF frame sees the object at its own wavelength, so genuine flux also
 *  differs between frames, on a bright target by far more than the frame noise (eps Ind B D2: 27 to
 *  1254 frame-sigmas), and clipping against the frame noise then drops real starlight too (P-05).
 *  Clipping against the pixel's own spread instead (clipScale "pixel", P-07) keeps that light and
 *  fixes eps Ind B, but also keeps the few brightest-wavelength frames of WISE 0855 and Barnard,
 *  which then decide the best motion: 7.65″/yr and 2.38″/yr off the catalogue instead of 0.94 and
 *  1.12 (search/numbers.test.ts). So the default stays "frame" (search/README.md).
 *  A-13: when the target is bright enough to measure in single frames, the search first divides
 *  every frame by the target's brightness in it (`brightnessScale`); the genuine flux then agrees
 *  between frames and the pixel's own spread is small again, so there it clips with "pixel". */
export const DEFAULT_CLIP_SIGMA = 5;

/** Size of a SPHEREx detector pixel in arcsec (the static cubes are resampled to 3″). Measured
 *  from the WCS of the Level 2 cutouts (CLAUDE.md, 11/10; data/cube.py, PIXSCALE comment). */
export const NATIVE_PIXEL_ARCSEC = 6.16;

/** A frame "sees" the target by itself when the summed flux around the search centre is at least
 *  this many times its noise. The same level as DETECT_SNR for the stack (significance.ts). */
export const FRAME_DETECT_SNR = 5;

/** A box of cube pixels: x0 <= x < x1, y0 <= y < y1. */
export interface PixelBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** `box` clamped to a w × h cube, as integer bounds; the whole cube when `box` is undefined. */
export function clampBox(box: PixelBox | undefined, w: number, h: number): PixelBox {
  if (!box) return { x0: 0, y0: 0, x1: w, y1: h };
  return {
    x0: Math.max(0, Math.floor(box.x0)),
    y0: Math.max(0, Math.floor(box.y0)),
    x1: Math.min(w, Math.ceil(box.x1)),
    y1: Math.min(h, Math.ceil(box.y1)),
  };
}

export interface PixelShift {
  /** Where the object is in this frame relative to its reference position, in pixels (+x = west). */
  dx: number;
  /** Same, rows (+y = south). */
  dy: number;
}

export interface StackResult {
  w: number;
  h: number;
  /** Stacked image (MJy/sr), aligned on the object's position at refMjd. NaN where no frame had data. */
  image: Float32Array;
  /** Number of frames that contributed to each pixel. */
  count: Uint16Array;
  /** Robust background level of the stack (median of finite pixels), MJy/sr. ~0 for bg-subtracted cubes. */
  background: number;
  /** Robust sigma of the stack (1.4826 * MAD), scaled to the typical coverage `nTypical`. */
  sigma: number;
  /** Median of `count` over pixels with data: the coverage that `sigma` refers to. */
  nTypical: number;
  /** Per-pixel noise: sigma * sqrt(nTypical / count). NaN where count = 0. */
  noise: Float32Array;
  /** (image - background) / noise. NaN where count = 0. */
  snr: Float32Array;
  /** Shift applied to each used frame, in the same order as the frames used. */
  shifts: PixelShift[];
  /** Frame indices used, in order. */
  frames: number[];
}

/**
 * Offset of a moving object in pixels at `mjd` relative to its position at `refMjd`.
 * `pmRa` already includes cos(Dec) (as catalogues give it), both in arcsec per Julian year.
 */
export function frameShift(
  pmRa: number,
  pmDec: number,
  mjd: number,
  refMjd: number,
  pixscaleArcsec: number,
): PixelShift {
  const dtYears = (mjd - refMjd) / JULIAN_YEAR_DAYS;
  // East (+RA) is toward x = 0 and north (+Dec) toward y = 0, hence the minus signs.
  // `+ 0` turns -0 into 0 so that a zero motion gives a clean { dx: 0, dy: 0 }.
  return {
    dx: (-pmRa * dtYears) / pixscaleArcsec + 0,
    dy: (-pmDec * dtYears) / pixscaleArcsec + 0,
  };
}

/**
 * Bilinear sample of one frame at fractional pixel (x, y). Returns NaN if any neighbour that
 * carries weight is NaN or outside the frame, so invalid pixels never leak into the stack.
 * (bx0, by0, bx1, by1) narrows "the frame" to a window of it (StackOptions.window); the rows are
 * still `w` values long.
 */
export function sampleBilinear(
  data: Float32Array,
  offset: number,
  w: number,
  h: number,
  x: number,
  y: number,
  bx0 = 0,
  by0 = 0,
  bx1 = w,
  by1 = h,
): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  let sum = 0;
  for (let j = 0; j < 2; j++) {
    const wy = j === 0 ? 1 - fy : fy;
    if (wy < WEIGHT_EPS) continue;
    const yy = y0 + j;
    for (let i = 0; i < 2; i++) {
      const wx = i === 0 ? 1 - fx : fx;
      if (wx < WEIGHT_EPS) continue;
      const xx = x0 + i;
      if (xx < bx0 || xx >= bx1 || yy < by0 || yy >= by1) return NaN;
      const v = data[offset + yy * w + xx];
      if (Number.isNaN(v)) return NaN;
      sum += wx * wy * v;
    }
  }
  return sum;
}

/** Median of the first `len` values of `buf` (sorted in place). NaN for len = 0. */
export function medianInPlace(buf: Float64Array, len: number): number {
  if (len === 0) return NaN;
  let s: Float64Array = buf;
  if (len <= 64) {
    // Per-pixel stacks are small (tens of frames); insertion sort avoids the per-call overhead of
    // TypedArray.sort, which dominated the grid search (11/14: 2.7 s -> see grid.ts timing).
    for (let i = 1; i < len; i++) {
      const v = buf[i];
      let j = i - 1;
      while (j >= 0 && buf[j] > v) {
        buf[j + 1] = buf[j];
        j--;
      }
      buf[j + 1] = v;
    }
  } else {
    s = buf.subarray(0, len).sort();
  }
  const mid = len >> 1;
  return len % 2 === 1 ? s[mid] : 0.5 * (s[mid - 1] + s[mid]);
}

/** Median and robust sigma (1.4826 * MAD) of finite values. */
export function robustStats(values: ArrayLike<number>): { median: number; sigma: number } {
  const buf = new Float64Array(values.length);
  let len = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isFinite(v)) buf[len++] = v;
  }
  const median = medianInPlace(buf, len);
  for (let i = 0; i < len; i++) buf[i] = Math.abs(buf[i] - median);
  return { median, sigma: MAD_TO_SIGMA * medianInPlace(buf, len) };
}

/** Noise of frame f: the cube's value (robust sigma, MJy/sr) or, if missing, measured here
 *  (inside `win` only, when given). */
function frameNoiseOf(cube: StackableCube, f: number, win?: PixelBox): number {
  const given = cube.meta.frames[f].noise;
  if (given !== undefined && given > 0) return given;
  const npix = cube.h * cube.w;
  if (!win) return robustStats(cube.data.subarray(f * npix, (f + 1) * npix)).sigma;
  const b = clampBox(win, cube.w, cube.h);
  const values: number[] = [];
  for (let y = b.y0; y < b.y1; y++) for (let x = b.x0; x < b.x1; x++) values.push(cube.data[f * npix + y * cube.w + x]);
  return robustStats(values).sigma;
}

export interface FrameBrightness {
  /** Radius of the aperture in pixels: the search radius plus one native pixel for the PSF. */
  apertureRadius: number;
  /** Per frame: sum of the pixels inside the aperture (cube units). NaN if less than half of the
   *  aperture has data. */
  amp: Float64Array;
  /** Per frame: amp / its noise. */
  snr: Float64Array;
  /** Number of frames with snr >= FRAME_DETECT_SNR. */
  nMeasurable: number;
}

/**
 * How bright is whatever sits in the search region, frame by frame (A-13)? Each SPHEREx frame sees
 * the target at its own wavelength (LVF), so its brightness can differ many times between frames:
 * 8x for Epsilon Indi B in D2 (experiments/search_diag.py). The measure is the plain sum inside
 * (search radius + one native pixel) of the search centre. It uses neither the motion being tried
 * nor the frame's time, so it is the same number for every vector of the grid and for every
 * shuffled time order: the shuffle test (significance.ts) stays valid.
 *
 * Noise of the sum: neighbouring pixels of the resampled cube share a native pixel, so n pixels
 * carry n x (pixscale / native)^2 independent values and the sum has noise
 * frameNoise x sqrt(n) x native / pixscale.
 */
export function frameBrightness(
  cube: StackableCube,
  cx: number,
  cy: number,
  radius: number,
  window?: PixelBox,
): FrameBrightness {
  const { n, h, w, data } = cube;
  const oversample = Math.max(1, NATIVE_PIXEL_ARCSEC / cube.meta.pixscale_arcsec);
  const apertureRadius = radius + oversample;
  const r2 = apertureRadius * apertureRadius;
  const b = clampBox(window, w, h);
  const offsets: number[] = [];
  for (let y = Math.max(b.y0, Math.ceil(cy - apertureRadius)); y <= Math.min(b.y1 - 1, Math.floor(cy + apertureRadius)); y++) {
    for (let x = Math.max(b.x0, Math.ceil(cx - apertureRadius)); x <= Math.min(b.x1 - 1, Math.floor(cx + apertureRadius)); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r2) offsets.push(y * w + x);
    }
  }
  const amp = new Float64Array(n);
  const snr = new Float64Array(n);
  let nMeasurable = 0;
  for (let f = 0; f < n; f++) {
    let sum = 0;
    let valid = 0;
    for (let i = 0; i < offsets.length; i++) {
      const v = data[f * h * w + offsets[i]];
      if (Number.isNaN(v)) continue;
      sum += v;
      valid++;
    }
    if (valid === 0 || valid * 2 < offsets.length) {
      amp[f] = NaN;
      snr[f] = NaN;
      continue;
    }
    amp[f] = sum;
    snr[f] = sum / (frameNoiseOf(cube, f, window) * Math.sqrt(valid) * oversample);
    if (snr[f] >= FRAME_DETECT_SNR) nMeasurable++;
  }
  return { apertureRadius, amp, snr, nMeasurable };
}

/**
 * Per-frame scale for StackOptions.scale, or null when the search should run on the frames as
 * they are. The rule is the same for every cube: if MORE THAN HALF of the frames see the target by
 * themselves (frameBrightness snr >= FRAME_DETECT_SNR), every such frame gets its brightness
 * relative to their median (so the stack keeps the cube's units) and the others get NaN, i.e. are
 * left out: a frame that does not see the target cannot be put on its scale. Otherwise (a target
 * too faint for single frames such as WISE 0855, or blank sky) the brightness is not known, and
 * dividing by a noisy number would only add noise: null.
 */
export function brightnessScale(
  cube: StackableCube,
  cx: number,
  cy: number,
  radius: number,
  window?: PixelBox,
): Float64Array | null {
  const b = frameBrightness(cube, cx, cy, radius, window);
  if (b.nMeasurable * 2 <= cube.n) return null;
  const good = new Float64Array(b.nMeasurable);
  let len = 0;
  for (let f = 0; f < cube.n; f++) if (b.snr[f] >= FRAME_DETECT_SNR) good[len++] = b.amp[f];
  const typical = medianInPlace(good, len);
  const scale = new Float64Array(cube.n).fill(NaN);
  for (let f = 0; f < cube.n; f++) if (b.snr[f] >= FRAME_DETECT_SNR) scale[f] = b.amp[f] / typical;
  return scale;
}

/**
 * Shift every frame by the motion (pmRa, pmDec) in arcsec/yr relative to `refMjd` and combine.
 * The result is aligned on where the object was at `refMjd`: a source moving with exactly this
 * motion piles up on one pixel. NaN pixels and pixels shifted in from outside the frame are
 * skipped per frame, so `count` can vary across the stack.
 */
export function stack(
  cube: StackableCube,
  pmRa: number,
  pmDec: number,
  refMjd: number,
  mode: StackMode = "mean",
  options: StackOptions = {},
): StackResult {
  const { n, h, w, data } = cube;
  if (data.length !== n * h * w) {
    throw new Error(`cube data has ${data.length} values, expected n*h*w = ${n * h * w}`);
  }
  if (cube.meta.frames.length !== n) {
    throw new Error(`cube has ${n} frames but meta.frames lists ${cube.meta.frames.length}`);
  }
  const pix = cube.meta.pixscale_arcsec;
  if (!(pix > 0)) throw new Error(`pixscale_arcsec must be > 0, got ${pix}`);

  const scale = options.scale;
  if (scale && scale.length !== n) throw new Error(`scale has ${scale.length} values, expected one per frame (${n})`);
  const usable = (f: number) => !scale || (scale[f] > 0 && Number.isFinite(scale[f]));
  const frames: number[] = [];
  if (options.frames) {
    for (let k = 0; k < options.frames.length; k++) {
      const f = options.frames[k];
      if (!Number.isInteger(f) || f < 0 || f >= n) throw new Error(`frame index ${f} out of range`);
      if (usable(f)) frames.push(f);
    }
  } else {
    for (let f = 0; f < n; f++) if (usable(f)) frames.push(f);
  }
  // 1 / brightness per used frame; exactly 1 without a scale, which leaves every value unchanged.
  const gain = frames.map((f) => (scale ? 1 / scale[f] : 1));
  const shifts = frames.map((f) => frameShift(pmRa, pmDec, cube.meta.frames[f].mjd, refMjd, pix));

  const npix = h * w;
  const clipSigma = options.clipSigma ?? DEFAULT_CLIP_SIGMA;
  const clipScale = options.clipScale ?? "frame";
  const win = clampBox(options.window, w, h);
  const frameNoise = mode === "clipped" ? frames.map((f, k) => frameNoiseOf(cube, f, options.window) * gain[k]) : [];

  const image = new Float32Array(npix).fill(NaN);
  const count = new Uint16Array(npix);
  const buf = new Float64Array(frames.length);
  const tmp = new Float64Array(frames.length);
  const sampleNoise = new Float64Array(frames.length);

  const reg = clampBox(options.region, w, h);
  const xa = Math.max(reg.x0, win.x0);
  const xb = Math.min(reg.x1, win.x1);
  const ya = Math.max(reg.y0, win.y0);
  const yb = Math.min(reg.y1, win.y1);

  for (let y = ya; y < yb; y++) {
    for (let x = xa; x < xb; x++) {
      let len = 0;
      let sum = 0;
      for (let k = 0; k < frames.length; k++) {
        // The object, at (x, y) at refMjd, is at (x + dx, y + dy) in frame k.
        const v =
          sampleBilinear(data, frames[k] * npix, w, h, x + shifts[k].dx, y + shifts[k].dy, win.x0, win.y0, win.x1, win.y1) *
          gain[k];
        if (Number.isNaN(v)) continue;
        if (mode === "clipped") sampleNoise[len] = frameNoise[k];
        buf[len++] = v;
        sum += v;
      }
      const p = y * w + x;
      if (len === 0) {
        count[p] = 0;
        image[p] = NaN;
      } else if (mode === "mean") {
        count[p] = len;
        image[p] = sum / len;
      } else if (mode === "median") {
        count[p] = len;
        image[p] = medianInPlace(buf, len);
      } else {
        tmp.set(buf.subarray(0, len));
        const m = medianInPlace(tmp, len);
        // The pixel's own spread is only needed if some sample falls outside the frame-noise
        // window; on clean pixels (nearly all of them) it is skipped.
        let spread = 0;
        if (clipScale === "pixel") {
          let outside = false;
          for (let i = 0; i < len && !outside; i++) outside = Math.abs(buf[i] - m) > clipSigma * sampleNoise[i];
          if (outside) {
            for (let i = 0; i < len; i++) tmp[i] = Math.abs(buf[i] - m);
            spread = MAD_TO_SIGMA * medianInPlace(tmp, len);
          }
        }
        let kept = 0;
        let keptSum = 0;
        for (let i = 0; i < len; i++) {
          if (Math.abs(buf[i] - m) <= clipSigma * Math.max(sampleNoise[i], spread)) {
            kept++;
            keptSum += buf[i];
          }
        }
        count[p] = kept;
        image[p] = kept === 0 ? NaN : keptSum / kept;
      }
    }
  }

  // Coverage differs across the stack (edges, NaN holes). Scale every pixel to the typical
  // coverage before measuring the noise, so that one sigma describes the whole stack.
  const counts: number[] = [];
  for (let p = 0; p < npix; p++) if (count[p] > 0) counts.push(count[p]);
  const nTypical = robustStats(counts).median;
  const { median: background } = robustStats(image);
  const scaled = new Float32Array(npix);
  for (let p = 0; p < npix; p++) {
    scaled[p] = count[p] > 0 ? (image[p] - background) * Math.sqrt(count[p] / nTypical) : NaN;
  }
  const { sigma } = robustStats(scaled);

  const noise = new Float32Array(npix);
  const snr = new Float32Array(npix);
  for (let p = 0; p < npix; p++) {
    if (count[p] === 0) {
      noise[p] = NaN;
      snr[p] = NaN;
    } else {
      noise[p] = sigma * Math.sqrt(nTypical / count[p]);
      snr[p] = (image[p] - background) / noise[p];
    }
  }

  return { w, h, image, count, background, sigma, nTypical, noise, snr, shifts, frames };
}
