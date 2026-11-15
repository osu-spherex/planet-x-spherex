"use client";

// "Motion search" (role B, tasks B-05, B-06): try every proper motion on a grid and show how well
// each one stacks up as a heatmap; then, on request, test whether the motion could be luck by searching
// again with the frame times shuffled. Both searches are role P's and run in a Web Worker
// (search/run.ts), so the page stays responsive and shows real progress. Clicking the heatmap
// sends that motion to the Stack sliders. The wording follows search/README.md.
//
// "Combine D5 + D6" (role P, task P-09): for a target too faint for single images, the two
// long-wavelength detectors can be searched as one stack (search/stackMulti.ts, images weighted by
// 1/noise²). Tested on WISE 0855 (search/README.md, "On the real six-detector cubes"): higher
// score, motion still on the target, shuffle test passed. Not offered for all six detectors: there
// the stack locks onto a neighbouring star. This search has no worker yet, so it runs on the
// page's own thread (a pause of a few seconds) and the shuffle test is not run live for it.

import { useEffect, useMemo, useRef, useState } from "react";
import type { GridResult } from "../search/grid";
import results from "../search/results.json";
import { runFalseAlarm, runGrid } from "../search/run";
import { brightnessScale } from "../search/stack";
import { velocityGridMulti } from "../search/stackMulti";
import { niceTicks } from "./charts";
import { loadCube, type Cube } from "./cube";
import { isSaturatedCore } from "./overlayData";
import {
  CATALOGUE_TOLERANCE,
  SEARCH_SNR_MIN,
  SHUFFLES,
  cellToVector,
  expectedStacks,
  gridVerdict,
  renderHeatmap,
  searchPathLine,
  shuffleSentence,
  summarizeShuffles,
  vectorToCell,
  viridis,
  type ShuffleSummary,
} from "./searchView";
import type { CatalogueMotion } from "./Stack";
import { PEAK_RADIUS_ARCSEC, STACK_BOX_ARCSEC, arcsecToPx } from "./stackView";
import styles from "./Viewer.module.css";

/** P-10 (issue #100): how much the best motion beats "not moving" on Barnard's Star D1, the
 *  saturated demo star, in % (search/results.json, recomputed by search/numbers.test.ts). */
const BARNARD = results.objects.find((o) => o.id === "barnard");
const SATURATED_MARGIN_PCT = BARNARD ? Math.round((BARNARD.snrBest / BARNARD.snrZero - 1) * 100) : NaN;

export interface SearchProps {
  cube: Cube;
  catalogueMotion?: CatalogueMotion;
  /** Centre of the search region, cube pixels. */
  centre: { x: number; y: number };
  /** Motion currently set on the Stack sliders, marked on the heatmap. */
  current: { pmRa: number; pmDec: number };
  onPick: (pmRa: number, pmDec: number) => void;
}

/** The pair of detectors that can be searched together, in stacking order (task P-09). */
const PAIR = ["D5", "D6"] as const;
const PAIR_LABEL = PAIR.join(" + ");

/** cube.json of the pair's other detector for a static cube (/cubes/<object>/<band>/), else null. */
export function pairCubeUrl(meta: Pick<Cube["meta"], "object" | "band" | "source">): string | null {
  const other = PAIR.find((b) => b !== meta.band);
  if (!meta.object || !meta.source?.from_cache || !PAIR.some((b) => b === meta.band) || !other) return null;
  return `/cubes/${meta.object}/${other}/cube.json`;
}

type Job<T> =
  | { phase: "idle" }
  | { phase: "running"; key: string; done: number; total: number }
  | { phase: "done"; key: string; value: T }
  | { phase: "error"; key: string; message: string };

/** "+1.5", "−0.3", "0.0": a value that rounds to zero gets no sign. */
const fmt = (v: number, d = 1) => {
  const s = Math.abs(v).toFixed(d);
  if (Number(s) === 0) return s;
  return v < 0 ? `−${s}` : `+${s}`;
};
const rgb = (c: readonly number[]) => `rgb(${c.join(" ")})`;
const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function ProgressBar({ done, total, label }: { done: number; total: number; label: string }) {
  const pct = total > 0 ? Math.round((100 * done) / total) : 0;
  return (
    <div className={styles.progressRow}>
      <progress className={styles.progressBar} max={total || 1} value={done} aria-label={label} />
      <span className={styles.legend} role="status">
        {label}: {done} of {total} ({pct} %)
      </span>
    </div>
  );
}

