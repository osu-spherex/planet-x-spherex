// Full spectrum over all six detectors (role B, task B-08).
//
// Static file: /cubes/<obj>/spectrum.json (role A, task A-08), format in docs/ARCHITECTURE.md
// "Интерфейсийн нэмэлт":
//   { object, unit, note, points:[{ band, mjd, epoch, lam_um, flux, err, ok, why }] }   // 0.75-5.0 um
// Every number is A's (Python, raw cutouts). The jumps where one detector hands over to the next
// are not corrected (no aperture correction); the file's `note` says so and the chart shows it.

export interface SpectrumPoint {
  band: string;
  mjd: number;
  epoch?: number;
  lam_um: number;
  flux: number | null;
  err: number | null;
  ok: boolean;
  why?: string;
}

/**
 * Per-detector verdict written by role A (A-08, data/cubes/README.md; issue #75): is the TARGET seen
 * in this detector? `detected: false` with `why_not` when the light at the position is another
 * source or there is no significant light. Absent in older files: then every detector counts.
 */
export interface SpectrumBand {
  band: string;
  n_images?: number;
  n_ok?: number;
  lam_min?: number;
  lam_max?: number;
  median_flux?: number;
  median_snr?: number;
  n_found?: number;
  offset_arcsec?: number;
  detected: boolean;
  why_not?: string;
}

/** Another source inside the photometry aperture (A-08): where it is and in which detectors it dominates. */
export interface SpectrumNeighbour {
  east_arcsec: number;
  north_arcsec: number;
  sep_arcsec: number;
  bands: string[];
}

export interface SpectrumFile {
  object?: string;
  method?: string;
  unit?: string;
  note?: string;
  neighbour?: SpectrumNeighbour | null;
  bands?: SpectrumBand[];
  points: SpectrumPoint[];
}

/** True unless the file says the target is not seen in this detector. */
export function bandDetected(file: Pick<SpectrumFile, "bands">, band: string): boolean {
  return file.bands?.find((b) => b.band === band)?.detected !== false;
}

/**
 * One sentence per detector where the target is not seen, from the file's own reason, e.g.
 * "D1: the light in the aperture comes from another source, 8.3 arcsec from the position (…)."
 */
export function notTargetLines(file: Pick<SpectrumFile, "bands">): string[] {
  return (file.bands ?? [])
    .filter((b) => b.detected === false)
    .map((b) => `${b.band}: ${(b.why_not || "the target is not seen in this detector").replace(/\.$/, "")}.`);
}

/** spectrum.json one level above the band folder of a static cube; null for other URLs. */
export function spectrumUrlFor(cubeUrl: string): string | null {
  const [path, query] = cubeUrl.split("?");
  // Only the static layout cubes/<obj>/<band>/cube.json, not a backend first look /api/cubes/<key>/cube.json.
  const m = query === undefined ? path.match(/^((?:.*\/)?cubes\/[^/]+\/)[^/]+\/cube\.json$/) : null;
  return m ? `${m[1]}spectrum.json` : null;
}

/** Fetch spectrum.json; null on 404 (not made yet). Throws on other errors or a file without points. */
export async function loadSpectrum(url: string, fetchImpl: typeof fetch = fetch): Promise<SpectrumFile | null> {
  const res = await fetchImpl(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`could not load ${url}: HTTP ${res.status} ${res.statusText}`.trim());
  const s = (await res.json()) as Partial<SpectrumFile>;
  if (!Array.isArray(s.points)) throw new Error(`${url} is not a spectrum: no "points"`);
  return s as SpectrumFile;
}

const bandOrder = (b: string) => {
  const m = /^D(\d)$/.exec(b);
  return m ? Number(m[1]) : 99;
};

/** Point has a usable flux (ok, finite flux and wavelength). */
export const measured = (p: SpectrumPoint) => p.ok && Number.isFinite(p.flux) && Number.isFinite(p.lam_um);

