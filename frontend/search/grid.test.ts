import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { axis, fitPeak, regionPeak, velocityGrid, type GridResult } from "./grid";
import { JULIAN_YEAR_DAYS, type StackableCube } from "./stack";

// ---------- fixtures ----------

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number): () => number {
  return () => {
    const u = Math.max(rand(), 1e-12);
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

const PIX = 3;
const SIZE = 41;
const C = 20; // cube centre

/**
 * WISE 0855-like time sampling: three visits (0, 0.5, 1 yr) of 6, 12 and 12 frames a few hours
 * apart. Unit noise; optional Gaussian source (amp, sigma 1.2 px) moving with (pmRa, pmDec) and
 * sitting at the cube centre at the mean MJD.
 */
function surveyCube(seed: number, source?: { amp: number; pmRa: number; pmDec: number }): StackableCube {
  const t0 = 61000;
  const mjds: number[] = [];
  for (const [yr, k] of [[0, 6], [0.5, 12], [1, 12]] as const) {
    for (let i = 0; i < k; i++) mjds.push(t0 + yr * JULIAN_YEAR_DAYS + i * 0.07);
  }
  const ref = mjds.reduce((a, b) => a + b, 0) / mjds.length;
  const n = mjds.length;
  const data = new Float32Array(n * SIZE * SIZE);
  const g = gaussian(rng(seed));
  for (let k = 0; k < n; k++) {
    const dt = (mjds[k] - ref) / JULIAN_YEAR_DAYS;
    const sx = source ? C - (source.pmRa * dt) / PIX : 0;
    const sy = source ? C - (source.pmDec * dt) / PIX : 0;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const s = source ? source.amp * Math.exp(-((x - sx) ** 2 + (y - sy) ** 2) / (2 * 1.2 ** 2)) : 0;
        data[k * SIZE * SIZE + y * SIZE + x] = s + g();
      }
    }
  }
  return { n, h: SIZE, w: SIZE, data, meta: { pixscale_arcsec: PIX, frames: mjds.map((mjd) => ({ mjd })) } };
}

// ---------- helpers ----------

describe("axis", () => {
  it("is symmetric, contains 0 and stays within the limit", () => {
    const a = axis(15, 2.96);
    expect(a.length).toBe(11);
    expect(a[5]).toBe(0);
    expect(a[0]).toBeCloseTo(-14.8, 6);
    expect(a[10]).toBeCloseTo(14.8, 6);
    expect(axis(15, 3)).toEqual([-15, -12, -9, -6, -3, 0, 3, 6, 9, 12, 15]);
  });
});

describe("fitPeak", () => {
  const nx = 7;
  const ny = 7;
  const surface = (f: (u: number, v: number) => number) => {
    const s = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) s[j * nx + i] = f(i - 3, j - 3);
    return s;
  };

  it("finds the vertex of an exact quadratic (with a cross term)", () => {
    const s = surface((u, v) => 10 - (u - 0.4) ** 2 - 2 * (v + 0.7) ** 2 + 0.5 * (u - 0.4) * (v + 0.7));
    const p = fitPeak(s, nx, ny, 3, 3, 2);
    expect(p).not.toBeNull();
    expect(p!.du).toBeCloseTo(0.4, 4);
    expect(p!.dv).toBeCloseTo(-0.7, 4);
  });

  it("refuses a minimum, a saddle, and a vertex outside the window", () => {
    expect(fitPeak(surface((u, v) => u * u + v * v), nx, ny, 3, 3, 2)).toBeNull();
    expect(fitPeak(surface((u, v) => u * u - v * v), nx, ny, 3, 3, 2)).toBeNull();
    expect(fitPeak(surface((u, v) => -((u - 5) ** 2) - v * v), nx, ny, 3, 3, 2)).toBeNull();
  });

  it("works at the edge of the grid with fewer cells", () => {
    const s = surface((u, v) => -((u + 2.8) ** 2) - (v - 0.1) ** 2);
    const p = fitPeak(s, nx, ny, 0, 3, 2);
    expect(p!.du).toBeCloseTo(0.2, 4);
    expect(p!.dv).toBeCloseTo(0.1, 4);
  });
});

describe("regionPeak", () => {
  it("only looks inside the radius", () => {
    const w = 9;
    const snr = new Float32Array(w * w);
    snr[4 * w + 4] = 3;
    snr[0] = 100; // corner, outside radius 3 of the centre
    snr[4 * w + 7] = 5; // distance 3: inside
    expect(regionPeak({ snr, w, h: w }, 4, 4, 3)).toEqual({ snr: 5, x: 7, y: 4 });
  });
});

