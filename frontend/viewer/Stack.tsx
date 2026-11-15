"use client";

// Shift-and-stack by hand (role B, task B-03). The user sets a proper motion (arcsec/yr); every
// frame is shifted back along it and the frames are combined with role P's stack(). With the
// right motion a moving object lands on one pixel in every frame and builds up; with a wrong one
// it smears. Left: the stacked image. Right: its SNR (signal-to-noise) map.
//
//   <Stack cube={cube} catalogueMotion={{ pmRa: -0.8, pmDec: 10.36, source: "Gaia DR3" }} />

import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { mjdToIsoDate, renderFrame, type Cube, type StretchLimits, type StretchMode } from "./cube";
import { type StackMode } from "../search/stack";
import { SkyOverlay } from "./SkyOverlay";
import {
  PEAK_RADIUS_ARCSEC,
  STACK_BOX_ARCSEC,
  arcsecToPx,
  clampMotion,
  defaultStackMode,
  meanMjd,
  stackBox,
  stackScales,
  stackView,
} from "./stackView";
import { Search } from "./Search";
import { SixDetectors, bandCubeUrl } from "./SixDetectors";
import { SATURATED_STACK_NOTE, isSaturatedCore } from "./overlayData";
import { CLIPPED_MEAN_TEXT, SNR_TEXT } from "./words";
import styles from "./Viewer.module.css";

/** Radius of the peak ring, arcsec (2.6 px of the 3″ cubes). */
const PEAK_RING_ARCSEC = 7.8;

/** "+6", "−3", "0" (typographic minus). */
const signed = (v: number) => {
  const r = Math.round(v);
  return r > 0 ? `+${r}` : r < 0 ? `−${-r}` : "0";
};

export interface CatalogueMotion {
  /** arcsec/yr, includes cos(Dec). */
  pmRa: number;
  /** arcsec/yr. */
  pmDec: number;
  /** Where the numbers come from, e.g. "Gaia DR3". */
  source: string;
}

export interface StackProps {
  cube: Cube;
  /** Known motion of the target, if any. Comes from the page; never hard-coded here. */
  catalogueMotion?: CatalogueMotion;
  /** Brightness scale for the stacked image. */
  mode?: StretchMode;
  showCentre?: boolean;
  /** Start here instead of (0, 0) at the centre, e.g. "Stack along this motion" on a catalogue
   *  source (B-10): its catalogue motion and its position at the stack's reference time. */
  initial?: { pmRa: number; pmDec: number; x: number; y: number };
  /** URL of the cube on screen; with a static cube the "All six detectors" view is offered (B-12). */
  cubeUrl?: string;
  /** Open another detector (B-12: a click on its tile). */
  onPickBand?: (band: string) => void;
}

/** Slider range, arcsec/yr. Same as role P's default search range (search/grid.ts, pmMax 15). */
const PM_MAX = 15;
const MODES: { value: StackMode; label: string }[] = [
  { value: "mean", label: "mean" },
  { value: "median", label: "median" },
  { value: "clipped", label: "clipped mean" },
];

function Plane({
  pixels,
  limits,
  mode,
  cube,
  label,
  peak,
  showCentre,
  region,
  onPickPixel,
}: {
  pixels: Float32Array;
  limits: StretchLimits;
  mode: StretchMode;
  cube: Cube;
  label: string;
  peak: { x: number; y: number } | null;
  showCentre: boolean;
  /** Search region to outline (dashed), cube pixels. */
  region?: { x: number; y: number; r: number };
  /** Called with the clicked cube pixel. */
  onPickPixel?: (x: number, y: number) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    const image = ctx.createImageData(cube.w, cube.h);
    renderFrame(pixels, limits, mode, image.data);
    ctx.putImageData(image, 0, 0);
  }, [pixels, limits, mode, cube]);
  return (
    <div
      className={styles.stage}
      style={{ aspectRatio: `${cube.w} / ${cube.h}`, cursor: onPickPixel ? "crosshair" : undefined }}
      onClick={
        onPickPixel &&
        ((e) => {
          const box = e.currentTarget.getBoundingClientRect();
          const x = Math.floor(((e.clientX - box.left) / box.width) * cube.w);
          const y = Math.floor(((e.clientY - box.top) / box.height) * cube.h);
          onPickPixel(Math.min(cube.w - 1, Math.max(0, x)), Math.min(cube.h - 1, Math.max(0, y)));
        })
      }
    >
      <canvas ref={ref} className={styles.canvas} width={cube.w} height={cube.h} role="img" aria-label={label} />
      <SkyOverlay w={cube.w} h={cube.h} pixscaleArcsec={cube.meta.pixscale_arcsec} showCentre={showCentre} />
      {(peak || region) && (
        <svg className={styles.overlay} viewBox={`0 0 ${cube.w} ${cube.h}`} aria-hidden="true">
          {region && (
            <circle className={styles.regionMark} cx={region.x + 0.5} cy={region.y + 0.5} r={region.r + 0.5} />
          )}
          {peak && <circle className={styles.peakMark} cx={peak.x + 0.5} cy={peak.y + 0.5} r={arcsecToPx(cube, PEAK_RING_ARCSEC)} />}
        </svg>
      )}
    </div>
  );
}

