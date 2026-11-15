// Velocity grid search, the "Motion search" panel (role P, task P-02).
//
// We do not know how a faint object moves, so we try many motions: for every proper-motion
// vector on a grid we shift-and-stack the cube (stack.ts) and score the vector by the highest
// SNR found near the centre. A real mover gives a peak in the score map around its true vector;
// elsewhere the score is just the largest noise fluctuation.
//
// Look-elsewhere effect: trying ~100 vectors x ~50 pixels gives thousands of chances for noise to
// look like a detection, so the best score on blank sky is well above a single-trial 3 sigma:
// 2.3-4.1 in 8 regions 45″ from WISE 0855 on its D6 cube, 1.5-3.5 on role A's control cube
// (search/numbers.test.ts, 11/14). Compare a candidate with the same search on blank sky before
// calling it a detection (significance.ts).
//
// Grid step: two vectors that differ by dv move the object apart by dv * T over the baseline T.
// Once that is about one pixel the stacks differ, so the step is pixscale / T (task P-02).
//
// Best vector: the score peak is broad. SPHEREx visits a field in a few clusters of days, so most
// frames constrain the motion only over the gap between clusters, and the PSF (6.16″ native) is
// two pixels of the 3″ cube grid. On WISE 0855 D6 every vector within ~3″/yr of the top scores
// within ~1 SNR of it, so the single best cell is decided by noise. Instead we fit a 2D quadratic
// to the scores around the best cell and take its vertex, which uses the whole peak.
//
// Bright targets (A-13): each frame sees the target at its own wavelength (LVF), so a target
// bright enough to show in single frames changes brightness many times from frame to frame
// (Epsilon Indi B, D2: 8x in the summed flux). Stacking such frames as they are either clips the
// real light (frame-noise clip) or lets the few brightest frames decide the motion. So when more
// than half of the frames see the target by themselves, every frame is first divided by the
// target's brightness in it (stack.ts brightnessScale): one rule for every cube, decided from the
// cube alone. Faint targets and blank sky are stacked exactly as before.
//
// Field of view (P-10, issue #100): the site opens 6′ live cubes, the static demo cubes are 3′. On
// Barnard's Star the same 60 frames gave 1.66″/yr off Gaia on the 3′ cube and 5.09 on a 6′ one,
// because in the larger cube real pixels shift into the stacking box from outside the 3′ field,
// where the 3′ cube has none. The search therefore uses only the middle 3′ of the cube, the static
// cube's footprint (GridOptions.field, fieldWindow): a larger cube then gives exactly the 3′
// answer, and the 3′ numbers do not change (there the field is the whole cube).

import {
  JULIAN_YEAR_DAYS,
  brightnessScale,
  stack,
  type PixelBox,
  type StackableCube,
  type StackMode,
  type StackOptions,
  type StackResult,
} from "./stack";

/** Field of view of the static demo cubes in arcmin: data/cube.py DEFAULT_FOV = 3, i.e. the middle
 *  fov * 20 + 1 = 61 pixels of 3″ of any cube (cube.json `fov_arcmin`). */
export const STATIC_FIELD_ARCMIN = 3;