// ---------- velocityGrid on synthetic data ----------

describe("velocityGrid (synthetic)", () => {
  // Per-frame peak SNR 1.5: invisible in one frame, ~8 after stacking 30 frames.
  const truth = { pmRa: -7.97, pmDec: 0.81 };
  const cube = surveyCube(7, { amp: 1.5, ...truth });
  let r: GridResult;
  beforeAll(() => {
    r = velocityGrid(cube);
  }, 30000);

  it("recovers the motion of a source that is invisible in single frames", () => {
    expect(r.fitted).toBe(true);
    expect(Math.hypot(r.best.pmRa - truth.pmRa, r.best.pmDec - truth.pmDec)).toBeLessThan(2);
    expect(r.best.snr).toBeGreaterThan(6);
    expect(Math.hypot(r.best.x - C, r.best.y - C)).toBeLessThanOrEqual(1.5);
  });

  it("uses step = pixscale / baseline and covers +-15 arcsec/yr", () => {
    expect(r.baselineYears).toBeCloseTo(1 + (11 * 0.07) / JULIAN_YEAR_DAYS, 6);
    expect(r.step).toBeCloseTo(PIX / r.baselineYears, 6);
    expect(r.pmRaAxis[0]).toBeGreaterThanOrEqual(-15);
    expect(r.pmRaAxis[0]).toBeLessThan(-15 + r.step);
    expect(r.score.length).toBe(r.pmRaAxis.length * r.pmDecAxis.length);
    expect(r.nStacks).toBe(r.score.length + 1);
  });

  it("stays below SNR 5 on blank sky despite trying every vector (look-elsewhere control)", () => {
    for (const seed of [11, 12]) {
      const blank = velocityGrid(surveyCube(seed));
      expect(blank.gridBest.snr).toBeLessThan(5);
      expect(blank.best.snr).toBeLessThan(5);
    }
  }, 30000);

  it("reports progress up to the total", () => {
    const seen: number[] = [];
    velocityGrid(cube, { pmMax: 3, onProgress: (d, t) => seen.push(t - d) });
    expect(seen[seen.length - 1]).toBe(0);
  });
});

// ---------- velocityGrid on the real WISE 0855 D6 static cube ----------

const here = path.dirname(fileURLToPath(import.meta.url));
const wiseDir = path.resolve(here, "../../data/cubes/wise0855/D6");
const haveWise = existsSync(path.join(wiseDir, "cube.json"));

function loadStatic(dir: string): StackableCube {
  const meta = JSON.parse(readFileSync(path.join(dir, "cube.json"), "utf8"));
  const buf = readFileSync(path.join(dir, meta.data_url));
  const data = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const [n, h, w] = meta.shape;
  return { n, h, w, data, meta };
}

describe.skipIf(!haveWise)("velocityGrid on WISE 0855 (real SPHEREx D6 cube)", () => {
  // Catalogue proper motion given in tasks/P.md (P-02 acceptance), arcsec/yr, pmRa includes cos(Dec).
  const CATALOGUE = { pmRa: -7.97, pmDec: 0.81 };
  const cube = haveWise ? loadStatic(wiseDir) : null!;

  it("finds the catalogue motion within 2 arcsec/yr, in under 5 s", () => {
    const r = velocityGrid(cube);
    expect(r.fitted).toBe(true);
    expect(Math.hypot(r.best.pmRa - CATALOGUE.pmRa, r.best.pmDec - CATALOGUE.pmDec)).toBeLessThan(2);
    expect(r.best.snr).toBeGreaterThan(10);
    expect(r.elapsedMs).toBeLessThan(5000);
  }, 20000);

  it("finds nothing above SNR 5 in blank regions of the same cube (interim control, see issue #21)", () => {
    // 15 px (45″) from the target in eight directions; same frames, same noise.
    for (const [cx, cy] of [[15, 15], [45, 15], [15, 45], [45, 45], [30, 12], [30, 48], [12, 30], [48, 30]]) {
      const r = velocityGrid(cube, { centerX: cx, centerY: cy });
      expect(r.gridBest.snr, `blank region at (${cx}, ${cy})`).toBeLessThan(5);
    }
  }, 60000);
});
