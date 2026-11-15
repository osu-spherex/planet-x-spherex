"use client";

// Measurement panel (role B, task B-04): proper motion with per-epoch positions, light curve in
// one wavelength bin, and the spectrum. All numbers come from measure.json (role A, measured in
// Python on the raw cutouts); nothing is computed or filled in here.
//
//   <Measure measureUrl="/cubes/barnard/D1/measure.json" catalogueMotion={...} />

import { useEffect, useState } from "react";
import { mjdToIsoDate } from "./cube";
import { Chart, type ChartLine } from "./charts";
import {
  defaultLightCurve,
  distanceLine,
  lineThrough,
  loadMeasure,
  loadMotionFile,
  motionConfirmed,
  motionUrlFor,
  noteWithoutHeading,
  parallaxLine,
  spectrumPoints,
  type Measure as MeasureData,
  type MotionFile,
} from "./measureData";
import type { CatalogueMotion } from "./Stack";
import { FullSpectrum } from "./Spectrum";
import { loadSpectrum, type SpectrumFile } from "./spectrumData";
import styles from "./Viewer.module.css";

export interface MeasureProps {
  /** URL of measure.json, or null when this position has no precomputed measurements. */
  measureUrl: string | null;
  /** Without a measureUrl: why (B-14, issue #93). Absent = no measurement service for this cube. */
  measureState?: MeasureState;
  catalogueMotion?: CatalogueMotion;
  /** spectrum.json (all detectors, B-08). null or missing file: the single-detector spectrum is shown. */
  spectrumUrl?: string | null;
}

type Load = { url: string; data: MeasureData | null } | { url: string; error: string };

const MEASURED = "#ff7a3d";
const CATALOGUE = "#ffc96b";
/** One colour per epoch in the spectrum (cycled). */
const EPOCH_COLOURS = ["#ff7a3d", "#ffc96b", "#8fd19e", "#7fd6e6", "#c792ea", "#e58fb0"];

const fmt = (v: number, d = 2) => (v < 0 ? `−${(-v).toFixed(d)}` : `+${v.toFixed(d)}`);
const dateTick = (mjd: number) => mjdToIsoDate(mjd).slice(0, 7);

/** pending: the images are still arriving; measuring: the job runs; failed: it could not be made. */
export type MeasureState = "pending" | "measuring" | "failed";

/** What the Measure tab says when there is no measurement file (yet). */
export function noMeasureText(state: MeasureState | undefined): string {
  if (state === "pending") return "The measurement starts once all images of this position are in.";
  if (state === "measuring") return "Measuring the source in every image… This usually takes under a minute.";
  if (state === "failed") return "The measurement could not be made for this position.";
  return "Measurements are precomputed for the five example objects only, so far.";
}

