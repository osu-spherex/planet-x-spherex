// Cube loader and frame rendering for the canvas viewer (role B, task B-01).
//
// A "cube" is N aligned SPHEREx cutouts on one grid, made by data/cube.py:
//   cube.json  metadata (docs/ARCHITECTURE.md, "Интерфейс"; details in data/cubes/README.md)
//   cube.f32   little-endian Float32, N x H x W, MJy/sr, NaN = no valid data
// Row y = 0 is the north edge and column x = 0 the east edge, so drawing rows top-down gives
// the usual sky view (north up, east left). Pixel (n, y, x) is data[n * H * W + y * W + x].
//
// The cube is for display only. Positions and fluxes are measured in Python on the raw cutouts.

export interface CubeFrame {
  /** IRSA file name without extension. */
  id: string;
  /** Detector, "D1".."D6". */
  band: string;
  /** Start of the exposure (MJD). */
  mjd: number;
  /** Wavelength at the object's position (um). Differs from frame to frame (LVF). */
  lam_um: number;
  /** Robust background sigma of this frame, MJy/sr. */
  noise: number;
  /** Fraction of NaN pixels, 0..1. */
  nan_frac: number;
  /** Index of the time group (gaps > 20 days). Static cubes have it; do not rely on it. */
  epoch?: number;
  /** Background level that was subtracted, MJy/sr. */
  bg?: number;
  /** Flags near the centre (ARCHITECTURE "Интерфейсийн нэмэлт", A-09): share of flagged pixels
   *  within 15″ and the bits set there. */
  flags?: { any_frac: number; center_bits: number[] };
}

export interface CubeEpoch {
  epoch: number;
  n: number;
  mjd_min: number;
  mjd_max: number;
}

export interface CubeMeta {
  center: { ra: number; dec: number };
  pixscale_arcsec: number;
  shape: [number, number, number];
  frames: CubeFrame[];
  data_url: string;
  // Additions written by data/cube.py; optional so that any cube matching the interface loads.
  object?: string;
  band?: string;
  bunit?: string;
  orientation?: string;
  epochs?: CubeEpoch[];
  source?: { archive?: string; from_cache?: boolean; downloaded_utc?: string[] };
  /** Present on backend responses: "done" when the cube is ready. */
  status?: string;
  /** Field width, arcmin (3, 6 or 10); shape is fov * 20 + 1 pixels at 3″. */
  fov_arcmin?: number;
  /** Bit number -> flag name. */
  flag_names?: Record<string, string>;
  /** Uint8 flag mask next to cube.json, N x H x W, 1 = some flag on that pixel. */
  flags_url?: string;
  /** Images left out of the cube, with the reason (A-08), e.g. no wavelength defined at the position. */
  skipped?: { id: string; mjd: number; why: string }[];
}

export interface Cube {
  meta: CubeMeta;
  /** All pixels, N x H x W. */
  data: Float32Array;
  n: number;
  h: number;
  w: number;
}

/**
 * The backend answered, but the cube is still being built (GET /api/cube returns
 * { status, progress } until it is done). Callers poll the same URL again.
 */
export class CubeNotReadyError extends Error {
  readonly status: string;
  readonly progress: number | null;
  constructor(status: string, progress: number | null) {
    super(`cube is not ready yet (status: ${status})`);
    this.name = "CubeNotReadyError";
    this.status = status;
    this.progress = progress;
  }
}

/**
 * Resolve cube.json's data_url against the URL the JSON came from. Works for a relative
 * data_url next to a static cube.json ("cube.f32") and for the backend's absolute path
 * ("/api/cubes/<key>/cube.f32"). A site-relative JSON URL gives a site-relative result.
 */
export function resolveDataUrl(dataUrl: string, jsonUrl: string): string {
  const placeholder = "http://relative.invalid";
  const resolved = new URL(dataUrl, new URL(jsonUrl, placeholder));
  return resolved.origin === placeholder ? resolved.pathname + resolved.search : resolved.href;
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/**
 * Fetch cube.json and its Float32 data.
 * Throws CubeNotReadyError while the backend is still working, and Error on HTTP errors or
 * when the files do not agree with each other (so a broken cube never reaches the canvas).
 */
export async function loadCube(url: string, fetchImpl: typeof fetch = fetch): Promise<Cube> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`could not load ${url}: HTTP ${res.status} ${res.statusText}`.trim());
  const meta = (await res.json()) as CubeMeta & { progress?: number };

  if (!Array.isArray(meta.shape)) {
    if (typeof meta.status === "string" && meta.status !== "done") {
      throw new CubeNotReadyError(meta.status, typeof meta.progress === "number" ? meta.progress : null);
    }
    throw new Error(`${url} is not a cube: no "shape"`);
  }
  if (meta.shape.length !== 3 || !meta.shape.every(isPositiveInt)) {
    throw new Error(`${url} has an unusable shape: ${JSON.stringify(meta.shape)}`);
  }
  const [n, h, w] = meta.shape;
  if (!Array.isArray(meta.frames) || meta.frames.length !== n) {
    throw new Error(`${url} lists ${meta.frames?.length ?? 0} frames but shape says ${n}`);
  }
  if (typeof meta.data_url !== "string" || meta.data_url === "") {
    throw new Error(`${url} has no data_url`);
  }

  const dataUrl = resolveDataUrl(meta.data_url, url);
  const dataRes = await fetchImpl(dataUrl);
  if (!dataRes.ok) {
    throw new Error(`could not load ${dataUrl}: HTTP ${dataRes.status} ${dataRes.statusText}`.trim());
  }
  const buf = await dataRes.arrayBuffer();
  const expected = n * h * w * 4;
  if (buf.byteLength !== expected) {
    throw new Error(
      `cube data is ${buf.byteLength} bytes, expected ${expected} bytes (${n} x ${h} x ${w} float32)`,
    );
  }
  // The file is little-endian, like every platform browsers run on, so no byte swapping.
  return { meta, data: new Float32Array(buf), n, h, w };
}

