// Overlay data for the viewer (role B, task B-07): catalogue sources, flagged pixels, processing
// release. Formats: docs/ARCHITECTURE.md, "Интерфейсийн нэмэлт" (2026-11-14 14:30):
//
//   /cubes/<obj>/catalog.json  { center:{ra,dec}, radius_arcsec,
//       sources:[{ cat:"gaia_dr3"|"catwise2020", id, ra, dec, epoch, pm_ra, pm_dec, mag, mag_band }],
//       source:{ archive, queried_utc } }       // epoch in years (Gaia DR3: 2016.0); pm in arcsec/yr, pm_ra with cos(dec)
//   cube.json  flag_names:{ "<bit>": "<name>" }, frames[].flags:{ any_frac, center_bits:[bit,…] },
//              flags_url:"flags.u8"             // Uint8, N x H x W, 1 = some flag on that pixel
//
// Nothing here is measured: catalogue positions are moved to each frame's date with the
// catalogue's own proper motion, for display. Missing files mean "no layer", never made-up data.

import type { Cube, CubeMeta } from "./cube";
import { JULIAN_YEAR_DAYS } from "../search/stack";

export type CatalogName = "gaia_dr3" | "catwise2020";

export interface CatalogSource {
  cat: CatalogName | string;
  id: string | number;
  ra: number;
  dec: number;
  /** Epoch of ra/dec, Julian years (e.g. 2016.0). */
  epoch: number;
  /** arcsec/yr, pm_ra includes cos(dec); null when the catalogue has none. */
  pm_ra: number | null;
  pm_dec: number | null;
  mag: number | null;
  mag_band: string | null;
}

export interface Catalog {
  center: { ra: number; dec: number };
  radius_arcsec: number;
  sources: CatalogSource[];
  source?: { archive?: string; queried_utc?: string };
}

/** Sources moving at least this fast get an arrow (task B-07). */
export const PM_ARROW_MIN = 0.5;

/** Catalogue search radius per arcminute of field width: 50″, i.e. 150″ for the 3′ field as in the
 *  static catalog.json files (half the diagonal of a 3′ square is 127″). */
export const CATALOG_RADIUS_PER_ARCMIN = 50;

/**
 * Where the catalogue for a cube lives:
 * - static cube  /cubes/<obj>/<band>/cube.json            -> /cubes/<obj>/catalog.json
 * - live cube    <base>/api/cube?ra=..&dec=..[&fov=6]..  -> <base>/api/catalog?ra=..&dec=..&radius=<fov * 50>
 *   (GET /api/catalog, ARCHITECTURE "Интерфейсийн нэмэлт"; same answer format as catalog.json)
 * null for anything else.
 */
export function catalogUrlFor(cubeUrl: string): string | null {
  const [path, query] = cubeUrl.split("?");
  if (query === undefined) {
    // Only the static layout cubes/<obj>/<band>/cube.json; a backend first look
    // (<base>/api/cubes/<key>/cube.json, C-10) has no catalogue file next to it.
    const m = path.match(/^((?:.*\/)?cubes\/[^/]+\/)[^/]+\/cube\.json$/);
    return m ? `${m[1]}catalog.json` : null;
  }
  if (!path.endsWith("/api/cube")) return null;
  const q = new URLSearchParams(query);
  const ra = q.get("ra");
  const dec = q.get("dec");
  if (ra === null || dec === null) return null;
  const fov = Number(q.get("fov") ?? 3) || 3;
  const out = new URLSearchParams({ ra, dec, radius: String(fov * CATALOG_RADIUS_PER_ARCMIN) });
  return `${path.slice(0, -"/api/cube".length)}/api/catalog?${out.toString()}`;
}

/** Fetch a JSON file; null on 404 (no such layer). */
async function fetchJson<T>(url: string, fetchImpl: typeof fetch): Promise<T | null> {
  const res = await fetchImpl(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`could not load ${url}: HTTP ${res.status} ${res.statusText}`.trim());
  return (await res.json()) as T;
}