export interface BandSummary {
  band: string;
  /** Images of this detector in the file. */
  n: number;
  /** Images with a usable flux. */
  nOk: number;
  lamMin: number;
  lamMax: number;
  /** Distinct reasons for the points that were not measured, most common first. */
  reasons: string[];
}

/** Per detector, in D1..D6 order: how many images, how many measured, wavelength range, reasons. */
export function bandSummaries(points: readonly SpectrumPoint[]): BandSummary[] {
  const by = new Map<string, SpectrumPoint[]>();
  for (const p of points) {
    const list = by.get(p.band) ?? [];
    list.push(p);
    by.set(p.band, list);
  }
  return [...by.entries()]
    .sort(([a], [b]) => bandOrder(a) - bandOrder(b) || a.localeCompare(b))
    .map(([band, list]) => {
      const lams = list.map((p) => p.lam_um).filter(Number.isFinite);
      const why = new Map<string, number>();
      for (const p of list) if (!measured(p)) why.set(p.why || "not measured", (why.get(p.why || "not measured") ?? 0) + 1);
      return {
        band,
        n: list.length,
        nOk: list.filter(measured).length,
        lamMin: lams.length ? Math.min(...lams) : NaN,
        lamMax: lams.length ? Math.max(...lams) : NaN,
        reasons: [...why.entries()].sort((a, b) => b[1] - a[1]).map(([r]) => r),
      };
    });
}

/**
 * Wavelengths where one detector hands over to the next: the midpoint between the longest
 * wavelength of a detector and the shortest of the next one present. Drawn as vertical lines.
 */
export function seams(summaries: readonly BandSummary[]): number[] {
  const s = summaries.filter((b) => Number.isFinite(b.lamMin) && Number.isFinite(b.lamMax));
  const out: number[] = [];
  for (let i = 1; i < s.length; i++) out.push((s[i - 1].lamMax + s[i].lamMin) / 2);
  return out;
}

/** One sentence per detector without a single measured point, e.g. "D1: not detected in 60 images (too faint)." */
export function undetectedLines(summaries: readonly BandSummary[]): string[] {
  return summaries
    .filter((b) => b.n > 0 && b.nOk === 0)
    .map((b) => `${b.band}: not detected in ${b.n} image${b.n === 1 ? "" : "s"}${b.reasons[0] ? ` (${b.reasons[0]})` : ""}.`);
}

/** "D1–D4" for a contiguous run of detectors, "D1, D3" otherwise. */
export function bandRange(bands: readonly string[]): string {
  const n = bands.map((b) => Number(/^D(\d)$/.exec(b)?.[1])).sort((a, b) => a - b);
  if (n.length > 2 && n.every((v, i) => Number.isFinite(v) && (i === 0 || v === n[i - 1] + 1))) return `D${n[0]}–D${n.at(-1)}`;
  return bands.join(", ");
}

/**
 * One sentence for detectors whose light is a neighbouring source (A-08 `neighbour`, issue #75), e.g.
 * "D1–D4: the light in the aperture comes from another source 8.2″ from the position (7.9″ west,
 * 2.2″ north), not the target." null without a neighbour among the detectors where the target is not seen.
 */
export function neighbourSummary(file: Pick<SpectrumFile, "neighbour" | "bands">): string | null {
  const nb = file.neighbour;
  if (!nb) return null;
  const off = (file.bands ?? []).filter((b) => b.detected === false && nb.bands.includes(b.band)).map((b) => b.band);
  if (off.length === 0) return null;
  const ew = `${Math.abs(nb.east_arcsec).toFixed(1)}″ ${nb.east_arcsec < 0 ? "west" : "east"}`;
  const ns = `${Math.abs(nb.north_arcsec).toFixed(1)}″ ${nb.north_arcsec < 0 ? "south" : "north"}`;
  return `${bandRange(off)}: the light in the aperture comes from another source ${nb.sep_arcsec.toFixed(1)}″ from the position (${ew}, ${ns}), not the target.`;
}
