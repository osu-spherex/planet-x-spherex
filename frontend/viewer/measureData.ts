// Measurements next to a cube (role B, task B-04): motion, light curves, spectrum.
//
// Static files: /cubes/<obj>/<band>/measure.json, written by role A (data/measure_static.py, A-07).
// Same shape as GET /api/measure (docs/ARCHITECTURE.md "Интерфейс"; fields listed in Issue #18):
//   data/motion.py      epochs, motion, saturated, dra/ddec_arcsec, years, frames
//   data/photometry.py  photometry, photometry_method, photometry_unit, photometry_note, light_curves
// Every number here was measured in Python on the raw cutouts. This file only reads and arranges
// them for display; it never computes a measurement of its own.

import { JULIAN_YEAR_DAYS } from "../search/stack";

export interface MeasureEpoch {
  epoch: number;
  mjd: number;
  /** Frames that went into this epoch's position. */
  n: number;
  /** Offset from the reference position (cube centre), arcsec; east = +RA. */
  dra_arcsec: number;
  ddec_arcsec: number;
  err_ra: number;
  err_dec: number;
}

export interface MeasureMotion {
  /** arcsec/yr, includes cos(Dec). */
  pm_ra: number;
  pm_dec: number;
  err_ra: number;
  err_dec: number;
  n_epochs: number;
  /** "ok" or "unverified" (A-07). Absent in older files: treat as "ok". */
  status?: string;
  /** Why a measurement is not confirmed, in plain words. */
  note?: string;
  /** Catalogue parallax held fixed in the fit (A-14), arcsec; 0 = a plain straight line. */
  parallax_arcsec?: number;
  /** "Gaia DR3 <id>". */
  parallax_source?: string | null;
  /** The same fit without the parallax (the older numbers). */
  no_parallax?: { pm_ra: number; pm_dec: number; err_ra: number; err_dec: number } | null;
}

/** /cubes/<obj>/motion.json (A-14): all detectors together; only what the panel reads. */
export interface MotionFile {
  /** Catalogue (Gaia) parallax, arcsec. */
  parallax_arcsec?: number;
  parallax_source?: string | null;
  /** Parallax measured from SPHEREx alone; distance_pc null when not measured. */
  parallax_measured?: { parallax_arcsec: number; err: number; distance_pc: number | null; bands?: string[] } | null;
}

/** motion.json next to the band folders of a static cube; null for other URLs. */
export function motionUrlFor(cubeUrl: string): string | null {
  const [path, query] = cubeUrl.split("?");
  const m = query === undefined ? path.match(/^((?:.*\/)?cubes\/[^/]+\/)[^/]+\/cube\.json$/) : null;
  return m ? `${m[1]}motion.json` : null;
}

/** "Gaia DR3 4472…" -> "Gaia DR3". */
const shortSource = (s: string | null | undefined) => (s ?? "catalogue").split(" ").slice(0, 2).join(" ");
const signed2 = (v: number) => (v < 0 ? `−${(-v).toFixed(2)}` : `+${v.toFixed(2)}`);

/**
 * B-14 (#104): "Yearly parallax swing of 0.547″ (Gaia DR3) taken out. Without it: east −1.38 ± 1.54,
 * north +9.97 ± 0.51″/yr." Empty without a parallax or for an unconfirmed motion.
 */
export function parallaxLine(m: MeasureMotion | null): string {
  if (!m || !motionConfirmed(m) || !(m.parallax_arcsec && m.parallax_arcsec > 0)) return "";
  const np = m.no_parallax;
  const without = np
    ? ` Without it: east ${signed2(np.pm_ra)} ± ${np.err_ra.toFixed(2)}, north ${signed2(np.pm_dec)} ± ${np.err_dec.toFixed(2)}″/yr.`
    : "";
  return `Yearly parallax swing of ${m.parallax_arcsec.toFixed(3)}″ (${shortSource(m.parallax_source)}) taken out.${without}`;
}

/**
 * B-14 (#104): the distance from SPHEREx alone, next to the catalogue's, when motion.json has one
 * (Epsilon Indi B). Distance error from the parallax error: d = 1/p, σd = σp / p². Empty otherwise.
 */
export function distanceLine(f: MotionFile | null): string {
  const pm = f?.parallax_measured;
  if (!pm || pm.distance_pc === null || !(pm.parallax_arcsec > 0)) return "";
  const errPc = pm.err / (pm.parallax_arcsec * pm.parallax_arcsec);
  const cat =
    f!.parallax_arcsec && f!.parallax_arcsec > 0
      ? `; ${shortSource(f!.parallax_source)}: ${(1 / f!.parallax_arcsec).toFixed(2)} pc (${f!.parallax_arcsec.toFixed(3)}″)`
      : "";
  const n = pm.bands?.length ? `, ${pm.bands.length} detectors` : "";
  return `Distance from SPHEREx alone: ${pm.distance_pc.toFixed(1)} ± ${errPc.toFixed(1)} pc (parallax ${pm.parallax_arcsec.toFixed(2)} ± ${pm.err.toFixed(2)}″${n})${cat}.`;
}