export interface GridOptions {
  /** Search |pmRa|, |pmDec| up to this many arcsec/yr. Default 15. */
  pmMax?: number;
  /** Grid step in arcsec/yr. Default pixscale / baseline (see top of file). */
  step?: number;
  /** Stacks are aligned on the object's position at this MJD. Default: mean MJD of the frames. */
  refMjd?: number;
  /** Combination used for every stack. Default "clipped" (robust to cosmic rays, see stack.ts). */
  mode?: StackMode;
  /** Clipping scale for mode "clipped" (stack.ts StackOptions.clipScale). Default "frame"; always
   *  "pixel" when the frames are put on a common brightness (see `normalise`). */
  clipScale?: StackOptions["clipScale"];
  /** "auto" (default): if more than half of the frames see the target by themselves, divide every
   *  frame by the target's brightness in it before stacking (stack.ts `brightnessScale`); else
   *  stack the frames as they are. "off": always stack the frames as they are (the search as it
   *  was before A-13, kept so its numbers can be reproduced). */
  normalise?: "auto" | "off";
  /** Centre of the search region in pixels. Default: the cube centre. */
  centerX?: number;
  centerY?: number;
  /** Search region radius in pixels around the centre. Default 4 (12″ on the 3″ static cubes). */
  radius?: number;
  /** Stacks are computed only in a box of this half-size (pixels) around the centre, and the noise
   *  comes from that box. Smaller is faster. Default Infinity (whole cube). */
  noiseBox?: number;
  /** Side, in arcmin, of the square of cube pixels the search may use, centred on the search
   *  centre (stack.ts StackOptions.window). Default STATIC_FIELD_ARCMIN (3′): a 6′ live cube then
   *  gives exactly the answer of the 3′ static cube (issue #100). Infinity: the whole cube. */
  field?: number;
  /** Half-width, in grid cells, of the window for the quadratic peak fit. Default 2 (5×5 cells). */
  fitHalfWidth?: number;
  /** Called after every stack with (done, total). */
  onProgress?: (done: number, total: number) => void;
}

export interface VectorScore {
  pmRa: number;
  pmDec: number;
  /** Highest SNR inside the search region for this vector. */
  snr: number;
  /** Pixel of that SNR (the object's position at refMjd). */
  x: number;
  y: number;
}

export interface GridResult {
  /** Axis values (arcsec/yr), ascending. */
  pmRaAxis: number[];
  pmDecAxis: number[];
  /** Score heatmap, score[iDec * pmRaAxis.length + iRa] (row 0 = most negative pmDec). */
  score: Float32Array;
  /** Highest-scoring grid cell. */
  gridBest: VectorScore;
  /** Best estimate: vertex of the quadratic fit, scored with its own stack. Equals gridBest if the
   *  fit failed (see `fitted`). */
  best: VectorScore;
  /** True if `best` comes from the quadratic fit. */
  fitted: boolean;
  /** The stack at `best`, for display. */
  bestStack: StackResult;
  /** True if the frames were put on a common brightness first (GridOptions.normalise). */
  normalised?: boolean;
  /** Frames that went into the stacks: all of them, or those that see the target if `normalised`. */
  framesUsed?: number;
  refMjd: number;
  step: number;
  baselineYears: number;
  /** Number of stacks computed. */
  nStacks: number;
  elapsedMs: number;
}

/** Symmetric axis -max..max that contains 0 and has the given step. */
export function axis(max: number, step: number): number[] {
  const k = Math.floor(max / step + 1e-9);
  const out: number[] = [];
  for (let i = -k; i <= k; i++) out.push(i * step + 0);
  return out;
}

/** Highest finite SNR within `radius` pixels of (cx, cy). */
export function regionPeak(
  r: Pick<StackResult, "snr" | "w" | "h">,
  cx: number,
  cy: number,
  radius: number,
): { snr: number; x: number; y: number } {
  let best = -Infinity;
  let bx = -1;
  let by = -1;
  const r2 = radius * radius;
  for (let y = Math.max(0, Math.ceil(cy - radius)); y <= Math.min(r.h - 1, Math.floor(cy + radius)); y++) {
    for (let x = Math.max(0, Math.ceil(cx - radius)); x <= Math.min(r.w - 1, Math.floor(cx + radius)); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > r2) continue;
      const v = r.snr[y * r.w + x];
      if (v > best) {
        best = v;
        bx = x;
        by = y;
      }
    }
  }
  return { snr: best, x: bx, y: by };
}

/** Solve the linear system A x = b in place (Gaussian elimination, partial pivoting). Null if singular. */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) return null;
    [A[c], A[p]] = [A[p], A[c]];
    [b[c], b[p]] = [b[p], b[c]];
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
    x[r] = s / A[r][r];
  }
  return x;
}

/**
 * Fit z = a + b·u + c·v + d·u² + e·uv + f·v² by least squares to the cells of `score`
 * (nx columns) within `half` cells of (i0, j0), u and v in cell units relative to (i0, j0).
 * Returns the vertex offset in cells if the surface has a maximum within the window, else null.
 */