function MotionInput({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className={styles.motionRow}>
      <label className={styles.motionLabel}>
        {label}
        <span>{hint}</span>
      </label>
      <input
        className={styles.slider}
        type="range"
        min={-PM_MAX}
        max={PM_MAX}
        step={0.1}
        value={value}
        onChange={(e) => onChange(clampMotion(Number(e.target.value), PM_MAX))}
        aria-label={`${label}, arcseconds per year`}
      />
      <input
        className={styles.number}
        type="number"
        min={-PM_MAX}
        max={PM_MAX}
        step={0.1}
        value={value}
        onChange={(e) => onChange(clampMotion(Number(e.target.value), PM_MAX))}
        aria-label={`${label}, arcseconds per year, exact value`}
      />
    </div>
  );
}

export function Stack({ cube, catalogueMotion, mode = "linear", showCentre = true, initial, cubeUrl, onPickBand }: StackProps) {
  const [showSix, setShowSix] = useState(false);
  const sixPossible = cubeUrl !== undefined && bandCubeUrl(cubeUrl, "D1") !== null;
  const startX = initial?.x ?? (cube.w - 1) / 2;
  const startY = initial?.y ?? (cube.h - 1) / 2;
  // Suggested combine for whatever sits at the starting point (bright star: mean, faint: clipped).
  const autoMode = useMemo(() => defaultStackMode(cube, { x: startX, y: startY }), [cube, startX, startY]);
  const [state, setState] = useState<{
    cube: Cube;
    pmRa: number;
    pmDec: number;
    combine: StackMode;
    searchX: number;
    searchY: number;
  } | null>(null);
  const current =
    state?.cube === cube
      ? state
      : {
          cube,
          pmRa: clampMotion(initial?.pmRa ?? 0, PM_MAX),
          pmDec: clampMotion(initial?.pmDec ?? 0, PM_MAX),
          combine: autoMode,
          searchX: startX,
          searchY: startY,
        };
  const update = (patch: Partial<typeof current>) => setState({ ...current, ...patch });

  // Stacking takes a few to ~30 ms; let the slider move first and the images follow.
  const pmRa = useDeferredValue(current.pmRa);
  const pmDec = useDeferredValue(current.pmDec);
  const combine = current.combine;

  const refMjd = useMemo(() => meanMjd(cube), [cube]);
  const searchX = current.searchX;
  const searchY = current.searchY;
  const at = useMemo(() => ({ x: searchX, y: searchY }), [searchX, searchY]);
  const zero = useMemo(() => stackView(cube, 0, 0, combine, refMjd, at), [cube, combine, refMjd, at]);
  const scales = useMemo(() => stackScales(zero), [zero]);
  const view = useMemo(
    () => (pmRa === 0 && pmDec === 0 ? zero : stackView(cube, pmRa, pmDec, combine, refMjd, at)),
    [cube, pmRa, pmDec, combine, refMjd, zero, at],
  );

  const peakOk = Number.isFinite(view.peak.snr) && view.peak.x >= 0;
  const peak = peakOk ? { x: view.peak.x, y: view.peak.y } : null;
  const pix = cube.meta.pixscale_arcsec;
  const total = Math.hypot(current.pmRa, current.pmDec);
  const atCatalogue =
    catalogueMotion !== undefined &&
    Math.abs(current.pmRa - catalogueMotion.pmRa) < 0.05 &&
    Math.abs(current.pmDec - catalogueMotion.pmDec) < 0.05;
  const searchRegion = { x: current.searchX, y: current.searchY, r: arcsecToPx(cube, PEAK_RADIUS_ARCSEC) };
  const boxed = stackBox(cube, at) !== undefined;
  const vectorText = `motion ${current.pmRa.toFixed(1)}″/yr east, ${current.pmDec.toFixed(1)}″/yr north`;

  return (
    <div className={styles.compare}>
      <div className={styles.pair}>
        <figure className={styles.figure}>
          <Plane
            pixels={view.result.image}
            limits={scales.image}
            mode={mode}
            cube={cube}
            peak={peak}
            showCentre={showCentre}
            region={searchRegion}
            onPickPixel={(x, y) => update({ searchX: x, searchY: y })}
            label={`Stack of ${view.result.frames.length} images shifted by ${vectorText}. North is up, east is left.`}
          />
          <figcaption>Stacked image</figcaption>
        </figure>
        <figure className={styles.figure}>
          <Plane
            pixels={view.result.snr}
            limits={scales.snr}
            mode="linear"
            cube={cube}
            peak={peak}
            showCentre={showCentre}
            label={`Signal-to-noise map of the stack, ${vectorText}. Peak ${view.peak.snr.toFixed(1)}.`}
          />
          <figcaption>
            SNR, {scales.snr.lo} (black) to {scales.snr.hi.toFixed(0)} (white)
          </figcaption>
        </figure>
      </div>

      <p className={styles.info} aria-live="polite">
        <strong>Peak SNR {peakOk ? view.peak.snr.toFixed(1) : "–"}</strong>
        {peak && (
          <span>
            at {signed(((cube.w - 1) / 2 - peak.x) * pix)}″ E, {signed(((cube.h - 1) / 2 - peak.y) * pix)}″ N of centre
          </span>
        )}
        <span>
          {view.result.frames.length} images, aligned on {mjdToIsoDate(refMjd)}
        </span>
      </p>
      <p className={styles.legend}>
        {SNR_TEXT} {CLIPPED_MEAN_TEXT}
      </p>
      {isSaturatedCore(cube.meta) && <p className={styles.warning}>{SATURATED_STACK_NOTE}</p>}

      <MotionInput
        label="East"
        hint="RA motion, ″/yr"
        value={current.pmRa}
        onChange={(v) => update({ pmRa: v })}
      />
      <MotionInput
        label="North"
        hint="Dec motion, ″/yr"
        value={current.pmDec}
        onChange={(v) => update({ pmDec: v })}
      />

      <div className={`${styles.controls} ${styles.wrap}`}>
        <button type="button" onClick={() => update({ pmRa: 0, pmDec: 0 })} aria-pressed={total === 0}>
          No motion (0, 0)
        </button>
        {catalogueMotion && (
          <button
            type="button"
            className={styles.play}
            onClick={() => update({ pmRa: catalogueMotion.pmRa, pmDec: catalogueMotion.pmDec })}
            aria-pressed={atCatalogue}
          >
            Catalogue: {catalogueMotion.source}
          </button>
        )}
        <label className={styles.options}>
          Combine{" "}
          <select value={combine} onChange={(e) => update({ combine: e.target.value as StackMode })}>
            {MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
                {m.value === autoMode ? " (suggested)" : ""}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className={styles.legend}>
        Each image is shifted back along the motion you set, then all are combined. If the motion matches the
        object&apos;s, its light lands on the same pixel every time and it shows up as a tight, bright spot; with
        the wrong motion it smears out or fades. The ring marks the highest SNR within {PEAK_RADIUS_ARCSEC}″ of the
        search point (dashed circle; click the image to move it). Both panels keep the scale of the unshifted
        stack, so a gain is visible. SNR here is per pixel of the {pix}″ display grid, not the SNR of a
        measurement. Suggested combine: mean for bright stars (clipping would cut their real light, which changes
        with wavelength), clipped mean for faint ones (a single cosmic ray outshines them in a plain mean).
        {boxed &&
          ` This field is wide, so only a ${(2 * STACK_BOX_ARCSEC) / 60}′ box around the search point is stacked, to keep the sliders fast.`}
      </p>

      {sixPossible && (
        <section className={styles.measureSection} aria-labelledby="six-title">
          <h3 id="six-title">All six detectors</h3>
          {showSix ? (
            <SixDetectors
              cube={cube}
              cubeUrl={cubeUrl!}
              pmRa={pmRa}
              pmDec={pmDec}
              at={at}
              refMjd={refMjd}
              mode={mode}
              onPickBand={onPickBand}
            />
          ) : (
            <div className={`${styles.controls} ${styles.wrap}`}>
              <button type="button" onClick={() => setShowSix(true)}>
                Stack all six detectors
              </button>
              <span className={styles.legend}>Same motion and point, one image per detector (0.75–5 µm).</span>
            </div>
          )}
        </section>
      )}

      <Search
        cube={cube}
        catalogueMotion={catalogueMotion}
        centre={{ x: current.searchX, y: current.searchY }}
        current={{ pmRa: current.pmRa, pmDec: current.pmDec }}
        onPick={(ra, dec) => update({ pmRa: clampMotion(ra, PM_MAX), pmDec: clampMotion(dec, PM_MAX) })}
      />
    </div>
  );
}

export default Stack;
