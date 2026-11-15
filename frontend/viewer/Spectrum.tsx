"use client";

// Full spectrum over all detectors (role B, tasks B-08; issue #75), shown in the Measure tab when
// /cubes/<obj>/spectrum.json exists. One marker shape per detector; colour by visit or one colour;
// points the pipeline did not measure cleanly (ok: false, with a flux) are drawn faint with their
// reason on hover; dashed lines mark where one detector hands over to the next.
// Detectors where the TARGET is not seen (bands[].detected === false, e.g. WISE 0855 below 4 µm,
// where the light in the aperture is a neighbouring star) are left off by default and explained
// with the file's own reason; they can be shown in grey, clearly marked as other light.
// Detectors without a single measured point are listed in words instead of an empty stretch.

import { useState } from "react";
import { BAND_SHAPES, Chart, type ChartSeries, type MarkerShape } from "./charts";
import { mjdToIsoDate } from "./cube";
import {
  bandDetected,
  bandSummaries,
  measured,
  neighbourSummary,
  notTargetLines,
  seams,
  undetectedLines,
  type SpectrumFile,
} from "./spectrumData";
import styles from "./Viewer.module.css";

const ONE_COLOUR = "#ff7a3d";
/** Light that is not the target (other source in the aperture). */
const OTHER_COLOUR = "#7c8496";
/** One colour per visit (cycled), same palette as the single-detector spectrum. */
const VISIT_COLOURS = ["#ff7a3d", "#ffc96b", "#8fd19e", "#7fd6e6", "#c792ea", "#e58fb0"];
const SHAPE_GLYPH: Record<MarkerShape, string> = {
  circle: "●",
  square: "■",
  triangle: "▲",
  diamond: "◆",
  triangleDown: "▼",
  cross: "✕",
};

const bandIndex = (b: string) => Math.max(0, Number(/^D(\d)$/.exec(b)?.[1] ?? 1) - 1);
const shapeOf = (band: string): MarkerShape => BAND_SHAPES[bandIndex(band) % BAND_SHAPES.length];