export function Search({ cube, catalogueMotion, centre, current, onPick }: SearchProps) {
  const [grid, setGrid] = useState<Job<GridResult>>({ phase: "idle" });
  const [shuffle, setShuffle] = useState<Job<ShuffleSummary>>({ phase: "idle" });
  const [combine, setCombine] = useState(false);
  const gridAbort = useRef<AbortController | null>(null);
  const shuffleAbort = useRef<AbortController | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pairCache = useRef<{ url: string; cube: Cube } | null>(null);

  // Combining is for targets no single image shows: stackMulti has no common-brightness rule, so
  // it is offered only where the one-detector search also stacks the images as they are.
  const pairUrl = pairCubeUrl(cube.meta);
  const searchRadius = arcsecToPx(cube, PEAK_RADIUS_ARCSEC);
  const faint = useMemo(
    () => pairUrl !== null && brightnessScale(cube, centre.x, centre.y, searchRadius) === null,
    [pairUrl, cube, centre.x, centre.y, searchRadius],
  );
  const combined = combine && pairUrl !== null && faint;

  // Results belong to one cube, one search centre and one choice of detectors; a change stops
  // what is still running.
  const key = `${cube.meta.frames[0]?.id}|${cube.n}|${centre.x}|${centre.y}|${combined ? PAIR_LABEL : ""}`;
  useEffect(() => {
    return () => {
      gridAbort.current?.abort();
      shuffleAbort.current?.abort();
    };
  }, [key]);

  const result = grid.phase === "done" && grid.key === key ? grid.value : null;
  const gridRunning = grid.phase === "running" && grid.key === key ? grid : null;
  const gridError = grid.phase === "error" && grid.key === key ? grid.message : null;
  const shuffled = shuffle.phase === "done" && shuffle.key === key ? shuffle.value : null;
  const shuffleRunning = shuffle.phase === "running" && shuffle.key === key ? shuffle : null;
  const shuffleError = shuffle.phase === "error" && shuffle.key === key ? shuffle.message : null;
  // Radii in arcsec so any cube size works: 12″ search radius (P's default, 4 px at 3″) and a 90″
  // noise box (the whole 3′ cube, so 3′ results are unchanged; wide cubes stay fast).
  const options = {
    centerX: centre.x,
    centerY: centre.y,
    radius: searchRadius,
    noiseBox: arcsecToPx(cube, STACK_BOX_ARCSEC),
  };

  /** Both detectors of the pair in one search, on this thread (see the top of the file). */
  const runCombined = (url: string, ac: AbortController) => {
    setGrid({ phase: "running", key, done: 0, total: 0 });
    const cached = pairCache.current?.url === url ? pairCache.current.cube : null;
    (cached ? Promise.resolve(cached) : loadCube(url))
      .then((other) => {
        pairCache.current = { url, cube: other };
        if (brightnessScale(other, centre.x, centre.y, searchRadius) !== null) {
          throw new Error(`single ${other.meta.band} images show this target, and the combined search is only for fainter ones`);
        }
        // A short wait so that "Searching…" is on screen before the page pauses.
        return new Promise<GridResult>((resolve, reject) => {
          setTimeout(() => {
            if (ac.signal.aborted) return reject(new DOMException("The search was aborted", "AbortError"));
            try {
              // Always in PAIR order, whichever detector is on screen (throws if the grids differ).
              resolve(velocityGridMulti(cube.meta.band === PAIR[0] ? [cube, other] : [other, cube], options));
            } catch (e) {
              reject(e);
            }
          }, 60);
        });
      })
      .then(
        (value) => {
          if (!ac.signal.aborted) setGrid({ phase: "done", key, value });
        },
        (e) => setGrid(isAbort(e) || ac.signal.aborted ? { phase: "idle" } : { phase: "error", key, message: message(e) }),
      );
  };

  const runSearch = () => {
    gridAbort.current?.abort();
    shuffleAbort.current?.abort();
    const ac = new AbortController();
    gridAbort.current = ac;
    setShuffle({ phase: "idle" });
    if (combined && pairUrl) return runCombined(pairUrl, ac);
    setGrid({ phase: "running", key, done: 0, total: expectedStacks(cube.meta.frames, cube.meta.pixscale_arcsec) });
    runGrid(cube, options, (done, total) => !ac.signal.aborted && setGrid({ phase: "running", key, done, total }), {
      signal: ac.signal,
    }).then(
      (value) => setGrid({ phase: "done", key, value }),
      (e) => setGrid(isAbort(e) ? { phase: "idle" } : { phase: "error", key, message: message(e) }),
    );
  };

  const runShuffles = () => {
    shuffleAbort.current?.abort();
    const ac = new AbortController();
    shuffleAbort.current = ac;
    setShuffle({ phase: "running", key, done: 0, total: SHUFFLES + 1 });
    runFalseAlarm(
      cube,
      SHUFFLES,
      options,
      (done, total) => !ac.signal.aborted && setShuffle({ phase: "running", key, done, total }),
      { signal: ac.signal },
    ).then(
      (fa) => setShuffle({ phase: "done", key, value: summarizeShuffles(fa) }),
      (e) => setShuffle(isAbort(e) ? { phase: "idle" } : { phase: "error", key, message: message(e) }),
    );
  };

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx || !result) return;
    const nx = result.pmRaAxis.length;
    const ny = result.pmDecAxis.length;
    const image = ctx.createImageData(nx, ny);
    image.data.set(renderHeatmap(result.score, nx, ny).rgba);
    ctx.putImageData(image, 0, 0);
  }, [result]);

  const stacks = expectedStacks(cube.meta.frames, cube.meta.pixscale_arcsec);
  const offCentre = centre.x !== (cube.w - 1) / 2 || centre.y !== (cube.h - 1) / 2;
  const pix = cube.meta.pixscale_arcsec;
  const where = offCentre
    ? `around ${fmt(((cube.w - 1) / 2 - centre.x) * pix, 0)}″ E, ${fmt(((cube.h - 1) / 2 - centre.y) * pix, 0)}″ N of the centre`
    : "around the centre";

  return (
    <section className={styles.measureSection} aria-labelledby="search-title">
      <h3 id="search-title">Motion search: try every motion</h3>
      <p className={styles.legend}>
        Instead of guessing the motion, try them all: {stacks} stacks for motions up to 15″/yr in every direction,
        each scored by its highest SNR within 12″ {where}. Click the image above to search somewhere else.
      </p>
      {isSaturatedCore(cube.meta) && (
        <p className={styles.notice}>
          Saturated star: its centre is missing in most images, so the motion this search finds is not steady (on
          Barnard&apos;s Star the right motion beats &ldquo;not moving&rdquo; by only {SATURATED_MARGIN_PCT} %). Use the
          Measure tab for this star&apos;s motion.
        </p>
      )}
      <div className={`${styles.controls} ${styles.wrap}`}>
        <button type="button" className={styles.play} onClick={runSearch} disabled={gridRunning !== null}>
          {gridRunning ? "Searching…" : result ? "Search again" : "Search"}
        </button>
        {gridRunning && !combined && (
          <button type="button" onClick={() => gridAbort.current?.abort()}>
            Cancel
          </button>
        )}
        {pairUrl && faint && (
          <label>
            <input
              type="checkbox"
              checked={combine}
              disabled={gridRunning !== null}
              onChange={(e) => setCombine(e.target.checked)}
            />{" "}
            Combine {PAIR_LABEL}
          </label>
        )}
      </div>
      {combined && (
        <p className={styles.legend}>
          {PAIR_LABEL}: the two detectors above 3.8 µm in one stack, each image weighted by its noise, for targets too
          faint for single images. This search runs on the page itself, so the page pauses for a few seconds. All
          six detectors are not offered: for WISE 0855 the other four show a neighbouring star (see How it works).
        </p>
      )}
      {gridRunning && !combined && <ProgressBar done={gridRunning.done} total={gridRunning.total} label="Motions tried" />}
      {gridRunning && combined && (
        <p className={styles.legend} role="status">
          Loading the other detector and searching both…
        </p>
      )}
      {gridError && (
        <p className={styles.error} role="alert">
          The search failed: {gridError}
        </p>
      )}
      {result && (
        <>
          <Heatmap result={result} catalogueMotion={catalogueMotion} current={current} onPick={onPick} canvasRef={canvasRef} />
          <GridSummary
            result={result}
            catalogueMotion={catalogueMotion}
            nFrames={combined ? (result.framesUsed ?? cube.n) : cube.n}
            combined={combined}
          />
          {combined && gridVerdict(result).kind === "source" && (
            <CombinedShuffleNote result={result} objectId={cube.meta.object} offCentre={offCentre} />
          )}

          {!combined && gridVerdict(result).kind === "source" && (
            <>
              <div className={`${styles.controls} ${styles.wrap}`}>
                <button type="button" onClick={runShuffles} disabled={shuffleRunning !== null}>
                  {shuffleRunning ? "Testing…" : shuffled ? "Test again" : "How sure is this?"}
                </button>
                {shuffleRunning && (
                  <button type="button" onClick={() => shuffleAbort.current?.abort()}>
                    Cancel
                  </button>
                )}
              </div>
              {!shuffled && !shuffleRunning && (
                <p className={styles.legend}>
                  Runs the same search {SHUFFLES} more times with the dates of the images shuffled: at least{" "}
                  {Math.max(1, Math.round(((SHUFFLES + 1) * result.elapsedMs) / 60000))} min, longer on a phone. The page
                  stays usable meanwhile.
                </p>
              )}
              {shuffleRunning && (
                <ProgressBar done={shuffleRunning.done} total={shuffleRunning.total} label="Searches (real order + shuffles)" />
              )}
              {shuffleError && (
                <p className={styles.error} role="alert">
                  The test failed: {shuffleError}
                </p>
              )}
              {shuffled && <ShuffleResult s={shuffled} result={result} />}
            </>
          )}
        </>
      )}
    </section>
  );
}