/** Fetch motion.json; null when missing or unreadable (nothing is shown then). */
export async function loadMotionFile(url: string, fetchImpl: typeof fetch = fetch): Promise<MotionFile | null> {
  try {
    const res = await fetchImpl(url);
    return res.ok ? ((await res.json()) as MotionFile) : null;
  } catch {
    return null;
  }
}

export interface PhotometryPoint {
  id?: string;
  mjd: number;
  epoch?: number;
  lam_um: number;
  /** null when ok is false. */
  flux: number | null;
  err: number | null;
  ok: boolean;
  why?: string;
}

export interface LightCurve {
  lam_min: number;
  lam_max: number;
  points: { mjd: number; flux: number; err: number; n: number }[];
}

export interface Measure {
  object?: string;
  band?: string;
  saturated?: boolean;
  epochs: MeasureEpoch[];
  motion: MeasureMotion | null;
  method?: string;
  photometry: PhotometryPoint[];
  photometry_method?: "aperture" | "wing";
  photometry_unit?: string;
  photometry_note?: string;
  light_curves?: LightCurve[];
  source?: { archive?: string; from_cache?: boolean };
}

/** measure.json next to a static cube.json; null for other URLs (e.g. /api/cube?...). */
export function measureUrlFor(cubeUrl: string): string | null {
  const [path, query] = cubeUrl.split("?");
  if (query !== undefined || !path.endsWith("/cube.json")) return null;
  return path.slice(0, -"cube.json".length) + "measure.json";
}

/**
 * Fetch measure.json. Resolves to null when there is no file (HTTP 404): measurements for this
 * position have not been made yet. Throws on other errors and on a file without `epochs`.
 */
export async function loadMeasure(url: string, fetchImpl: typeof fetch = fetch): Promise<Measure | null> {
  const res = await fetchImpl(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`could not load ${url}: HTTP ${res.status} ${res.statusText}`.trim());
  const m = (await res.json()) as Partial<Measure>;
  if (!Array.isArray(m.epochs)) throw new Error(`${url} is not a measurement file: no "epochs"`);
  return {
    ...m,
    epochs: m.epochs,
    motion: m.motion ?? null,
    photometry: Array.isArray(m.photometry) ? m.photometry : [],
  } as Measure;
}

/** True unless the file says the motion is not confirmed. */
export function motionConfirmed(m: MeasureMotion): boolean {
  return m.status === undefined || m.status === "ok";
}

/** Valid photometry points (ok, finite flux and wavelength), for the spectrum. */
export function spectrumPoints(m: Measure): { lam: number; flux: number; err: number; mjd: number; epoch?: number }[] {
  return m.photometry
    .filter((p) => p.ok && Number.isFinite(p.flux) && Number.isFinite(p.lam_um))
    .map((p) => ({ lam: p.lam_um, flux: p.flux as number, err: Number.isFinite(p.err) ? (p.err as number) : 0, mjd: p.mjd, epoch: p.epoch }));
}

/**
 * Default light curve to show: the wavelength bin with the most visits, ties to the shorter
 * wavelength. -1 if there is none.
 */
export function defaultLightCurve(curves: readonly LightCurve[] | undefined): number {
  if (!curves || curves.length === 0) return -1;
  let best = 0;
  for (let i = 1; i < curves.length; i++) {
    const a = curves[i].points.length;
    const b = curves[best].points.length;
    if (a > b || (a === b && curves[i].lam_min < curves[best].lam_min)) best = i;
  }
  return best;
}

/**
 * Straight line with a given slope (arcsec/yr) through the error-weighted mean of the points:
 * offset(t) = c + slope * (t - t0) / JULIAN_YEAR_DAYS. Used to draw the measured and the catalogue motion
 * over the epoch positions. Returns null without usable points.
 */
export function lineThrough(
  pts: readonly { t: number; v: number; err: number }[],
  slopePerYear: number,
): { at: (mjd: number) => number } | null {
  let sw = 0;
  let st = 0;
  let sv = 0;
  for (const p of pts) {
    if (!Number.isFinite(p.t) || !Number.isFinite(p.v)) continue;
    const w = p.err > 0 && Number.isFinite(p.err) ? 1 / (p.err * p.err) : 1;
    sw += w;
    st += w * p.t;
    sv += w * p.v;
  }
  if (sw === 0) return null;
  const t0 = st / sw;
  const c = sv / sw;
  return { at: (mjd: number) => c + (slopePerYear * (mjd - t0)) / JULIAN_YEAR_DAYS };
}

/**
 * The note of an unconfirmed motion without its own "Not a confirmed measurement:" opening, which
 * the panel already shows as a heading; first letter capitalised. Empty for no note.
 */
export function noteWithoutHeading(note: string | undefined): string {
  const rest = (note ?? "").replace(/^\s*not a confirmed measurement\s*[:.,-]?\s*/i, "").trim();
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}