export function FullSpectrum({ spectrum }: { spectrum: SpectrumFile }) {
  const [byVisit, setByVisit] = useState(false);
  const [showOther, setShowOther] = useState(false);
  const summaries = bandSummaries(spectrum.points);
  const notTarget = notTargetLines(spectrum);
  const neighbourLine = neighbourSummary(spectrum);
  const nb = spectrum.neighbour?.bands ?? [];
  const otherLines = neighbourLine ? notTarget.filter((l) => !nb.some((b) => l.startsWith(`${b}:`))) : notTarget;
  const isTarget = (band: string) => bandDetected(spectrum, band);
  const drawn = spectrum.points.filter(
    (p) => Number.isFinite(p.flux) && Number.isFinite(p.lam_um) && (showOther || isTarget(p.band)),
  );
  const unit = spectrum.unit ?? "";

  // One series per detector (and per visit when colouring by visit); other light in one grey series per detector.
  const groups = new Map<string, ChartSeries>();
  for (const p of drawn) {
    const target = isTarget(p.band);
    const visit = p.epoch ?? 0;
    const key = !target ? `${p.band}|other` : byVisit ? `${p.band}|${visit}` : p.band;
    let g = groups.get(key);
    if (!g) {
      g = {
        label: !target ? `${p.band} (not the target)` : byVisit ? `${p.band} visit ${visit + 1}` : p.band,
        color: !target ? OTHER_COLOUR : byVisit ? VISIT_COLOURS[visit % VISIT_COLOURS.length] : ONE_COLOUR,
        shape: shapeOf(p.band),
        points: [],
      };
      groups.set(key, g);
    }
    const ok = measured(p);
    g.points.push({
      x: p.lam_um,
      y: p.flux as number,
      err: Number.isFinite(p.err) ? (p.err as number) : undefined,
      faded: !ok || !target,
      // Only cleanly measured points set the y axis (B-11): rejected ones (WISE 0855: ~60 mJy and
      // negative) would otherwise flatten the real 0.3-1 mJy spectrum; they show as edge arrows.
      inRange: ok,
      title: `${p.band} · ${p.lam_um.toFixed(3)} µm · ${mjdToIsoDate(p.mjd)}${
        !target ? " · not the target: another source" : ok ? "" : ` · not used: ${p.why || "flagged"}`
      }`,
    });
  }
  const series = [...groups.values()];
  // x axis over every detector in the file, also the ones left out: an empty stretch below 4 µm
  // then says where the target is (not) bright, instead of the axis starting at 3.8 µm.
  const lamLimits = (spectrum.bands?.length ? spectrum.bands.flatMap((b) => [b.lam_min, b.lam_max]) : summaries.flatMap((b) => [b.lamMin, b.lamMax]))
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const xInclude = lamLimits.length ? [Math.min(...lamLimits), Math.max(...lamLimits)] : [];
  const shownSummaries = summaries.filter((b) => showOther || isTarget(b.band));
  const visits = [...new Set(drawn.filter((p) => isTarget(p.band)).map((p) => p.epoch ?? 0))].sort((a, b) => a - b);
  // "Nothing measured" lines only for detectors not already explained by the file.
  const missing = undetectedLines(summaries.filter((b) => isTarget(b.band)));

  return (
    <>
      {notTarget.length > 0 && (
        <div className={styles.warning}>
          <p className={styles.tight}>
            <strong>Not the target in {notTarget.length === 1 ? "one detector" : `${notTarget.length} detectors`}.</strong>{" "}
            Their points are left out of the spectrum:
          </p>
          {neighbourLine ? (
            <>
              <p className={styles.tight}>{neighbourLine}</p>
              {otherLines.length > 0 && (
                <ul className={styles.reasonList}>
                  {otherLines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              )}
              <details className={styles.reasonDetails}>
                <summary>Per detector</summary>
                <ul className={styles.reasonList}>
                  {notTarget.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </details>
            </>
          ) : (
            <ul className={styles.reasonList}>
              {notTarget.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
          <label className={styles.options}>
            <input type="checkbox" checked={showOther} onChange={(e) => setShowOther(e.target.checked)} /> Show that
            light in grey
          </label>
        </div>
      )}
      {series.length > 0 ? (
        <>
          <label className={styles.options}>
            <input type="checkbox" checked={byVisit} onChange={(e) => setByVisit(e.target.checked)} /> Colour by visit
          </label>
          <Chart
            title="Full spectrum, all detectors"
            xLabel="wavelength (µm)"
            yLabel={`brightness (${unit})`}
            yInclude={[0]}
            series={series}
            vlines={seams(shownSummaries)}
            yRange="robust"
            xInclude={xInclude}
            hideKey
          />
          <p className={styles.chartKeyLine}>
            {shownSummaries
              .filter((b) => b.nOk > 0)
              .map((b) => (
                <span key={b.band} className={styles.bandKey}>
                  {SHAPE_GLYPH[shapeOf(b.band)]} {b.band} ({b.nOk} of {b.n}){isTarget(b.band) ? "" : ", grey: not the target"}
                </span>
              ))}
            {byVisit &&
              visits.map((v) => (
                <span key={v} className={styles.bandKey}>
                  <i style={{ background: VISIT_COLOURS[v % VISIT_COLOURS.length] }} /> visit {v + 1}
                </span>
              ))}
            <span className={styles.bandKey}>┆ detector seam · faint: not used (hover for why)</span>
          </p>
        </>
      ) : (
        <p className={styles.notice}>No detector has a measured point of the target.</p>
      )}
      {missing.length > 0 && (
        <p className={styles.notice}>
          {missing.join(" ")} Too faint at these wavelengths, so there is nothing to plot there.
        </p>
      )}
      <p className={styles.legend}>
        SPHEREx sees every wavelength from 0.75 to 5 µm with six detectors. Each image measures the star at one
        wavelength; all of them together give its spectrum. Where one detector hands over to the next (dashed lines)
        the brightness can jump: the detectors are not corrected to each other here.
      </p>
      {/* The file's note in full: its last sentences say what else is inside the aperture (issue #75). */}
      {spectrum.note && <p className={styles.legend}>{spectrum.note}</p>}
    </>
  );
}
