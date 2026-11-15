"use client";

// "All six detectors" (role B, task B-12). NASA's suggestion: add together all the data of each
// detector array. For a prepared object every detector has its own 3′ cube on the same grid (A-08),
// so each one is stacked here with the motion and search point currently set in the Stack tab,
// aligned on the same reference time, and shown side by side with its peak SNR and where that
// peak is relative to the target. Detectors where the target is not seen (spectrum.json
// bands[].detected, e.g. WISE 0855 below 4 µm: a neighbouring star) say so with the file's reason.
// Clicking a tile opens that detector. role P's combined multi-detector search (stackMulti) is P-09
// and deliberately not used here.

import { useEffect, useMemo, useRef, useState } from "react";
import { loadCube, renderFrame, stretchLimits, type Cube, type StretchMode } from "./cube";
import type { StackMode } from "../search/stack";
import { loadSpectrum, spectrumUrlFor, type SpectrumBand } from "./spectrumData";
import { defaultStackMode, stackView, type StackView } from "./stackView";
import { SATURATED_STACK_NOTE, isSaturatedCore } from "./overlayData";
import styles from "./Viewer.module.css";

/** SPHEREx detectors D1-D6. */
const BANDS = ["D1", "D2", "D3", "D4", "D5", "D6"] as const;

/** /cubes/<obj>/<band>/cube.json of another detector; null when the cube is not a static one. */
export function bandCubeUrl(cubeUrl: string, band: string): string | null {
  const [path, query] = cubeUrl.split("?");
  if (query !== undefined) return null;
  const m = path.match(/^((?:.*\/)?cubes\/[^/]+\/)[^/]+\/cube\.json$/);
  return m ? `${m[1]}${band}/cube.json` : null;
}

/** Where a peak is relative to a point, arcsec, e.g. "8″ W", "on the target" (within one pixel). */
export function offsetText(peak: { x: number; y: number }, at: { x: number; y: number }, pix: number): string {
  const east = (at.x - peak.x) * pix; // column 0 is east
  const north = (at.y - peak.y) * pix; // row 0 is north
  const dist = Math.hypot(east, north);
  if (dist <= pix * 1.01) return "on the target";
  const dir =
    (Math.abs(north) >= dist * 0.38 ? (north > 0 ? "N" : "S") : "") + (Math.abs(east) >= dist * 0.38 ? (east > 0 ? "E" : "W") : "");
  return `${Math.round(dist)}″ ${dir} of the target`;
}

/** Highest SNR within one pixel of a point (the target), NaN when there is no data there. */
export function snrAt(snr: Float32Array, w: number, h: number, at: { x: number; y: number }): number {
  let best = -Infinity;
  const cx = Math.round(at.x);
  const cy = Math.round(at.y);
  for (let y = cy - 1; y <= cy + 1; y++)
    for (let x = cx - 1; x <= cx + 1; x++) {
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const v = snr[y * w + x];
      if (Number.isFinite(v) && v > best) best = v;
    }
  return Number.isFinite(best) ? best : NaN;
}

/** Wavelength range of a cube's frames, "1.09–1.64 µm". */
function lamRange(cube: Cube): string {
  const l = cube.meta.frames.map((f) => f.lam_um).filter(Number.isFinite);
  return l.length ? `${Math.min(...l).toFixed(2)}–${Math.max(...l).toFixed(2)} µm` : "";
}

type Loaded = { band: string; cube: Cube | null; error?: string };

export interface SixDetectorsProps {
  /** The cube on screen (its detector is not fetched again). */
  cube: Cube;
  cubeUrl: string;
  pmRa: number;
  pmDec: number;
  /** Search point (pixels) and reference time of the Stack tab. */
  at: { x: number; y: number };
  refMjd: number;
  mode?: StretchMode;
  onPickBand?: (band: string) => void;
}