export function fitPeak(
  score: ArrayLike<number>,
  nx: number,
  ny: number,
  i0: number,
  j0: number,
  half: number,
): { du: number; dv: number } | null {
  const AtA = Array.from({ length: 6 }, () => new Array<number>(6).fill(0));
  const Atz = new Array<number>(6).fill(0);
  let m = 0;
  for (let j = Math.max(0, j0 - half); j <= Math.min(ny - 1, j0 + half); j++) {
    for (let i = Math.max(0, i0 - half); i <= Math.min(nx - 1, i0 + half); i++) {
      const z = score[j * nx + i];
      if (!Number.isFinite(z)) continue;
      const u = i - i0;
      const v = j - j0;
      const row = [1, u, v, u * u, u * v, v * v];
      for (let a = 0; a < 6; a++) {
        Atz[a] += row[a] * z;
        for (let c = 0; c < 6; c++) AtA[a][c] += row[a] * row[c];
      }
      m++;
    }
  }
  if (m < 6) return null;
  const p = solve(AtA, Atz);
  if (!p) return null;
  const [, b, c, d, e, f] = p;
  // Maximum needs a negative-definite Hessian [[2d, e], [e, 2f]].
  const det = 4 * d * f - e * e;
  if (!(d < 0 && det > 0)) return null;
  const du = (-2 * f * b + e * c) / det;
  const dv = (-2 * d * c + e * b) / det;
  if (Math.abs(du) > half || Math.abs(dv) > half) return null;
  return { du, dv };
}

/** Settings resolved from GridOptions, shared by scoreGrid and velocityGrid. */
interface Settings {
  pmRaAxis: number[];
  pmDecAxis: number[];
  refMjd: number;
  step: number;
  baselineYears: number;
  mode: StackMode;
  clipScale: StackOptions["clipScale"];
  /** Per-frame brightness (StackOptions.scale), or undefined to stack the frames as they are. */
  scale: Float64Array | undefined;
  framesUsed?: number;
  cx: number;
  cy: number;
  radius: number;
  half: number;
  region: StackOptions["region"];
  window: PixelBox | undefined;
}

/**
 * The pixels the search may use, as StackOptions.window; undefined for an infinite field. It is the
 * middle `fieldArcmin` of the w x h cube, the footprint of a static cube with that field, as long
 * as the search centre (cx, cy) lies in it: on a 61-pixel 3″ cube that is the whole cube wherever
 * the centre is, and a search inside the middle 3′ of a larger cube gives exactly what the same
 * search gives on the static cube. A centre outside it (a click far out on a wide cube, where no
 * static cube exists) gets the same size of field centred on itself.
 */
export function fieldWindow(
  cx: number,
  cy: number,
  w: number,
  h: number,
  pixscaleArcsec: number,
  fieldArcmin: number,
): PixelBox | undefined {
  if (!Number.isFinite(fieldArcmin)) return undefined;
  if (!(fieldArcmin > 0)) throw new Error(`field must be > 0 arcmin, got ${fieldArcmin}`);
  const half = Math.round((fieldArcmin * 60) / 2 / pixscaleArcsec);
  const around = (x: number, y: number): PixelBox => ({
    x0: Math.floor(x - half),
    y0: Math.floor(y - half),
    x1: Math.ceil(x + half) + 1,
    y1: Math.ceil(y + half) + 1,
  });
  const middle = around((w - 1) / 2, (h - 1) / 2);
  const inside = cx >= middle.x0 && cx < middle.x1 && cy >= middle.y0 && cy < middle.y1;
  return inside ? middle : around(cx, cy);
}

/**
 * What the grid search needs from its data: the stacked image size, the pixel scale, the frame
 * times and a way to stack for one motion. `cubeSource` wraps one cube (stack.ts); stackMulti.ts
 * wraps several detectors.
 */
export interface StackSource {
  w: number;
  h: number;
  pixscale_arcsec: number;
  /** MJD of every frame, for the time span and the default refMjd. */
  mjds: number[];
  stackAt(pmRa: number, pmDec: number, refMjd: number, mode: StackMode, options: StackOptions): StackResult;
  /** Per-frame brightness of what sits within `radius` px of (cx, cy), for StackOptions.scale, or
   *  null if single frames do not see it. A source without this method is never normalised. */
  frameScale?(cx: number, cy: number, radius: number, window?: PixelBox): Float64Array | null;
}

