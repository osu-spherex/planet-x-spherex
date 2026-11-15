import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { velocityGrid, type GridResult } from "./grid";
import { handleRequest, type WorkerReply, type WorkerRequest } from "./grid.worker";
import { heatmapData, markerAt, runFalseAlarm, runGrid, type WorkerLike } from "./run";
import { falseAlarm, mulberry32 } from "./significance";
import { JULIAN_YEAR_DAYS, type StackableCube } from "./stack";

// ---------- an in-process stand-in for a Web Worker ----------

/**
 * Behaves like a worker as far as run.ts can tell: messages are copied with structuredClone (the
 * algorithm postMessage uses), transferred buffers are moved (detached on the sending side), and
 * everything is asynchronous. The handler is the real one from grid.worker.ts.
 */
function fakeWorker(log: { posted: WorkerRequest[]; transferred: ArrayBuffer[][]; terminated: boolean }) {
  const w: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message, transfer = []) {
      const req = structuredClone(message, { transfer });
      log.posted.push(req);
      setTimeout(() => {
        if (log.terminated) return;
        handleRequest(req, (reply, t = []) => {
          log.transferred.push(t as ArrayBuffer[]);
          const copy = structuredClone(reply, { transfer: t });
          setTimeout(() => {
            if (!log.terminated) w.onmessage?.({ data: copy });
          }, 0);
        });
      }, 0);
    },
    terminate() {
      log.terminated = true;
    },
  };
  return w;
}
const newLog = () => ({ posted: [] as WorkerRequest[], transferred: [] as ArrayBuffer[][], terminated: false });

// ---------- fixtures ----------

function noiseCube(size: number, seed: number, source?: { amp: number; pmRa: number; pmDec: number }): StackableCube {
  const rand = mulberry32(seed);
  const g = () => Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-12))) * Math.cos(2 * Math.PI * rand());
  const mjds: number[] = [];
  for (const [yr, k] of [[0, 3], [0.5, 4], [1, 3]]) for (let i = 0; i < k; i++) mjds.push(61000 + yr * JULIAN_YEAR_DAYS + i * 0.07);
  const ref = mjds.reduce((a, b) => a + b, 0) / mjds.length;
  const c = (size - 1) / 2;
  const data = new Float32Array(mjds.length * size * size);
  mjds.forEach((mjd, k) => {
    const dt = (mjd - ref) / JULIAN_YEAR_DAYS;
    const sx = source ? c - (source.pmRa * dt) / 3 : 0;
    const sy = source ? c - (source.pmDec * dt) / 3 : 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const s = source ? source.amp * Math.exp(-((x - sx) ** 2 + (y - sy) ** 2) / 2.88) : 0;
      data[k * size * size + y * size + x] = s + g();
    }
  });
  return { n: mjds.length, h: size, w: size, data, meta: { pixscale_arcsec: 3, frames: mjds.map((mjd) => ({ mjd })) } };
}

/** Same numbers everywhere, including the stack at the best motion. */
function expectSameGrid(a: GridResult, b: GridResult) {
  expect(a.pmRaAxis).toEqual(b.pmRaAxis);
  expect(a.pmDecAxis).toEqual(b.pmDecAxis);
  expect(Array.from(a.score)).toEqual(Array.from(b.score));
  expect(a.best).toEqual(b.best);
  expect(a.gridBest).toEqual(b.gridBest);
  expect(a.fitted).toBe(b.fitted);
  expect(a.step).toBe(b.step);
  expect(a.refMjd).toBe(b.refMjd);
  expect(a.nStacks).toBe(b.nStacks);
  expect(Array.from(a.bestStack.snr)).toEqual(Array.from(b.bestStack.snr));
  expect(Array.from(a.bestStack.count)).toEqual(Array.from(b.bestStack.count));
}

// ---------- runGrid ----------