function Heatmap({
  result,
  catalogueMotion,
  current,
  onPick,
  canvasRef,
}: {
  result: GridResult;
  catalogueMotion?: CatalogueMotion;
  current: { pmRa: number; pmDec: number };
  onPick: (pmRa: number, pmDec: number) => void;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
}) {
  const nx = result.pmRaAxis.length;
  const ny = result.pmDecAxis.length;
  const { lo, hi } = renderHeatmap(result.score, nx, ny);
  const best = vectorToCell(result, result.best.pmRa, result.best.pmDec);
  const zero = vectorToCell(result, 0, 0);
  const cat = catalogueMotion ? vectorToCell(result, catalogueMotion.pmRa, catalogueMotion.pmDec) : null;
  const cur = vectorToCell(result, current.pmRa, current.pmDec);
  const max = result.pmRaAxis[nx - 1] + result.step / 2;
  const ticks = niceTicks(-max, max, 4).filter((t) => Math.abs(t) <= max);
  const inside = (p: { x: number; y: number }) => p.x >= 0 && p.x <= nx && p.y >= 0 && p.y <= ny;

  const pick = (e: React.MouseEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - box.left) / box.width) * nx;
    const y = ((e.clientY - box.top) / box.height) * ny;
    const p = cellToVector(result, x, y);
    onPick(Math.round(p.pmRa * 10) / 10, Math.round(p.pmDec * 10) / 10);
  };

  return (
    <>
      <div className={styles.heatWrap}>
        <span className={styles.heatYLabel}>north motion (″/yr)</span>
        <div className={styles.heatPlot}>
          <div
            className={styles.stage}
            style={{ aspectRatio: `${nx} / ${ny}`, cursor: "crosshair" }}
            onClick={pick}
            title="Click to stack with this motion"
          >
            <canvas
              ref={canvasRef}
              className={styles.canvas}
              width={nx}
              height={ny}
              role="img"
              aria-label={`Search scores for ${nx * ny} motions. Best: east ${result.best.pmRa.toFixed(1)}, north ${result.best.pmDec.toFixed(1)} arcseconds per year, SNR ${result.best.snr.toFixed(1)}.`}
            />
            <svg className={styles.overlay} viewBox={`0 0 ${nx} ${ny}`} aria-hidden="true">
              <g className={styles.heatMarks}>
                <line x1={zero.x - 0.35} x2={zero.x + 0.35} y1={zero.y} y2={zero.y} />
                <line x1={zero.x} x2={zero.x} y1={zero.y - 0.35} y2={zero.y + 0.35} />
                {cat && inside(cat) && (
                  <rect
                    className={styles.heatCat}
                    x={cat.x - 0.3}
                    y={cat.y - 0.3}
                    width={0.6}
                    height={0.6}
                    transform={`rotate(45 ${cat.x} ${cat.y})`}
                  />
                )}
                <circle className={styles.heatBest} cx={best.x} cy={best.y} r={0.55} />
                {inside(cur) && <circle className={styles.heatCur} cx={cur.x} cy={cur.y} r={0.18} />}
              </g>
            </svg>
          </div>
          <div className={styles.heatXTicks}>
            {ticks.map((t) => (
              <span key={t} style={{ left: `${((t + max) / (2 * max)) * 100}%` }}>
                {t}
              </span>
            ))}
          </div>
          <span className={styles.heatXLabel}>east motion (″/yr)</span>
        </div>
      </div>

      <p className={styles.chartKeyLine}>
        <span
          className={styles.gradient}
          style={{ background: `linear-gradient(90deg, ${[0, 0.25, 0.5, 0.75, 1].map((t) => rgb(viridis(t))).join(", ")})` }}
        />
        SNR {lo.toFixed(1)} – {hi.toFixed(1)} · <span className={styles.keyRing} /> best · + not moving
        {catalogueMotion && (
          <>
            {" "}
            · <span className={styles.keyDiamond} /> {catalogueMotion.source}
          </>
        )}{" "}
        · <span className={styles.keyDot} /> current stack
      </p>
    </>
  );
}