/** One cube as a StackSource (stack.ts). */
export function cubeSource(cube: StackableCube): StackSource {
  return {
    w: cube.w,
    h: cube.h,
    pixscale_arcsec: cube.meta.pixscale_arcsec,
    mjds: cube.meta.frames.map((f) => f.mjd),
    stackAt: (pmRa, pmDec, refMjd, mode, options) => stack(cube, pmRa, pmDec, refMjd, mode, options),
    frameScale: (cx, cy, radius, window) => brightnessScale(cube, cx, cy, radius, window),
  };
}

function resolve(src: StackSource, options: GridOptions): Settings {
  const mjds = src.mjds;
  if (mjds.length < 2) throw new Error("velocity search needs at least 2 frames");
  const baselineYears = (Math.max(...mjds) - Math.min(...mjds)) / JULIAN_YEAR_DAYS;
  if (!(baselineYears > 0)) throw new Error("all frames have the same MJD: motion cannot be measured");

  const pmMax = options.pmMax ?? 15;
  const step = options.step ?? src.pixscale_arcsec / baselineYears;
  if (!(step > 0) || !(pmMax >= 0)) throw new Error("step must be > 0 and pmMax >= 0");
  const cx = options.centerX ?? (src.w - 1) / 2;
  const cy = options.centerY ?? (src.h - 1) / 2;
  const radius = options.radius ?? 4;
  const box = Math.max(options.noiseBox ?? Infinity, radius + 1);
  const fieldBox = fieldWindow(cx, cy, src.w, src.h, src.pixscale_arcsec, options.field ?? STATIC_FIELD_ARCMIN);
  const scale =
    (options.normalise ?? "auto") === "auto" ? (src.frameScale?.(cx, cy, radius, fieldBox) ?? undefined) : undefined;
  let framesUsed = mjds.length;
  if (scale) {
    framesUsed = 0;
    for (let f = 0; f < scale.length; f++) if (scale[f] > 0 && Number.isFinite(scale[f])) framesUsed++;
  }
  return {
    scale,
    framesUsed,
    pmRaAxis: axis(pmMax, step),
    pmDecAxis: axis(pmMax, step),
    refMjd: options.refMjd ?? mjds.reduce((a, b) => a + b, 0) / mjds.length,
    step,
    baselineYears,
    mode: options.mode ?? "clipped",
    clipScale: options.clipScale,
    cx,
    cy,
    radius,
    half: options.fitHalfWidth ?? 2,
    region: Number.isFinite(box)
      ? { x0: Math.floor(cx - box), y0: Math.floor(cy - box), x1: Math.ceil(cx + box) + 1, y1: Math.ceil(cy + box) + 1 }
      : undefined,
    window: fieldBox,
  };
}

/** Stack with one vector and score it. */
function scoreVector(
  src: StackSource,
  s: Settings,
  pmRa: number,
  pmDec: number,
): { score: VectorScore; result: StackResult } {
  // On a common brightness the target's flux agrees between frames, so what is left to clip are
  // cosmic rays; the scale is then the pixel's own spread (PSF sampling differences between frames
  // are far above the noise on a bright target), never below the frame noise.
  const options: StackOptions = s.scale
    ? { region: s.region, window: s.window, clipScale: "pixel", scale: s.scale }
    : { region: s.region, window: s.window, clipScale: s.clipScale };
  const result = src.stackAt(pmRa, pmDec, s.refMjd, s.mode, options);
  return { score: { pmRa, pmDec, ...regionPeak(result, s.cx, s.cy, s.radius) }, result };
}

interface Scored {
  score: Float32Array;
  cells: VectorScore[];
  top: { score: VectorScore; result: StackResult; i: number; j: number };
  zero: VectorScore;
}