export async function loadCatalog(url: string, fetchImpl: typeof fetch = fetch): Promise<Catalog | null> {
  const c = await fetchJson<Partial<Catalog>>(url, fetchImpl);
  if (c === null) return null;
  if (!Array.isArray(c.sources)) throw new Error(`${url} is not a catalogue: no "sources"`);
  return c as Catalog;
}

/** Julian epoch of an MJD: J2000.0 = MJD 51544.5, years of 365.25 days (IAU). */
export function mjdToJulianYear(mjd: number): number {
  return 2000 + (mjd - 51544.5) / JULIAN_YEAR_DAYS;
}

/**
 * Pixel position (fractional, pixel centres at integers) of a catalogue source on the cube grid at
 * `mjd`. The source is moved by its proper motion from its catalogue epoch; without a proper
 * motion it stays put. Cube grid (data/cubes/README.md): centre pixel ((W-1)/2, (H-1)/2) is
 * center.ra/dec, north up (row 0), east left (column 0), pixscale arcsec per pixel. Flat-sky
 * offsets (dRA cos dec, dDec): error < 0.01″ over a 10′ field.
 */
export function sourcePixel(
  s: Pick<CatalogSource, "ra" | "dec" | "epoch" | "pm_ra" | "pm_dec">,
  mjd: number,
  meta: Pick<CubeMeta, "center" | "pixscale_arcsec">,
  w: number,
  h: number,
): { x: number; y: number } {
  const dt = mjdToJulianYear(mjd) - s.epoch;
  const cosDec = Math.cos((meta.center.dec * Math.PI) / 180);
  let dra = (s.ra - meta.center.ra) * 3600; // arcsec of RA
  if (dra > 180 * 3600) dra -= 360 * 3600;
  if (dra < -180 * 3600) dra += 360 * 3600;
  const east = dra * cosDec + (s.pm_ra ?? 0) * dt;
  const north = (s.dec - meta.center.dec) * 3600 + (s.pm_dec ?? 0) * dt;
  return {
    x: (w - 1) / 2 - east / meta.pixscale_arcsec,
    y: (h - 1) / 2 - north / meta.pixscale_arcsec,
  };
}

/** Total proper motion, arcsec/yr; 0 without one. */
export function totalPm(s: Pick<CatalogSource, "pm_ra" | "pm_dec">): number {
  return Math.hypot(s.pm_ra ?? 0, s.pm_dec ?? 0);
}

// ---------- which sources to draw (task B-10) ----------

/** "Moving sources": catalogue proper motion at least this, arcsec/yr. A 3′ field holds 30-765
 *  catalogue sources but only 0-3 above this (Barnard 1, WISE 0855 3, eps Ind B 1, checked 11/14). */
export const MOVING_PM_MIN = 0.1;
/** "All sources": at most this many, the brightest. */
export const ALL_SOURCES_MAX = 40;

export type LayerMode = "moving" | "all";

export interface SourceSelection {
  sources: CatalogSource[];
  /** Sources in the catalogue. */
  total: number;
  /** Of those, how many move (pm >= MOVING_PM_MIN). */
  moving: number;
}

export const isMoving = (s: Pick<CatalogSource, "pm_ra" | "pm_dec">) => totalPm(s) >= MOVING_PM_MIN;

/** Stable identity of a catalogue source. */
export const sourceKey = (s: Pick<CatalogSource, "cat" | "id">) => `${s.cat}:${s.id}`;

/**
 * - moving: every source with pm >= MOVING_PM_MIN.
 * - all:    the ALL_SOURCES_MAX brightest, plus every moving one. Gaia G and CatWISE W2 are
 *           different bands, so each catalogue is ranked by its own magnitude and the two lists
 *           are taken in turn (1st Gaia, 1st CatWISE, 2nd Gaia, ...); no magnitude means last.
 */
