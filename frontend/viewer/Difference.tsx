"use client";

// Compare two visits (role B, task B-02): median image of each epoch, their difference B − A in
// red / blue, or a blink between the two medians on one shared brightness scale.
//
//   <Difference cube={cube} />      (Viewer.tsx shows it under the "Compare visits" tab)

import { useEffect, useMemo, useRef, useState } from "react";
import { mjdToIsoDate, renderFrame, type Cube, type StretchMode } from "./cube";
import {
  DIFF_NAN_RGB,
  DIFF_NEG_RGB,
  DIFF_POS_RGB,
  defaultEpochPair,
  differenceImage,
  differenceLimit,
  epochMedian,
  groupEpochs,
  renderDifference,
  sharedLimits,
  type Epoch,
} from "./epochs";
import { JULIAN_YEAR_DAYS } from "../search/stack";
import { SkyOverlay } from "./SkyOverlay";
import { VISIT_TEXT } from "./words";
import styles from "./Viewer.module.css";

export interface DifferenceProps {
  cube: Cube;
  /** Brightness scale for the blink view. */
  mode?: StretchMode;
  showCentre?: boolean;
}

type View = "difference" | "blink";

const BLINK_HZ = [1, 2, 4];
const rgb = (c: readonly number[]) => `rgb(${c.join(" ")})`;

function epochLabel(e: Epoch): string {
  const start = mjdToIsoDate(e.mjdMin);
  const end = mjdToIsoDate(e.mjdMax);
  const dates = start === end ? start : `${start} – ${end.slice(5)}`;
  return `Visit ${e.epoch + 1}: ${dates} (${e.frames.length} image${e.frames.length === 1 ? "" : "s"})`;
}

function lamRange(e: Epoch): string {
  if (!Number.isFinite(e.lamMin)) return "";
  return e.lamMin === e.lamMax ? `${e.lamMin.toFixed(2)} µm` : `${e.lamMin.toFixed(2)}–${e.lamMax.toFixed(2)} µm`;
}