function Tile({
  band,
  view,
  cube,
  at,
  mode,
  note,
  current,
  onPick,
}: {
  band: string;
  view: StackView;
  cube: Cube;
  at: { x: number; y: number };
  mode: StretchMode;
  note: SpectrumBand | undefined;
  current: boolean;
  onPick?: () => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    const image = ctx.createImageData(cube.w, cube.h);
    renderFrame(view.result.image, stretchLimits(view.result.image), mode, image.data);
    ctx.putImageData(image, 0, 0);
  }, [view, cube, mode]);
  const pix = cube.meta.pixscale_arcsec;
  const peakOk = Number.isFinite(view.peak.snr) && view.peak.x >= 0;
  const atSnr = snrAt(view.result.snr, cube.w, cube.h, at);
  const k = cube.w / 61;
  const body = (
    <>
      <div className={styles.stage} style={{ aspectRatio: `${cube.w} / ${cube.h}` }}>
        <canvas ref={ref} className={styles.canvas} width={cube.w} height={cube.h} role="img" aria-label={`${band} stack`} />
        <svg className={styles.overlay} viewBox={`0 0 ${cube.w} ${cube.h}`} aria-hidden="true">
          <circle className={styles.regionMark} cx={at.x + 0.5} cy={at.y + 0.5} r={4.5 * k} />
          {peakOk && <circle className={styles.peakMark} cx={view.peak.x + 0.5} cy={view.peak.y + 0.5} r={2 * k} />}
        </svg>
      </div>
      <span className={styles.sixCaption}>
        <strong>{band}</strong> · {lamRange(cube)} · {cube.n} images
        <br />
        {!peakOk
          ? "no data at the target"
          : offsetText(view.peak, at, pix) === "on the target"
            ? `peak SNR ${view.peak.snr.toFixed(1)}, on the target`
            : `SNR at the target ${Number.isFinite(atSnr) ? atSnr.toFixed(1) : "–"}; brightest within 12″: ${view.peak.snr.toFixed(1)}, ${offsetText(view.peak, at, pix)}`}
        {isSaturatedCore(cube.meta) && (
          <>
            <br />
            <em>Saturated centre: the peak sits on the edge of the star.</em>
          </>
        )}
        {note && note.detected === false && (
          <>
            <br />
            <em>Not the target: {(note.why_not || "not seen in this detector").replace(/\.$/, "")}.</em>
          </>
        )}
      </span>
    </>
  );
  return onPick && !current ? (
    <button type="button" className={styles.sixTile} onClick={onPick} title={`Open ${band}`}>
      {body}
    </button>
  ) : (
    <div className={`${styles.sixTile} ${current ? styles.sixCurrent : ""}`}>{body}</div>
  );
}

export function SixDetectors({ cube, cubeUrl, pmRa, pmDec, at, refMjd, mode = "linear", onPickBand }: SixDetectorsProps) {
  const thisBand = cube.meta.band ?? cube.meta.frames[0]?.band ?? "";
  const [loaded, setLoaded] = useState<{ url: string; items: Loaded[]; ms: number } | null>(null);
  const [notes, setNotes] = useState<SpectrumBand[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const t0 = performance.now();
    Promise.all(
      BANDS.map(async (band): Promise<Loaded> => {
        if (band === thisBand) return { band, cube };
        const url = bandCubeUrl(cubeUrl, band);
        if (!url) return { band, cube: null, error: "not prepared" };
        try {
          return { band, cube: await loadCube(url) };
        } catch {
          return { band, cube: null, error: "not prepared" };
        }
      }),
    ).then((items) => !cancelled && setLoaded({ url: cubeUrl, items, ms: performance.now() - t0 }));
    const sUrl = spectrumUrlFor(cubeUrl);
    if (sUrl) loadSpectrum(sUrl).then((s) => !cancelled && setNotes(s?.bands ?? null), () => undefined);
    return () => {
      cancelled = true;
    };
  }, [cubeUrl, cube, thisBand]);

  const items = loaded?.url === cubeUrl ? loaded.items : null;
  // Same grid as the cube on screen (A-08: same centre, same 3″ grid), else the point would not match.
  const sameGrid = (c: Cube) => c.w === cube.w && c.h === cube.h;
  const views = useMemo(
    () =>
      (items ?? []).map((it) => {
        if (!it.cube || !sameGrid(it.cube)) return null;
        const combine: StackMode = defaultStackMode(it.cube, at);
        return stackView(it.cube, pmRa, pmDec, combine, refMjd, at);
      }),
    // sameGrid only reads cube.w / cube.h
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, pmRa, pmDec, refMjd, at, cube.w, cube.h],
  );

  if (!items) return <p className={styles.legend}>Loading the six detectors…</p>;

  return (
    <>
      <div className={styles.sixGrid}>
        {items.map((it, i) => {
          const v = views[i];
          if (!it.cube || !v) {
            return (
              <div key={it.band} className={`${styles.sixTile} ${styles.sixMissing}`}>
                <span className={styles.sixCaption}>
                  <strong>{it.band}</strong> · {it.error ?? "different grid"}
                </span>
              </div>
            );
          }
          return (
            <Tile
              key={it.band}
              band={it.band}
              view={v}
              cube={it.cube}
              at={at}
              mode={mode}
              note={notes?.find((n) => n.band === it.band)}
              current={it.band === thisBand}
              onPick={onPickBand ? () => onPickBand(it.band) : undefined}
            />
          );
        })}
      </div>
      <p className={styles.legend}>
        Every detector stacked with the same motion ({pmRa.toFixed(1)}, {pmDec.toFixed(1)}″/yr) around the same point
        (dashed circle, the target), each on its own brightness scale; the green ring is its brightest spot within 12″. Each detector
        sees a different range of infrared light, so where an object is bright tells what kind of object it is.
        {onPickBand ? " Click a detector to open it." : ""}
        {isSaturatedCore(cube.meta) ? ` ${SATURATED_STACK_NOTE}` : ""} Loaded in {(loaded!.ms / 1000).toFixed(1)} s.
      </p>
    </>
  );
}

export default SixDetectors;