describe("runGrid through a worker", () => {
  const cube = noiseCube(21, 1, { amp: 3, pmRa: -6, pmDec: 3 });

  it("resolves with what velocityGrid returns, and reports progress up to the total", async () => {
    const log = newLog();
    const seen: [number, number][] = [];
    const r = await runGrid(cube, { pmMax: 9 }, (d, t) => seen.push([d, t]), { createWorker: () => fakeWorker(log) });
    expectSameGrid(r, velocityGrid(cube, { pmMax: 9 }));
    // One tick per stack (7 x 7 grid + the refit), ending at the total; if the peak fit is
    // refused, velocityGrid sends the final tick without the refit stack.
    const total = r.pmRaAxis.length * r.pmDecAxis.length + 1;
    expect(seen.every(([, t]) => t === total)).toBe(true);
    expect(seen.every(([d], i) => i === 0 || d > seen[i - 1][0])).toBe(true);
    expect(seen[seen.length - 1][0]).toBe(total);
    expect(seen.length).toBeGreaterThanOrEqual(r.nStacks);
    expect(log.terminated).toBe(true);
  });

  it("sends the cube as plain data and moves the result buffers instead of copying them", async () => {
    const log = newLog();
    const withExtras = { ...cube, meta: { ...cube.meta, frames: cube.meta.frames.map((f, i) => ({ ...f, id: `f${i}`, url: "x" })) } };
    await runGrid(withExtras, { pmMax: 3 }, undefined, { createWorker: () => fakeWorker(log) });
    expect(Object.keys(log.posted[0].cube.meta.frames[0]).sort()).toEqual(["mjd", "noise"]);
    expect(cube.data.length).toBe(cube.n * cube.h * cube.w); // the page's cube is not detached
    const last = log.transferred[log.transferred.length - 1];
    expect(last.length).toBe(5);
    expect(last.every((b) => b.byteLength === 0)).toBe(true); // detached in the worker after the move
  });

  it("rejects with the worker's error message", async () => {
    const bad = { ...cube, meta: { ...cube.meta, frames: cube.meta.frames.map((f) => ({ ...f, mjd: 61000 })) } };
    await expect(runGrid(bad, {}, undefined, { createWorker: () => fakeWorker(newLog()) })).rejects.toThrow(/same MJD/);
  });

  it("rejects when the worker itself fails (e.g. the script did not load)", async () => {
    const broken: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage() {
        setTimeout(() => broken.onerror?.({ message: "404" }), 0);
      },
      terminate() {},
    };
    await expect(runGrid(cube, {}, undefined, { createWorker: () => broken })).rejects.toThrow(/search worker failed: 404/);
  });

  it("stops the worker and rejects with AbortError when aborted", async () => {
    const log = newLog();
    const ac = new AbortController();
    const p = runGrid(cube, {}, undefined, { createWorker: () => fakeWorker(log), signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(log.terminated).toBe(true);

    const already = new AbortController();
    already.abort();
    let made = false;
    await expect(
      runGrid(cube, {}, undefined, { signal: already.signal, createWorker: () => ((made = true), fakeWorker(newLog())) }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(made).toBe(false);
  });

  it("runs on this thread where Worker does not exist (Node), with the same result", async () => {
    expect(typeof Worker).toBe("undefined");
    expectSameGrid(await runGrid(cube, { pmMax: 6 }), velocityGrid(cube, { pmMax: 6 }));
  });
});

describe("runFalseAlarm through a worker", () => {
  it("resolves with what falseAlarm returns", async () => {
    const cube = noiseCube(15, 2, { amp: 3, pmRa: -6, pmDec: 3 });
    const seen: number[] = [];
    const r = await runFalseAlarm(cube, 4, { pmMax: 6, seed: 3 }, (d) => seen.push(d), {
      createWorker: () => fakeWorker(newLog()),
    });
    const direct = falseAlarm(cube, 4, { pmMax: 6, seed: 3 });
    expect(r.nullScores).toEqual(direct.nullScores);
    expect(r.p).toBe(direct.p);
    expect(r.moving).toEqual(direct.moving);
    expect(r.zero).toEqual(direct.zero);
    expect(Array.from(r.grid.score)).toEqual(Array.from(direct.grid.score));
    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });
});

// ---------- heatmapData ----------

describe("heatmapData", () => {
  // 3 x 2 grid: pmRa -3, 0, 3; pmDec 0, 3. score[iDec * 3 + iRa].
  const r = {
    pmRaAxis: [-3, 0, 3],
    pmDecAxis: [0, 3],
    step: 3,
    score: Float32Array.from([1, 2, 3, 4, 5, NaN]),
    best: { pmRa: 1.5, pmDec: 1.5, snr: 5.5, x: 0, y: 0 },
    gridBest: { pmRa: 0, pmDec: 3, snr: 5, x: 0, y: 0 },
  };

  it("puts north (most positive pmDec) on the top row and keeps pmRa ascending left to right", () => {
    const h = heatmapData(r);
    expect([h.nx, h.ny]).toEqual([3, 2]);
    expect(Array.from(h.values.slice(0, 2))).toEqual([4, 5]);
    expect(Number.isNaN(h.values[2])).toBe(true);
    expect(Array.from(h.values.slice(3))).toEqual([1, 2, 3]);
    expect([h.lo, h.hi]).toEqual([1, 5]);
    expect(h.extent).toEqual({ left: -4.5, right: 4.5, bottom: -1.5, top: 4.5 });
  });

  it("places markers at cell centres, between cells for off-grid motions", () => {
    const h = heatmapData(r, { pmRa: -3, pmDec: 4 });
    expect(h.markers.gridBest).toMatchObject({ col: 1.5, row: 0.5, snr: 5 }); // (0, 3): middle column, top row
    expect(h.markers.zero).toMatchObject({ col: 1.5, row: 1.5, snr: 2 });
    expect(h.markers.best).toMatchObject({ col: 2, row: 1, snr: 5.5 }); // corner shared by four cells
    expect(h.markers.catalogue!.col).toBeCloseTo(0.5, 12);
    expect(h.markers.catalogue!.row).toBeCloseTo(0.5 - 1 / 3, 12); // 1 ″/yr above the top row's centre
    expect(h.markers.catalogue!.fromBest).toBeCloseTo(Math.hypot(4.5, 2.5), 12);
    expect(heatmapData(r).markers.catalogue).toBeUndefined();
  });

  it("agrees with the viewer's mapping convention (viewer/searchView.ts vectorToCell)", () => {
    // vectorToCell: x = (pmRa - pmRaAxis[0]) / step + 0.5, y = ny - ((pmDec - pmDecAxis[0]) / step + 0.5)
    const m = markerAt(r, 2, -1);
    expect(m.col).toBeCloseTo((2 + 3) / 3 + 0.5, 12);
    expect(m.row).toBeCloseTo(2 - ((-1 - 0) / 3 + 0.5), 12);
  });

  it("refuses a score array that does not match the axes", () => {
    expect(() => heatmapData({ ...r, score: new Float32Array(5) })).toThrow();
  });
});

// ---------- real WISE 0855 cube ----------

const here = path.dirname(fileURLToPath(import.meta.url));
const wiseDir = path.resolve(here, "../../data/cubes/wise0855/D6");
const haveWise = existsSync(path.join(wiseDir, "cube.json"));

describe.skipIf(!haveWise)("runGrid on WISE 0855 (real SPHEREx D6 cube)", () => {
  it("gives exactly the direct result through the worker protocol", async () => {
    const meta = JSON.parse(readFileSync(path.join(wiseDir, "cube.json"), "utf8"));
    const buf = readFileSync(path.join(wiseDir, meta.data_url));
    const data = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const [n, h, w] = meta.shape;
    const cube: StackableCube = { n, h, w, data, meta };
    let last = 0;
    const r = await runGrid(cube, {}, (d) => (last = d), { createWorker: () => fakeWorker(newLog()) });
    expectSameGrid(r, velocityGrid(cube));
    expect(last).toBe(r.pmRaAxis.length * r.pmDecAxis.length + 1);
    const hm = heatmapData(r, { pmRa: -7.97, pmDec: 0.81 });
    expect(hm.markers.catalogue!.fromBest).toBeLessThan(2);
  }, 30000);
});