export function Difference({ cube, mode = "linear", showCentre = true }: DifferenceProps) {
  const epochs = useMemo(() => groupEpochs(cube.meta.frames), [cube]);
  const pair = useMemo(() => defaultEpochPair(epochs), [epochs]);
  const [choice, setChoice] = useState<{ cube: Cube; a: number; b: number } | null>(null);
  const [view, setView] = useState<View>("difference");
  const [blinkHz, setBlinkHz] = useState(2);
  const [blinking, setBlinking] = useState(true);
  const [showB, setShowB] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // A choice made for another cube is stale; fall back to the default pair.
  const a = choice?.cube === cube ? choice.a : (pair?.[0] ?? 0);
  const b = choice?.cube === cube ? choice.b : (pair?.[1] ?? 0);

  // Median of every epoch, once per cube (a few ms for 60 frames of 61 x 61).
  const medians = useMemo(() => epochs.map((e) => epochMedian(cube, e)), [cube, epochs]);
  const imgA = medians[a]?.image;
  const imgB = medians[b]?.image;

  const diff = useMemo(() => (imgA && imgB ? differenceImage(imgA, imgB) : null), [imgA, imgB]);
  const diffLimit = useMemo(() => (diff ? differenceLimit(diff) : NaN), [diff]);
  const blinkLimits = useMemo(() => (imgA && imgB ? sharedLimits(imgA, imgB) : null), [imgA, imgB]);

  useEffect(() => {
    if (view !== "blink" || !blinking) return;
    const timer = setInterval(() => setShowB((s) => !s), 1000 / blinkHz / 2);
    return () => clearInterval(timer);
  }, [view, blinking, blinkHz]);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx || !diff || !imgA || !imgB || !blinkLimits) return;
    const image = ctx.createImageData(cube.w, cube.h);
    if (view === "difference") renderDifference(diff, diffLimit, image.data);
    else renderFrame(showB ? imgB : imgA, blinkLimits, mode, image.data);
    ctx.putImageData(image, 0, 0);
  }, [cube, view, diff, diffLimit, imgA, imgB, blinkLimits, showB, mode]);

  if (!pair) {
    return (
      <p className={styles.legend}>
        All {cube.n} images of this position were taken in a single visit
        {epochs[0] ? ` (${mjdToIsoDate(epochs[0].mjdMin)})` : ""}, so there is no second date to compare with.
      </p>
    );
  }

  const eA = epochs[a];
  const eB = epochs[b];
  const dtDays = eB.mjdMean - eA.mjdMean;
  const dtYears = dtDays / JULIAN_YEAR_DAYS;
  const shown = showB ? eB : eA;
  const viewLabel =
    view === "difference"
      ? `Difference image: visit ${eB.epoch + 1} minus visit ${eA.epoch + 1}. Red is brighter in visit ${eB.epoch + 1}, blue is brighter in visit ${eA.epoch + 1}. North is up, east is left.`
      : `Median image of visit ${shown.epoch + 1}, ${mjdToIsoDate(shown.mjdMin)}. North is up, east is left.`;

  const select = (which: "a" | "b", value: number) =>
    setChoice({ cube, a: which === "a" ? value : a, b: which === "b" ? value : b });

  return (
    <div className={styles.compare}>
      <div className={styles.pickers}>
        <label>
          <span className={styles.pickTag} style={{ color: rgb(DIFF_NEG_RGB) }}>
            A
          </span>
          <select value={a} onChange={(e) => select("a", Number(e.target.value))}>
            {epochs.map((e) => (
              <option key={e.epoch} value={e.epoch}>
                {epochLabel(e)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className={styles.pickTag} style={{ color: rgb(DIFF_POS_RGB) }}>
            B
          </span>
          <select value={b} onChange={(e) => select("b", Number(e.target.value))}>
            {epochs.map((e) => (
              <option key={e.epoch} value={e.epoch}>
                {epochLabel(e)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className={styles.segmented} role="group" aria-label="How to compare">
        <button type="button" aria-pressed={view === "difference"} onClick={() => setView("difference")}>
          Difference B − A
        </button>
        <button type="button" aria-pressed={view === "blink"} onClick={() => setView("blink")}>
          Blink A ↔ B
        </button>
      </div>

      <div className={styles.stage} style={{ aspectRatio: `${cube.w} / ${cube.h}` }}>
        <canvas
          ref={canvasRef}
          className={styles.canvas}
          width={cube.w}
          height={cube.h}
          role="img"
          aria-label={viewLabel}
        />
        <SkyOverlay w={cube.w} h={cube.h} pixscaleArcsec={cube.meta.pixscale_arcsec} showCentre={showCentre} />
        {view === "blink" && <span className={styles.stageTag}>{showB ? "B" : "A"}</span>}
      </div>

      {view === "blink" && (
        <div className={styles.controls}>
          <button
            type="button"
            className={styles.play}
            onClick={() => setBlinking(!blinking)}
            aria-pressed={blinking}
          >
            {blinking ? "Pause" : "Blink"}
          </button>
          <button
            type="button"
            onClick={() => {
              setBlinking(false);
              setShowB(!showB);
            }}
          >
            Show {showB ? "A" : "B"}
          </button>
          <label className={styles.options}>
            Speed{" "}
            <select value={blinkHz} onChange={(e) => setBlinkHz(Number(e.target.value))}>
              {BLINK_HZ.map((hz) => (
                <option key={hz} value={hz}>
                  {hz} per second
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      <p className={styles.info}>
        <strong>
          {Math.abs(dtDays) < 1 ? "Same visit" : `${Math.abs(dtDays).toFixed(0)} days apart`}
        </strong>
        {Math.abs(dtYears) >= 0.1 && <span>{Math.abs(dtYears).toFixed(2)} years</span>}
        <span>
          A {lamRange(eA)} · B {lamRange(eB)}
        </span>
      </p>

      <p className={styles.legend}>{VISIT_TEXT}</p>
      {view === "difference" ? (
        <p className={styles.legend}>
          <span className={styles.swatch} style={{ background: rgb(DIFF_POS_RGB) }} /> brighter in B (where a moving
          star is now) · <span className={styles.swatch} style={{ background: rgb(DIFF_NEG_RGB) }} /> brighter in A
          (where it was) · <span className={styles.swatch} style={{ background: rgb(DIFF_NAN_RGB) }} /> no data. Each
          visit is the median of its images. Stars that did not move cancel out to black; a star that moved leaves a
          blue–red pair pointing in the direction of motion. Faint leftovers at fixed stars are expected: the images
          of a visit are taken at different wavelengths, so the two medians do not match exactly.
        </p>
      ) : (
        <p className={styles.legend}>
          Both visits use one brightness scale, so a star that moved appears to jump against the centre mark, and a
          star that changed brightness flickers. The two visits cover slightly different wavelengths, which also
          changes brightness a little.
        </p>
      )}
    </div>
  );
}

export default Difference;