/** Question 1 (is anything there?) and the catalogue check. Never claims motion. */
function GridSummary({
  result,
  catalogueMotion,
  nFrames,
  combined = false,
}: {
  result: GridResult;
  catalogueMotion?: CatalogueMotion;
  nFrames: number;
  /** The result is the two-detector search (task P-09). */
  combined?: boolean;
}) {
  const v = gridVerdict(result, catalogueMotion);
  // A-13 adds these to GridResult; read them loosely so this also compiles before that lands.
  const path = searchPathLine(result as GridResult & { normalised?: boolean; framesUsed?: number }, nFrames);
  return (
    <>
      {v.kind === "none" ? (
        <p className={styles.notice}>
          <strong>Nothing found.</strong> The best of all motions reaches SNR {v.bestSnr.toFixed(1)}, below{" "}
          {SEARCH_SNR_MIN}: empty sky reaches 2–4 when this many motions are tried.
        </p>
      ) : (
        <p className={styles.notice}>
          <strong>A source is there</strong> (best SNR {v.bestSnr.toFixed(1)}). Best motion east {fmt(result.best.pmRa)},
          north {fmt(result.best.pmDec)} ± {result.step.toFixed(1)}″/yr (one grid step). Not moving (0, 0) scores SNR{" "}
          {Number.isFinite(v.zeroSnr) ? v.zeroSnr.toFixed(1) : "–"}: a still source also stacks well, so this alone does
          not show that it moves.
          {!combined && (
            <>
              {" "}
              <em>How sure is this?</em> tests that.
            </>
          )}
        </p>
      )}
      {combined && (
        <p className={styles.legend}>
          {PAIR_LABEL} combined: {nFrames} images in one stack, each weighted by 1/noise².
        </p>
      )}
      {path && <p className={styles.legend}>{path}</p>}
      {v.catalogue && v.kind === "source" && (
        <p className={styles.legend}>
          Search check: the best motion is {v.catalogue.distance.toFixed(1)}″/yr from the {catalogueMotion?.source} value
          {v.catalogue.passes ? ` (within ${CATALOGUE_TOLERANCE})` : ` (more than ${CATALOGUE_TOLERANCE})`}. Agreeing with a
          catalogue checks the search; it is not evidence that SPHEREx measured the motion.
        </p>
      )}
      <p className={styles.legend}>
        The bright patch is wide because SPHEREx saw this field over only about {result.baselineYears.toFixed(1)} year
        {result.baselineYears >= 1.5 ? "s" : ""} with 6″ pixels: motions a few ″/yr apart move the object by less than a
        pixel. Search took {(result.elapsedMs / 1000).toFixed(1)} s.
      </p>
    </>
  );
}

