// Run the velocity search off the main thread (role P, task P-04), and shape its result for a
// heatmap. Why a worker: see grid.worker.ts.
//
//   const r = await runGrid(cube, { centerX, centerY }, (done, total) => setProgress(done / total));
//   const h = heatmapData(r, { pmRa: -7.97, pmDec: 0.81 });
//
// Each call starts its own worker and stops it when done, so a search can be cancelled at any time
// (AbortSignal) by stopping the worker. Where `Worker` does not exist (Node tests, server
// rendering) the search runs on the calling thread instead, with the same result.

import { velocityGrid, type GridOptions, type GridResult, type VectorScore } from "./grid";
import type { WorkerJob, WorkerReply, WorkerRequest } from "./grid.worker";
import { falseAlarm, type FalseAlarmResult, type SignificanceOptions } from "./significance";
import type { StackableCube } from "./stack";

export type Progress = (done: number, total: number) => void;

/** The part of a Web Worker that run.ts uses; tests pass an in-process stand-in. */
export interface WorkerLike {
  postMessage(message: WorkerRequest, transfer?: Transferable[]): void;
  onmessage: ((e: { data: WorkerReply }) => void) | null;
  onerror: ((e: { message?: string }) => void) | null;
  terminate(): void;
}

export interface RunOptions {
  /** Abort the search: the worker is stopped and the promise rejects with an AbortError. */
  signal?: AbortSignal;
  /** Make the worker. Default: a module worker running grid.worker.ts; main thread if `Worker` is missing. */
  createWorker?: () => WorkerLike;
}

/** A module worker on grid.worker.ts. The `new URL(..., import.meta.url)` form is what Next.js
 *  (Turbopack and webpack) recognises to bundle the worker file. */
export function createSearchWorker(): WorkerLike {
  const worker = new Worker(new URL("./grid.worker.ts", import.meta.url), { type: "module", name: "velocity-search" });
  // A Worker's handlers receive full MessageEvent/ErrorEvent objects; run.ts reads only `data`
  // and `message`, which is all WorkerLike promises.
  return worker as unknown as WorkerLike;
}

/** Only what the search reads, so the message holds no functions or large unrelated metadata. */
function plainCube(cube: StackableCube): StackableCube {
  return {
    n: cube.n,
    h: cube.h,
    w: cube.w,
    data: cube.data,
    meta: {
      pixscale_arcsec: cube.meta.pixscale_arcsec,
      frames: cube.meta.frames.map((f) => ({ mjd: f.mjd, noise: f.noise })),
    },
  };
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The search was aborted", "AbortError");
}

let nextId = 1;

function run<T>(cube: StackableCube, job: WorkerJob, onProgress: Progress | undefined, opts: RunOptions): Promise<T> {
  const { signal } = opts;
  if (signal?.aborted) return Promise.reject(abortError(signal));
  const make = opts.createWorker ?? (typeof Worker === "function" ? createSearchWorker : null);
  if (!make) return runHere<T>(cube, job, onProgress, signal);

  return new Promise<T>((resolve, reject) => {
    const id = nextId++;
    const worker = make();
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => finish(() => reject(abortError(signal!)));
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.onmessage = ({ data }) => {
      if (data.id !== id || settled) return;
      if (data.type === "progress") onProgress?.(data.done, data.total);
      else if (data.type === "error") finish(() => reject(new Error(data.message)));
      else finish(() => resolve(data.result as T));
    };
    worker.onerror = (e) => finish(() => reject(new Error(`search worker failed: ${e.message ?? "unknown error"}`)));
    // The cube is copied, not transferred: the page keeps using it.
    worker.postMessage({ id, cube: plainCube(cube), job });
  });
}

/** Fallback without workers: same computation on this thread, after yielding once. */
function runHere<T>(cube: StackableCube, job: WorkerJob, onProgress: Progress | undefined, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    setTimeout(() => {
      if (signal?.aborted) return reject(abortError(signal));
      try {
        const result =
          job.kind === "grid"
            ? velocityGrid(cube, { ...job.options, onProgress })
            : falseAlarm(cube, job.n, { ...job.options, onProgress });
        resolve(result as T);
      } catch (e) {
        reject(e);
      }
    }, 0);
  });
}

/** velocityGrid() in a worker. Resolves with exactly what velocityGrid(cube, options) returns. */
export function runGrid(
  cube: StackableCube,
  options: Omit<GridOptions, "onProgress"> = {},
  onProgress?: Progress,
  opts: RunOptions = {},
): Promise<GridResult> {
  return run<GridResult>(cube, { kind: "grid", options }, onProgress, opts);
}

