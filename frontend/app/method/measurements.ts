// What the /method page says about role A's measurements, read from the measure.json files next to
// the static cubes (data/cubes/<id>/<band>/measure.json), never typed in by hand (task P-08).
// The page reads them once at build time, so the static HTML shows exactly the shipped files.

import { readFileSync } from "node:fs";
import path from "node:path";
import { findStory } from "../../content/stories";
import { DEMO_OBJECTS } from "../../lib/objects";

/** The part of measure.json the page uses (data/photometry.py, data/motion.py). */
interface MeasureJson {
  band: string;
  n_frames: number;
  n_used: number;
  saturated: boolean;
  method: string;
  motion: { pm_ra: number; pm_dec: number; err_ra: number; err_dec: number; status: "ok" | "unverified"; note: string } | null;
  source: { from_cache: boolean; releases?: Record<string, number> };
  photometry_method: "aperture" | "wing";
  photometry_unit: string;
  photometry_note: string;
  light_curves?: { lam_min: number; lam_max: number; points: { flux: number }[] }[];
}

export interface Measurement {
  id: string;
  name: string;
  kind: "moves" | "varies";
  band: string;
  images: number;
  imagesUsed: number;
  saturated: boolean;
  /** Position method, as measure.json states it. */
  method: string;
  motion: { pmRa: number; pmDec: number; errRa: number; errDec: number; confirmed: boolean; note: string } | null;
  catalogue: { pmRa: number; pmDec: number; source: string } | null;
  photometryMethod: "aperture" | "wing";
  photometryUnit: string;
  photometryNote: string;
  /** Width of the light-curve wavelength bins, micrometres. */
  binWidthUm: number | null;
  /** Brightest / faintest visit in the wavelength bin the object's story quotes (varying objects). */
  brightness: { factor: number; lamMin: number; lamMax: number } | null;
  /** Images per data release (dr1, qr3, ...). */
  releases: Record<string, number>;
  fromCache: boolean;
}

/** Same source as deploy/copy-cubes.mjs: OSU_CUBES_DIR, else the repository's data/cubes. */
export function cubesDir(): string {
  return process.env.OSU_CUBES_DIR ? path.resolve(process.env.OSU_CUBES_DIR) : path.resolve(process.cwd(), "..", "data", "cubes");
}

export function readMeasurements(dir: string = cubesDir()): Measurement[] {
  return DEMO_OBJECTS.map((o) => {
    const m = JSON.parse(readFileSync(path.join(dir, o.id, o.band, "measure.json"), "utf8")) as MeasureJson;
    if (m.band !== o.band) throw new Error(`${o.id}: measure.json is for ${m.band}, expected ${o.band}`);
    const curves = m.light_curves ?? [];
    const widths = [...new Set(curves.map((c) => Number((c.lam_max - c.lam_min).toFixed(4))))];
    if (widths.length > 1) throw new Error(`${o.id}: light-curve bins of different widths ${widths.join(", ")}`);

    let brightness: Measurement["brightness"] = null;
    const bin = findStory(o.id)?.numbers.brightnessBin;
    if (o.kind === "varies" && bin != null) {
      const c = curves.find((cv) => Math.abs(cv.lam_min - bin) < 1e-6);
      if (!c) throw new Error(`${o.id}: no light curve at ${bin} um`);
      const flux = c.points.map((p) => p.flux);
      brightness = { factor: Math.max(...flux) / Math.min(...flux), lamMin: c.lam_min, lamMax: c.lam_max };
    }

    return {
      id: o.id,
      name: o.name,
      kind: o.kind,
      band: m.band,
      images: m.n_frames,
      imagesUsed: m.n_used,
      saturated: m.saturated,
      method: m.method,
      motion: m.motion && {
        pmRa: m.motion.pm_ra,
        pmDec: m.motion.pm_dec,
        errRa: m.motion.err_ra,
        errDec: m.motion.err_dec,
        confirmed: m.motion.status === "ok",
        note: m.motion.note,
      },
      catalogue: o.catalogueMotion ?? null,
      photometryMethod: m.photometry_method,
      photometryUnit: m.photometry_unit,
      photometryNote: m.photometry_note,
      binWidthUm: widths[0] ?? null,
      brightness,
      releases: m.source.releases ?? {},
      fromCache: m.source.from_cache,
    };
  });
}