/** Score every vector of the grid; `onStack` is called after each stack. */
function scoreAll(src: StackSource, s: Settings, onStack: () => void): Scored {
  const nx = s.pmRaAxis.length;
  const ny = s.pmDecAxis.length;
  const score = new Float32Array(nx * ny);
  const cells: VectorScore[] = [];
  let top: Scored["top"] | null = null;
  let zero: VectorScore | null = null;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const e = scoreVector(src, s, s.pmRaAxis[i], s.pmDecAxis[j]);
      onStack();
      score[j * nx + i] = e.score.snr;
      cells.push(e.score);
      if (top === null || e.score.snr > top.score.snr) top = { ...e, i, j };
      if (e.score.pmRa === 0 && e.score.pmDec === 0) zero = e.score;
    }
  }
  // axis() always contains an exact 0, so the zero vector is a grid cell.
  if (top === null || zero === null) throw new Error("empty grid");
  return { score, cells, top, zero };
}

/** Grid scores without the peak fit: what falseAlarm (significance.ts) repeats for every shuffle. */
export interface ScoreGrid {
  pmRaAxis: number[];
  pmDecAxis: number[];
  /** score[iDec * pmRaAxis.length + iRa], as in GridResult. */
  score: Float32Array;
  /** Every vector with its score and pixel, same order as `score`. */
  cells: VectorScore[];
  gridBest: VectorScore;
  /** Score of the zero vector (no motion). */
  zero: VectorScore;
  /** As in GridResult. */
  normalised?: boolean;
  framesUsed?: number;
  refMjd: number;
  step: number;
  baselineYears: number;
  nStacks: number;
}

/** Score every vector on the grid (one stack each), without the quadratic peak fit. */
export function scoreGrid(cube: StackableCube, options: GridOptions = {}): ScoreGrid {
  return scoreGridOn(cubeSource(cube), options);
}

/** scoreGrid on any StackSource. */
export function scoreGridOn(src: StackSource, options: GridOptions = {}): ScoreGrid {
  const s = resolve(src, options);
  const total = s.pmRaAxis.length * s.pmDecAxis.length;
  let done = 0;
  const g = scoreAll(src, s, () => {
    done++;
    options.onProgress?.(done, total);
  });
  return {
    pmRaAxis: s.pmRaAxis,
    pmDecAxis: s.pmDecAxis,
    score: g.score,
    cells: g.cells,
    gridBest: g.top.score,
    zero: g.zero,
    normalised: s.scale !== undefined,
    framesUsed: s.framesUsed,
    refMjd: s.refMjd,
    step: s.step,
    baselineYears: s.baselineYears,
    nStacks: done,
  };
}

/** Run the velocity grid search on a cube. Synchronous; call it from a Web Worker in the UI. */
export function velocityGrid(cube: StackableCube, options: GridOptions = {}): GridResult {
  return velocityGridOn(cubeSource(cube), options);
}

/** velocityGrid on any StackSource (e.g. several detectors, stackMulti.ts). */
export function velocityGridOn(src: StackSource, options: GridOptions = {}): GridResult {
  const t0 = performance.now();
  const s = resolve(src, options);
  const nx = s.pmRaAxis.length;
  const ny = s.pmDecAxis.length;
  const total = nx * ny + 1;
  let done = 0;
  const tick = () => {
    done++;
    options.onProgress?.(done, total);
  };
  const g = scoreAll(src, s, tick);

  let best = g.top.score;
  let bestStack = g.top.result;
  const vertex = fitPeak(g.score, nx, ny, g.top.i, g.top.j, s.half);
  if (vertex) {
    const e = scoreVector(src, s, g.top.score.pmRa + vertex.du * s.step, g.top.score.pmDec + vertex.dv * s.step);
    tick();
    best = e.score;
    bestStack = e.result;
  } else {
    options.onProgress?.(total, total);
  }

  return {
    pmRaAxis: s.pmRaAxis,
    pmDecAxis: s.pmDecAxis,
    score: g.score,
    gridBest: g.top.score,
    best,
    fitted: vertex !== null,
    bestStack,
    normalised: s.scale !== undefined,
    framesUsed: s.framesUsed,
    refMjd: s.refMjd,
    step: s.step,
    baselineYears: s.baselineYears,
    nStacks: done,
    elapsedMs: performance.now() - t0,
  };
}