export function Measure({ measureUrl, catalogueMotion, spectrumUrl = null, measureState }: MeasureProps) {
  // motion.json sits next to the band folders of a static measure.json (B-14, #104); 404 = nothing shown.
  const motionUrl = measureUrl ? motionUrlFor(measureUrl.replace(/measure\.json$/, "cube.json")) : null;
  const [motion, setMotion] = useState<{ url: string; data: MotionFile | null } | null>(null);
  useEffect(() => {
    if (!motionUrl) return;
    let cancelled = false;
    loadMotionFile(motionUrl).then((data) => !cancelled && setMotion({ url: motionUrl, data }));
    return () => {
      cancelled = true;
    };
  }, [motionUrl]);
  const motionData = motion && motion.url === motionUrl ? motion.data : null;
  const [load, setLoad] = useState<Load | null>(null);
  const [spec, setSpec] = useState<{ url: string; data: SpectrumFile | null } | null>(null);

  // Optional: a missing or unreadable spectrum.json just means "no full spectrum".
  useEffect(() => {
    if (!spectrumUrl) return;
    let cancelled = false;
    loadSpectrum(spectrumUrl).then(
      (data) => !cancelled && setSpec({ url: spectrumUrl, data }),
      () => !cancelled && setSpec({ url: spectrumUrl, data: null }),
    );
    return () => {
      cancelled = true;
    };
  }, [spectrumUrl]);
  const fullSpectrum = spec && spec.url === spectrumUrl ? spec.data : null;

  useEffect(() => {
    if (!measureUrl) return;
    let cancelled = false;
    loadMeasure(measureUrl).then(
      (data) => !cancelled && setLoad({ url: measureUrl, data }),
      (err: unknown) => !cancelled && setLoad({ url: measureUrl, error: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      cancelled = true;
    };
  }, [measureUrl]);

  if (!measureUrl) {
    return (
      <p className={styles.notice} role="status" aria-busy={measureState === "pending" || measureState === "measuring"}>
        {noMeasureText(measureState)}
      </p>
    );
  }
  const current = load?.url === measureUrl ? load : null;
  if (!current) {
    return (
      <p className={styles.legend} aria-busy="true">
        Loading measurements…
      </p>
    );
  }
  if ("error" in current) {
    return (
      <p className={styles.error} role="alert">
        Could not load the measurements. {current.error}
      </p>
    );
  }
  if (!current.data) {
    return <p className={styles.notice}>No measurements for this position yet.</p>;
  }
  // key: a new file starts with its own default wavelength bin.
  return (
    <MeasureView
      key={measureUrl}
      m={current.data}
      catalogueMotion={catalogueMotion}
      fullSpectrum={fullSpectrum}
      motionFile={motionData}
    />
  );
}

export interface MeasureViewProps {
  m: MeasureData;
  catalogueMotion?: CatalogueMotion;
  /** All detectors (spectrum.json); replaces the single-detector spectrum when given. */
  fullSpectrum?: SpectrumFile | null;
  /** /cubes/<obj>/motion.json (A-14), for the distance line. */
  motionFile?: MotionFile | null;
}

/** The panel for one loaded measure.json (no fetching; renders on the server too). */
export function MeasureView({ m, catalogueMotion, fullSpectrum = null, motionFile = null }: MeasureViewProps) {
  const plx = parallaxLine(m.motion);
  const dist = distanceLine(motionFile);
  const [binChoice, setBinChoice] = useState<number | null>(null);
  const curves = m.light_curves ?? [];
  const bin = binChoice ?? defaultLightCurve(curves);
  const curve = curves[bin];
  const spectrum = spectrumPoints(m);
  const unit = m.photometry_unit ?? "";
  const epochs = m.epochs;
  const confirmed = m.motion ? motionConfirmed(m.motion) : false;

  const motionLines = (axis: "ra" | "dec"): ChartLine[] => {
    const pts = epochs.map((e) => ({
      t: e.mjd,
      v: axis === "ra" ? e.dra_arcsec : e.ddec_arcsec,
      err: axis === "ra" ? e.err_ra : e.err_dec,
    }));
    const out: ChartLine[] = [];
    if (m.motion) {
      const l = lineThrough(pts, axis === "ra" ? m.motion.pm_ra : m.motion.pm_dec);
      if (l) out.push({ label: confirmed ? "measured motion" : "fit (not confirmed)", color: MEASURED, dashed: !confirmed, at: l.at });
    }
    if (catalogueMotion) {
      const l = lineThrough(pts, axis === "ra" ? catalogueMotion.pmRa : catalogueMotion.pmDec);
      if (l) out.push({ label: catalogueMotion.source, color: CATALOGUE, dashed: true, at: l.at });
    }
    return out;
  };

  return (
    <div className={styles.compare}>
      <section className={styles.measureSection} aria-labelledby="measure-motion">
        <h3 id="measure-motion">Motion</h3>
        {m.motion && !confirmed ? (
          // Not a result (issue #75): e.g. WISE 0855 D1-D4, where the source found is a neighbouring star.
          // The reason comes first; the fitted numbers are given only as what they are.
          <p className={styles.warning}>
            <strong>Not a confirmed measurement.</strong> {noteWithoutHeading(m.motion.note)} The fit over{" "}
            {m.motion.n_epochs} visits gave east {fmt(m.motion.pm_ra)} ± {m.motion.err_ra.toFixed(2)}, north{" "}
            {fmt(m.motion.pm_dec)} ± {m.motion.err_dec.toFixed(2)}″/yr; it is not reported as the motion of the target.
          </p>
        ) : m.motion ? (
          <>
            <p className={styles.bigNumbers}>
              <span>
                East <strong>{fmt(m.motion.pm_ra)}</strong> ± {m.motion.err_ra.toFixed(2)}″/yr
              </span>
              <span>
                North <strong>{fmt(m.motion.pm_dec)}</strong> ± {m.motion.err_dec.toFixed(2)}″/yr
              </span>
            </p>
            {catalogueMotion && (
              <p className={styles.legend}>
                Catalogue, {catalogueMotion.source}: east {fmt(catalogueMotion.pmRa)}, north{" "}
                {fmt(catalogueMotion.pmDec)}″/yr. Measured from {m.motion.n_epochs} visits in SPHEREx images alone.
              </p>
            )}
          </>
        ) : (
          <p className={styles.notice}>
            No motion could be measured: the source was found in fewer than two visits.
          </p>
        )}
        {m.saturated && (
          <p className={styles.warning}>
            <strong>Saturated star.</strong> The brightest pixels of the star are flagged by SPHEREx, so its position
            comes from the wings of its image and one direction is less certain (larger error bars).
          </p>
        )}
        {epochs.length > 0 && (
          <div className={styles.charts}>
            <Chart
              title="North offset per visit"
              xLabel="date"
              yLabel="north offset (″)"
              xFormat={dateTick}
              series={[
                {
                  label: "SPHEREx visit",
                  color: MEASURED,
                  points: epochs.map((e) => ({ x: e.mjd, y: e.ddec_arcsec, err: e.err_dec })),
                },
              ]}
              lines={motionLines("dec")}
            />
            <Chart
              title="East offset per visit"
              xLabel="date"
              yLabel="east offset (″)"
              xFormat={dateTick}
              series={[
                {
                  label: "SPHEREx visit",
                  color: MEASURED,
                  points: epochs.map((e) => ({ x: e.mjd, y: e.dra_arcsec, err: e.err_ra })),
                },
              ]}
              lines={motionLines("ra")}
            />
          </div>
        )}
        {(plx || dist) && (
          <p className={styles.legend}>
            {plx}
            {plx && dist ? " " : ""}
            {dist}
          </p>
        )}
        <p className={styles.legend}>
          Each point is the median position of one visit relative to the centre of the images, with its 1σ error
          bar. A moving star lines up along a sloped line; its slope is the motion.
          {m.method ? ` Method: ${m.method.replace(/\.$/, "")}.` : ""}
        </p>
      </section>

      <section className={styles.measureSection} aria-labelledby="measure-lc">
        <h3 id="measure-lc">Brightness over time</h3>
        {curve ? (
          <>
            <label className={styles.options}>
              Wavelength{" "}
              <select
                value={bin}
                onChange={(e) => setBinChoice(Number(e.target.value))}
              >
                {curves.map((c, i) => (
                  <option key={i} value={i}>
                    {c.lam_min.toFixed(2)}–{c.lam_max.toFixed(2)} µm ({c.points.length} visits)
                  </option>
                ))}
              </select>
            </label>
            <Chart
              title={`Light curve, ${curve.lam_min.toFixed(2)}–${curve.lam_max.toFixed(2)} µm`}
              xLabel="date"
              yLabel={`brightness (${unit})`}
              xFormat={dateTick}
              yInclude={[0]}
              series={[
                {
                  label: "visit",
                  color: MEASURED,
                  points: curve.points.map((p) => ({ x: p.mjd, y: p.flux, err: p.err })),
                },
              ]}
            />
            <p className={styles.legend}>
              Only images taken at the same wavelength are compared: SPHEREx sees the star at a different wavelength
              in every image, and a star is not equally bright at every wavelength.
              {m.photometry_note ? ` Measured as: ${m.photometry_note.replace(/\.$/, "")}.` : ""}
            </p>
          </>
        ) : (
          <p className={styles.notice}>Brightness measurements for this object are not available yet.</p>
        )}
      </section>

      <section className={styles.measureSection} aria-labelledby="measure-spectrum">
        <h3 id="measure-spectrum">Spectrum</h3>
        {fullSpectrum ? (
          <FullSpectrum spectrum={fullSpectrum} />
        ) : spectrum.length > 0 ? (
          <>
            <Chart
              title="Brightness against wavelength"
              xLabel="wavelength (µm)"
              yLabel={`brightness (${unit})`}
              yInclude={[0]}
              series={[...new Set(spectrum.map((p) => p.epoch ?? 0))].sort((a, b) => a - b).map((ep, k) => ({
                label: `visit ${ep + 1}`,
                color: EPOCH_COLOURS[k % EPOCH_COLOURS.length],
                points: spectrum
                  .filter((p) => (p.epoch ?? 0) === ep)
                  .map((p) => ({ x: p.lam, y: p.flux, err: p.err })),
              }))}
            />
            <p className={styles.legend}>
              Every image measures the star at one wavelength, so all images together give its spectrum. Dips are
              wavelengths where the star&apos;s atmosphere absorbs light. Visits are coloured separately because a
              variable star changes between them.
            </p>
          </>
        ) : (
          <p className={styles.notice}>No spectrum for this object yet.</p>
        )}
      </section>
    </div>
  );
}

export default Measure;