export function selectSources(catalog: Pick<Catalog, "sources">, mode: LayerMode, max = ALL_SOURCES_MAX): SourceSelection {
  const all = catalog.sources;
  const moving = all.filter(isMoving);
  if (mode === "moving") return { sources: moving, total: all.length, moving: moving.length };
  const byMag = (a: CatalogSource, b: CatalogSource) => (a.mag ?? Infinity) - (b.mag ?? Infinity);
  const lists = [...new Set(all.map((s) => String(s.cat)))].map((c) => all.filter((s) => String(s.cat) === c).sort(byMag));
  const picked: CatalogSource[] = [];
  for (let rank = 0; picked.length < max && lists.some((l) => rank < l.length); rank++) {
    for (const l of lists) if (rank < l.length && picked.length < max) picked.push(l[rank]);
  }
  const keys = new Set(picked.map(sourceKey));
  for (const s of moving) if (!keys.has(sourceKey(s))) picked.push(s);
  return { sources: picked, total: all.length, moving: moving.length };
}

/** One line for the hover text, e.g. "Gaia DR3 <id> · G 9.50 · pm 10.40″/yr". */
export function sourceLabel(s: CatalogSource): string {
  const cat = s.cat === "gaia_dr3" ? "Gaia DR3" : s.cat === "catwise2020" ? "CatWISE2020" : String(s.cat);
  const parts = [`${cat} ${s.id}`];
  if (s.mag !== null && Number.isFinite(s.mag)) parts.push(`${s.mag_band ?? "mag"} ${s.mag.toFixed(2)}`);
  if (s.pm_ra !== null || s.pm_dec !== null) parts.push(`pm ${totalPm(s).toFixed(2)}″/yr`);
  return parts.join(" · ");
}

// ---------- flags ----------

export interface FrameFlags {
  /** Fraction of flagged pixels within 15″ of the centre. */
  any_frac: number;
  /** Bits set there. */
  center_bits: number[];
}

/** Flag info that cube.json may carry (all optional). */
export interface FlagMeta {
  flag_names?: Record<string, string>;
  /** Bit -> the pipeline's own one-line description (A-09), e.g. "Overflow detected during SUR". */
  flag_descriptions?: Record<string, string>;
  /** Bits that are information, not damage (A-09: 12 FULLSAMPLE, 21 SOURCE); not in any_frac or flags.u8. */
  flags_informational?: number[];
  flags_url?: string;
  frames: { flags?: FrameFlags }[];
}

const flagName = (meta: FlagMeta, b: number) => meta.flag_names?.[String(b)] ?? `bit ${b}`;
const isInfo = (meta: FlagMeta, b: number) => (meta.flags_informational ?? []).includes(b);

/**
 * Names of the damage flags set near the centre of a frame (informational bits such as SOURCE left
 * out, as in any_frac and flags.u8); unknown bits as "bit N".
 */
export function centerFlagNames(meta: FlagMeta, frame: number): string[] {
  const bits = meta.frames[frame]?.flags?.center_bits ?? [];
  return bits.filter((b) => !isInfo(meta, b)).map((b) => flagName(meta, b));
}

/** Informational bits near the centre (e.g. SOURCE: a source is detected there), for a tooltip. */
export function centerInfoFlagNames(meta: FlagMeta, frame: number): string[] {
  const bits = meta.frames[frame]?.flags?.center_bits ?? [];
  return bits.filter((b) => isInfo(meta, b)).map((b) => flagName(meta, b));
}

/** "OVERFLOW: Overflow detected during SUR" lines for the damage flags near the centre (hover text). */
export function centerFlagDescriptions(meta: FlagMeta, frame: number): string[] {
  const bits = meta.frames[frame]?.flags?.center_bits ?? [];
  return bits
    .filter((b) => !isInfo(meta, b))
    .map((b) => {
      const d = meta.flag_descriptions?.[String(b)];
      return d ? `${flagName(meta, b)}: ${d}` : flagName(meta, b);
    });
}

/** Fetch flags.u8 (N x H x W, 0/1); null on 404. Throws if the size does not match the cube. */
export async function loadFlags(url: string, cube: Pick<Cube, "n" | "h" | "w">, fetchImpl: typeof fetch = fetch): Promise<Uint8Array | null> {
  const res = await fetchImpl(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`could not load ${url}: HTTP ${res.status} ${res.statusText}`.trim());
  const buf = new Uint8Array(await res.arrayBuffer());
  const expected = cube.n * cube.h * cube.w;
  if (buf.length !== expected) throw new Error(`flags are ${buf.length} bytes, expected ${expected} (N x H x W)`);
  return buf;
}