/**
 * Question 2 for the two-detector search. Its shuffle test is not run in the browser (no worker
 * for it yet: 100 more searches would freeze the page), so the panel shows the run made ahead
 * (search/results.json "multi", checked by search/stackMulti.test.ts) when this result is the
 * one that run tested, and otherwise only says how to test one detector.
 */
function CombinedShuffleNote({ result, objectId, offCentre }: { result: GridResult; objectId?: string; offCentre: boolean }) {
  const s = results.multi.shuffles.find((m) => m.id === objectId && m.bands.join(" + ") === PAIR_LABEL);
  if (!s || offCentre || Math.abs(result.gridBest.snr - s.moving) >= 0.005) {
    return (
      <p className={styles.legend}>
        The shuffle test (<em>How sure is this?</em>) runs on one detector at a time: untick “Combine {PAIR_LABEL}” to
        run it.
      </p>
    );
  }
  const motion = `east ${fmt(result.best.pmRa)}, north ${fmt(result.best.pmDec)} ± ${result.step.toFixed(1)}″/yr`;
  const numbers = (
    <>
      {" "}
      {shuffleSentence(s)} Best moving score {s.moving.toFixed(1)}, not moving {s.zero.toFixed(1)}, highest shuffle{" "}
      {s.max.toFixed(1)}. This test was run ahead of time for this pair of detectors ({s.n} shuffles); it is not run in
      your browser.
    </>
  );
  return s.verdict === "detected" ? (
    <p className={styles.success}>
      <strong>Motion detected: {motion}.</strong>
      {numbers}
    </p>
  ) : (
    <p className={styles.warning}>
      <strong>A source is there. Its motion is consistent with {motion}, but these data do not establish it.</strong>
      {numbers}
    </p>
  );
}