/** falseAlarm() (significance.ts) in a worker; progress counts searches, n + 1 in total. */
export function runFalseAlarm(
  cube: StackableCube,
  n: number,
  options: Omit<SignificanceOptions, "onProgress"> = {},
  onProgress?: Progress,
  opts: RunOptions = {},
): Promise<FalseAlarmResult> {
  return run<FalseAlarmResult>(cube, { kind: "falseAlarm", n, options }, onProgress, opts);
}

// ---------- heatmap data ----------

/** A motion placed on the heatmap. col/row are in cell units with north up: the centre of the cell
 *  in display column c, row r is (c + 0.5, r + 0.5); values between cells are allowed. Same
 *  convention as viewer/searchView.ts vectorToCell. */
export interface HeatmapMarker {
  pmRa: number;
  pmDec: number;
  col: number;
  row: number;
  /** Score of this motion, if it was stacked. */
  snr?: number;
}

export interface HeatmapData {
  nx: number;
  ny: number;
  /** Grid step, arcsec/yr: one cell is step × step. */
  step: number;
  /** Cell centres, ascending (copies of the grid axes). */
  pmRaAxis: number[];
  pmDecAxis: number[];
  /** Outer cell edges, arcsec/yr: left/right are pmRa, bottom/top are pmDec. */
  extent: { left: number; right: number; bottom: number; top: number };
  /** Scores in display order: values[row * nx + col], row 0 = most positive pmDec (north up),
   *  col 0 = most negative pmRa. NaN where a motion had no data. */
  values: Float32Array;
  /** Lowest and highest finite score, for the colour scale. */
  lo: number;
  hi: number;
  markers: {
    /** Fitted best motion (velocityGrid `best`). */
    best: HeatmapMarker;
    /** Best grid cell. */
    gridBest: HeatmapMarker;
    /** Not moving. */
    zero: HeatmapMarker;
    /** Catalogue motion if given, with its distance from `best`. */
    catalogue?: HeatmapMarker & { fromBest: number };
  };
}

type HeatmapSource = Pick<GridResult, "pmRaAxis" | "pmDecAxis" | "score" | "step" | "best" | "gridBest">;

/** Place a motion on the heatmap (fractional cell units, north up). */
export function markerAt(r: Pick<GridResult, "pmRaAxis" | "pmDecAxis" | "step">, pmRa: number, pmDec: number): HeatmapMarker {
  const ny = r.pmDecAxis.length;
  return {
    pmRa,
    pmDec,
    col: (pmRa - r.pmRaAxis[0]) / r.step + 0.5,
    row: ny - ((pmDec - r.pmDecAxis[0]) / r.step + 0.5),
  };
}

/** Everything a heatmap needs from a search result, oriented for drawing. */
export function heatmapData(r: HeatmapSource, catalogue?: { pmRa: number; pmDec: number }): HeatmapData {
  const nx = r.pmRaAxis.length;
  const ny = r.pmDecAxis.length;
  if (r.score.length !== nx * ny) throw new Error(`score has ${r.score.length} cells, axes give ${nx * ny}`);
  const values = new Float32Array(nx * ny);
  let lo = Infinity;
  let hi = -Infinity;
  for (let row = 0; row < ny; row++) {
    const j = ny - 1 - row;
    for (let col = 0; col < nx; col++) {
      const v = r.score[j * nx + col];
      values[row * nx + col] = v;
      if (Number.isFinite(v)) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
  }
  const scored = (s: VectorScore): HeatmapMarker => ({ ...markerAt(r, s.pmRa, s.pmDec), snr: s.snr });
  const i0 = r.pmRaAxis.indexOf(0);
  const j0 = r.pmDecAxis.indexOf(0);
  const zero = markerAt(r, 0, 0);
  if (i0 >= 0 && j0 >= 0) zero.snr = r.score[j0 * nx + i0];
  const half = r.step / 2;
  return {
    nx,
    ny,
    step: r.step,
    pmRaAxis: [...r.pmRaAxis],
    pmDecAxis: [...r.pmDecAxis],
    extent: {
      left: r.pmRaAxis[0] - half,
      right: r.pmRaAxis[nx - 1] + half,
      bottom: r.pmDecAxis[0] - half,
      top: r.pmDecAxis[ny - 1] + half,
    },
    values,
    lo,
    hi,
    markers: {
      best: scored(r.best),
      gridBest: scored(r.gridBest),
      zero,
      catalogue: catalogue
        ? {
            ...markerAt(r, catalogue.pmRa, catalogue.pmDec),
            fromBest: Math.hypot(catalogue.pmRa - r.best.pmRa, catalogue.pmDec - r.best.pmDec),
          }
        : undefined,
    },
  };
}