/** Frame i as a view into the cube (no copy), H x W in row-major order. */
export function getFrame(cube: Cube, i: number): Float32Array {
  if (!Number.isInteger(i) || i < 0 || i >= cube.n) {
    throw new RangeError(`frame ${i} is outside 0..${cube.n - 1}`);
  }
  const size = cube.h * cube.w;
  return cube.data.subarray(i * size, (i + 1) * size);
}

/** Valid (finite) pixels, sorted ascending. */
function sortedFinite(values: Float32Array): Float32Array {
  const finite = values.filter((v) => Number.isFinite(v));
  return finite.sort();
}

function percentileOfSorted(sorted: Float32Array, p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const pos = (Math.min(100, Math.max(0, p)) / 100) * (sorted.length - 1);
  const below = Math.floor(pos);
  const above = Math.min(below + 1, sorted.length - 1);
  return sorted[below] + (sorted[above] - sorted[below]) * (pos - below);
}

/**
 * p-th percentile (0..100) of the valid pixels, linear interpolation between ranks
 * (same definition as numpy.percentile). NaN if there is no valid pixel.
 */
export function percentile(values: Float32Array, p: number): number {
  return percentileOfSorted(sortedFinite(values), p);
}

export interface StretchLimits {
  lo: number;
  hi: number;
}

/** Display limits: by default the 1st and 99.5th percentile of the valid pixels (task B-01). */
export function stretchLimits(frame: Float32Array, loPct = 1, hiPct = 99.5): StretchLimits {
  const sorted = sortedFinite(frame);
  return { lo: percentileOfSorted(sorted, loPct), hi: percentileOfSorted(sorted, hiPct) };
}

export type StretchMode = "linear" | "asinh";

// asinh stretch (Lupton et al. 2004, PASP 116, 133: https://doi.org/10.1086/382245):
// near-linear for faint pixels, logarithmic for bright ones, so faint sources stay visible
// next to a bright star. The softening 10 puts the turnover at a tenth of the range.
const ASINH_SOFTENING = 10;
const ASINH_NORM = Math.asinh(ASINH_SOFTENING);

/** Map a pixel value to 0..1 between lo and hi (clipped). 0 if the limits are degenerate. */
export function stretchValue(v: number, lo: number, hi: number, mode: StretchMode): number {
  const range = hi - lo;
  if (!(range > 0)) return 0;
  const t = Math.min(1, Math.max(0, (v - lo) / range));
  return mode === "asinh" ? Math.asinh(ASINH_SOFTENING * t) / ASINH_NORM : t;
}

/**
 * Colour of pixels without valid data (NaN): a blue-tinted grey. It is deliberately not a
 * neutral grey, so it can never be mistaken for a measured grey level of the image.
 */
export const NAN_RGB: readonly [number, number, number] = [58, 66, 92];

/**
 * Turn one frame into RGBA bytes for canvas ImageData (same pixel order as the frame).
 * Valid pixels become grey levels between limits.lo (black) and limits.hi (white);
 * NaN pixels get NAN_RGB. Pass `out` to reuse a buffer between frames.
 */
export function renderFrame(
  frame: Float32Array,
  limits: StretchLimits,
  mode: StretchMode = "linear",
  out?: Uint8ClampedArray,
): Uint8ClampedArray {
  const rgba = out ?? new Uint8ClampedArray(frame.length * 4);
  const limitsOk = Number.isFinite(limits.lo) && Number.isFinite(limits.hi);
  for (let i = 0, j = 0; i < frame.length; i++, j += 4) {
    const v = frame[i];
    if (!limitsOk || !Number.isFinite(v)) {
      rgba[j] = NAN_RGB[0];
      rgba[j + 1] = NAN_RGB[1];
      rgba[j + 2] = NAN_RGB[2];
    } else {
      const grey = Math.round(255 * stretchValue(v, limits.lo, limits.hi, mode));
      rgba[j] = grey;
      rgba[j + 1] = grey;
      rgba[j + 2] = grey;
    }
    rgba[j + 3] = 255;
  }
  return rgba;
}

/** MJD 40587.0 = 1970-01-01T00:00:00Z (JD 2440587.5; MJD = JD - 2400000.5). */
const MJD_UNIX_EPOCH = 40587;

export function mjdToDate(mjd: number): Date {
  return new Date((mjd - MJD_UNIX_EPOCH) * 86_400_000);
}

/** Calendar date (UTC) of an MJD, "YYYY-MM-DD". */
export function mjdToIsoDate(mjd: number): string {
  return mjdToDate(mjd).toISOString().slice(0, 10);
}