/** Question 2 (does it move?), worded as in search/README.md. */
function ShuffleResult({ s, result }: { s: ShuffleSummary; result: GridResult }) {
  const motion = `east ${fmt(result.best.pmRa)}, north ${fmt(result.best.pmDec)} ± ${result.step.toFixed(1)}″/yr`;
  const numbers = (
    <>
      {" "}
      {shuffleSentence(s)} Best moving score {s.movingSnr.toFixed(1)}, not moving {s.zeroSnr.toFixed(1)}, highest
      shuffle {s.bestShuffle.toFixed(1)}.
    </>
  );
  if (s.kind === "detected") {
    return (
      <p className={styles.success}>
        <strong>Motion detected: {motion}.</strong>
        {numbers}
      </p>
    );
  }
  if (s.kind === "none") {
    return (
      <p className={styles.notice}>
        <strong>Nothing above the empty-sky level.</strong>
        {numbers}
      </p>
    );
  }
  const why =
    s.movingSnr <= s.zeroSnr
      ? "Not moving scores at least as high as any motion."
      : s.p >= 0.01 && s.pMin >= 0.01
        ? `${s.n} shuffles cannot reach p < 0.01.`
        : "Shuffled dates score this high too often.";
  return (
    <p className={styles.warning}>
      <strong>A source is there. Its motion is consistent with {motion}, but these data do not establish it.</strong>{" "}
      {why}
      {numbers}
    </p>
  );
}