/** Colour of flagged pixels in the flag layer (RGBA, semi-transparent magenta). */
export const FLAG_RGBA: readonly [number, number, number, number] = [255, 64, 200, 140];

/** RGBA for one frame of the flag layer: flagged pixels FLAG_RGBA, the rest fully transparent. */
export function renderFlags(flags: Uint8Array, frame: number, w: number, h: number, out?: Uint8ClampedArray): Uint8ClampedArray {
  const size = w * h;
  const rgba = out ?? new Uint8ClampedArray(size * 4);
  const off = frame * size;
  for (let i = 0, j = 0; i < size; i++, j += 4) {
    const on = flags[off + i] !== 0;
    rgba[j] = on ? FLAG_RGBA[0] : 0;
    rgba[j + 1] = on ? FLAG_RGBA[1] : 0;
    rgba[j + 2] = on ? FLAG_RGBA[2] : 0;
    rgba[j + 3] = on ? FLAG_RGBA[3] : 0;
  }
  return rgba;
}

/**
 * Processing releases the cube's images come from, e.g. "DR1" or "QR2 + QR3", from
 * cube.json source.releases ({ "<IRSA release folder>": count }, data/cube.py). Empty if unknown.
 */
export function releaseLabel(meta: Pick<CubeMeta, "source">): string {
  const releases = (meta.source as { releases?: Record<string, number> } | undefined)?.releases;
  if (!releases) return "";
  return Object.keys(releases)
    .sort()
    .map((k) => k.toUpperCase())
    .join(" + ");
}

/**
 * Share of frames whose centre carries the pipeline's OVERFLOW flag (A-09 frames[].flags), 0..1;
 * null without flag data. Barnard's Star and R Dra: every frame (B-14, issue #87).
 */
export function overflowShare(meta: FlagMeta): number | null {
  const bit = Object.entries(meta.flag_names ?? {}).find(([, n]) => n === "OVERFLOW")?.[0];
  const withFlags = meta.frames.filter((f) => f.flags);
  if (bit === undefined || withFlags.length === 0) return null;
  return withFlags.filter((f) => f.flags!.center_bits.includes(Number(bit))).length / withFlags.length;
}

/** The core is saturated in most images: stacking cannot raise its peak, and the peak sits off-centre. */
export const isSaturatedCore = (meta: FlagMeta) => (overflowShare(meta) ?? 0) >= 0.5;

/** One sentence for the Stack tab and the six-detector tiles (B-14, issue #87). */
export const SATURATED_STACK_NOTE =
  "Saturated star: its centre is flagged and left out in most images, so the brightest pixel sits on the edge of the star and stacking along the motion need not raise the peak. The gain from stacking shows on faint objects such as WISE 0855.";

/**
 * B-15 (#90): the line under an image in plain words, null without flag data. The pipeline's flag
 * names (OVERFLOW, BLOOM, ...) go behind "Details". any_frac is the share of pixels within 15″ of the
 * centre with a damage flag (data/cube.py FLAG_RADIUS_ARCSEC), not of the whole image.
 */
export function flagSummary(meta: FlagMeta, frame: number): string | null {
  const f = meta.frames[frame]?.flags;
  if (!f) return null;
  const names = centerFlagNames(meta, frame);
  if (names.length === 0) return "No problem pixels near the centre.";
  const share =
    typeof f.any_frac === "number" ? ` Flags mark ${Math.round(f.any_frac * 100)} % of the pixels within 15″ of the centre.` : "";
  return names.includes("OVERFLOW")
    ? `The middle of this star is too bright for the detector (saturated).${share}`
    : `Some pixels near the centre are marked as less reliable in this image.${share}`;
}

/** "DR1 + QR3" in words, for the Details line. Empty if unknown. */
export function releaseText(meta: Pick<CubeMeta, "source">): string {
  const label = releaseLabel(meta);
  if (!label) return "";
  return `Images from IRSA processing release ${label} (DR = data release, QR = quick release).`;
}
