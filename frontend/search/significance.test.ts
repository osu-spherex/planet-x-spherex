import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import results from "./results.json";
import { scoreGrid, velocityGrid } from "./grid";
import {
  DETECT_SNR,
  MOTION_ALPHA,
  bestMoving,
  falseAlarm,
  motionVerdict,
  mulberry32,
  permutation,
  withTimes,
  type FalseAlarmResult,
} from "./significance";
import { JULIAN_YEAR_DAYS, frameBrightness, type StackableCube } from "./stack";

// ---------- fixtures ----------

const PIX = 3;

function gaussian(rand: () => number): () => number {
  return () => {
    const u = Math.max(rand(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  };
}

/** Noise correlation length of the real cubes: WISE 0855 D6 neighbours correlate r = 0.72, 0.29,
 *  0.07 at 1, 2, 3 px (measured 11/14; the 3″ grid oversamples the 6.16″ native pixels). White noise
 *  smoothed by a Gaussian of sigma s has r(d) = exp(-d^2 / 4s^2): s = 0.85 gives 0.71, 0.25, 0.04. */
const NOISE_SMOOTH = 0.85;

/** Unit-variance noise frame with the real cubes' pixel-to-pixel correlation. */
function correlatedNoise(size: number, g: () => number): Float32Array {
  const r = 3;
  const k = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * NOISE_SMOOTH ** 2)));
  const norm = k.reduce((a, b) => a + b * b, 0); // 2D kernel = k x k, so sum of squares = norm^2
  const big = size + 2 * r;
  const white = Float64Array.from({ length: big * big }, g);
  const rows = new Float64Array(big * size);
  for (let y = 0; y < big; y++) for (let x = 0; x < size; x++) {
    let v = 0;
    for (let i = 0; i <= 2 * r; i++) v += k[i] * white[y * big + x + i];
    rows[y * size + x] = v;
  }
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let v = 0;
    for (let i = 0; i <= 2 * r; i++) v += k[i] * rows[(y + i) * size + x];
    out[y * size + x] = v / norm;
  }
  return out;
}

/**
 * Cube sampled in visits like SPHEREx (frames a few hours apart within a visit) with unit,
 * realistically correlated noise and an optional Gaussian source (sigma 1.2 px) at the centre at
 * the mean MJD, moving with (pmRa, pmDec).
 */
function surveyCube(
  size: number,
  visits: ReadonlyArray<readonly [years: number, frames: number]>,
  seed: number,
  source?: { amp: number; pmRa: number; pmDec: number },
): StackableCube {
  const mjds: number[] = [];
  for (const [yr, k] of visits) for (let i = 0; i < k; i++) mjds.push(61000 + yr * JULIAN_YEAR_DAYS + i * 0.07);
  const ref = mjds.reduce((a, b) => a + b, 0) / mjds.length;
  const c = (size - 1) / 2;
  const n = mjds.length;
  const data = new Float32Array(n * size * size);
  const g = gaussian(mulberry32(seed));
  for (let k = 0; k < n; k++) {
    const dt = (mjds[k] - ref) / JULIAN_YEAR_DAYS;
    const sx = source ? c - (source.pmRa * dt) / PIX : 0;
    const sy = source ? c - (source.pmDec * dt) / PIX : 0;
    const noise = correlatedNoise(size, g);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const s = source ? source.amp * Math.exp(-((x - sx) ** 2 + (y - sy) ** 2) / (2 * 1.2 ** 2)) : 0;
        data[k * size * size + y * size + x] = s + noise[y * size + x];
      }
    }
  }
  return { n, h: size, w: size, data, meta: { pixscale_arcsec: PIX, frames: mjds.map((mjd) => ({ mjd })) } };
}

const VISITS = [[0, 4], [0.5, 8], [1, 8]] as const; // 20 frames over 1 yr
const SMALL = { pmMax: 9 }; // 7 x 7 vectors at step 3″/yr

// ---------- helpers ----------

describe("shuffle helpers", () => {
  it("permutation lists every index once and repeats for the same seed", () => {
    const a = permutation(50, mulberry32(9));
    expect([...a].sort((x, y) => x - y)).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect(permutation(50, mulberry32(9))).toEqual(a);
    expect(permutation(50, mulberry32(10))).not.toEqual(a);
  });

  it("withTimes moves the MJDs between frames, shares the pixels and leaves the input alone", () => {
    const cube = surveyCube(5, [[0, 2], [1, 2]], 1);
    const before = cube.meta.frames.map((f) => f.mjd);
    const out = withTimes(cube, [3, 2, 1, 0]);
    expect(out.meta.frames.map((f) => f.mjd)).toEqual([before[3], before[2], before[1], before[0]]);
    expect(out.data).toBe(cube.data);
    expect(cube.meta.frames.map((f) => f.mjd)).toEqual(before);
    expect(() => withTimes(cube, [0, 1])).toThrow();
  });

  it("bestMoving skips the zero vector", () => {
    const cells = [
      { pmRa: 0, pmDec: 0, snr: 9, x: 1, y: 1 },
      { pmRa: 3, pmDec: 0, snr: 4, x: 1, y: 1 },
      { pmRa: 0, pmDec: -3, snr: 5, x: 2, y: 1 },
    ];
    expect(bestMoving({ cells })).toEqual(cells[2]);
    expect(() => bestMoving({ cells: [cells[0]] })).toThrow();
  });
});

// ---------- falseAlarm ----------

describe("falseAlarm: a moving source invisible in single frames", () => {
  // Peak 2 sigma per frame, ~10 after stacking 20 frames; moves 2.9 px in the year.
  const truth = { pmRa: -7.5, pmDec: 4.5 };
  let fa: FalseAlarmResult;
  beforeAll(() => {
    fa = falseAlarm(surveyCube(25, VISITS, 3, { amp: 2, ...truth }), 100, SMALL);
  }, 60000);

  it("the real time order beats all 100 shuffles: chance below 1%", () => {
    expect(fa.n).toBe(100);
    expect(fa.nullScores.length).toBe(100);
    expect(fa.nExceed).toBe(0);
    expect(fa.p).toBeCloseTo(1 / 101, 12);
    expect(fa.p).toBe(fa.pMin);
    expect(fa.p).toBeLessThan(0.01);
    expect(fa.z).toBeGreaterThan(3);
  });

  it("is reported as detected motion, on the grid cell next to the true vector", () => {
    expect(motionVerdict(fa).kind).toBe("detected");
    expect(Math.abs(fa.moving.pmRa - truth.pmRa)).toBeLessThanOrEqual(fa.grid.step);
    expect(Math.abs(fa.moving.pmDec - truth.pmDec)).toBeLessThanOrEqual(fa.grid.step);
  });

  it("always reports the zero vector, scored like every other cell", () => {
    const i = fa.grid.pmRaAxis.indexOf(0);
    const j = fa.grid.pmDecAxis.indexOf(0);
    expect(fa.zero.pmRa).toBe(0);
    expect(fa.zero.pmDec).toBe(0);
    expect(fa.zero.snr).toBe(fa.grid.score[j * fa.grid.pmRaAxis.length + i]);
    expect(fa.zero.snr).toBeLessThan(fa.moving.snr);
    expect(motionVerdict(fa).zeroSnr).toBe(fa.zero.snr);
  });
});

describe("falseAlarm: a source that does not move", () => {
  it("is a detection, but its motion is only 'consistent', never 'detected'", () => {
    const fa = falseAlarm(surveyCube(25, VISITS, 4, { amp: 2, pmRa: 0, pmDec: 0 }), 100, SMALL);
    const v = motionVerdict(fa);
    expect(v.bestSnr).toBeGreaterThan(DETECT_SNR);
    expect(fa.p).toBeGreaterThanOrEqual(MOTION_ALPHA);
    expect(v.kind).toBe("consistent");
  }, 60000);
});

// ---------- A-13: a target bright in single frames, seen at a different wavelength in each ----------

/**
 * surveyCube with what the LVF does to a bright target: its brightness differs up to 50x between
 * frames and the frame noise up to 20x (both log-uniform, independent of each other and of the
 * time), with `noise` in the frame metadata as in the static cubes. Peak / noise per frame runs
 * from 5 to 5000, median ~160 (Epsilon Indi B in D2: 27 to 1254, median 369).
 */
function lvfCube(seed: number, source: { pmRa: number; pmDec: number }): StackableCube {
  const size = 25;
  const cube = surveyCube(size, VISITS, seed);
  const rand = mulberry32(seed + 5000);
  const ref = cube.meta.frames.reduce((a, f) => a + f.mjd, 0) / cube.n;
  const c = (size - 1) / 2;
  const frames = cube.meta.frames.map((f) => {
    const noise = 20 ** rand();
    return { mjd: f.mjd, noise, amp: 100 * 50 ** rand() };
  });
  for (let k = 0; k < cube.n; k++) {
    const dt = (frames[k].mjd - ref) / JULIAN_YEAR_DAYS;
    const sx = c - (source.pmRa * dt) / PIX;
    const sy = c - (source.pmDec * dt) / PIX;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = k * size * size + y * size + x;
        const s = frames[k].amp * Math.exp(-((x - sx) ** 2 + (y - sy) ** 2) / (2 * 1.2 ** 2));
        cube.data[i] = s + frames[k].noise * cube.data[i];
      }
    }
  }
  return { ...cube, meta: { pixscale_arcsec: PIX, frames: frames.map(({ mjd, noise }) => ({ mjd, noise })) } };
}

describe("falseAlarm: a bright moving source whose brightness changes 50x and noise 20x between frames", () => {
  const truth = { pmRa: -7.5, pmDec: 4.5 };
  let cube: StackableCube;
  let fa: FalseAlarmResult;
  beforeAll(() => {
    cube = lvfCube(11, truth);
    fa = falseAlarm(cube, 100, SMALL);
  }, 60000);

  it("the fixture is what it says", () => {
    const noise = cube.meta.frames.map((f) => f.noise!);
    expect(Math.max(...noise) / Math.min(...noise)).toBeGreaterThan(5);
    const c = (cube.w - 1) / 2;
    const b = frameBrightness(cube, c, c, 4);
    expect(b.nMeasurable).toBeGreaterThan(cube.n / 2);
    const seen = Array.from(b.amp).filter((_, k) => b.snr[k] >= 5);
    expect(Math.max(...seen) / Math.min(...seen)).toBeGreaterThan(10);
  });

  it("is searched on a common brightness and its motion is detected at the true vector", () => {
    expect(fa.grid.normalised).toBe(true);
    expect(fa.nExceed).toBe(0);
    expect(fa.p).toBeLessThan(MOTION_ALPHA);
    expect(motionVerdict(fa).kind).toBe("detected");
    expect(Math.abs(fa.moving.pmRa - truth.pmRa)).toBeLessThanOrEqual(fa.grid.step);
    expect(Math.abs(fa.moving.pmDec - truth.pmDec)).toBeLessThanOrEqual(fa.grid.step);
    const best = velocityGrid(cube, SMALL).best;
    expect(Math.hypot(best.pmRa - truth.pmRa, best.pmDec - truth.pmDec)).toBeLessThan(2);
  });

  it("the same source standing still is not reported as moving", () => {
    const still = falseAlarm(lvfCube(12, { pmRa: 0, pmDec: 0 }), 100, SMALL);
    const v = motionVerdict(still);
    expect(still.grid.normalised).toBe(true);
    expect(v.bestSnr).toBeGreaterThan(DETECT_SNR);
    expect(v.kind).not.toBe("detected");
  }, 60000);
});

describe("falseAlarm on pure noise", () => {
  it("gives p uniformly distributed over 1/20 ... 20/20 (the test is fair)", () => {
    // 60 noise cubes, 19 shuffles each. Kolmogorov-Smirnov distance to the discrete uniform CDF,
    // compared with the 1% critical value 1.63 / sqrt(M) (asymptotic; conservative for discrete p).
    const M = 60;
    const ps: number[] = [];
    for (let m = 0; m < M; m++) {
      const fa = falseAlarm(surveyCube(15, [[0, 3], [0.5, 4], [1, 3]], 1000 + m), 19, { pmMax: 6, seed: m + 1 });
      expect(fa.p).toBeGreaterThanOrEqual(1 / 20);
      expect(fa.p * 20).toBeCloseTo(Math.round(fa.p * 20), 9);
      ps.push(fa.p);
    }
    let d = 0;
    for (let k = 1; k <= 20; k++) {
      const below = ps.filter((p) => p <= k / 20 + 1e-12).length / M;
      d = Math.max(d, Math.abs(below - k / 20));
    }
    expect(d).toBeLessThan(1.63 / Math.sqrt(M));
  }, 60000);
});

describe("falseAlarm API", () => {
  const tiny = surveyCube(11, [[0, 2], [1, 2]], 5, { amp: 3, pmRa: 0, pmDec: 0 });

  it("rejects a bad number of shuffles", () => {
    expect(() => falseAlarm(tiny, 0)).toThrow();
    expect(() => falseAlarm(tiny, 2.5)).toThrow();
  });

  it("reports progress once per search, real order first, up to n + 1", () => {
    const seen: [number, number][] = [];
    falseAlarm(tiny, 3, { pmMax: 3, onProgress: (d, t) => seen.push([d, t]) });
    expect(seen).toEqual([[1, 4], [2, 4], [3, 4], [4, 4]]);
  });

  it("is reproducible for a seed", () => {
    const a = falseAlarm(tiny, 5, { pmMax: 3, seed: 7 });
    const b = falseAlarm(tiny, 5, { pmMax: 3, seed: 7 });
    expect(b.nullScores).toEqual(a.nullScores);
    expect(b.seed).toBe(7);
  });
});

describe("motionVerdict", () => {
  const fake = (best: number, moving: number, zero: number, p: number) =>
    ({
      grid: { gridBest: { snr: best } },
      moving: { snr: moving },
      zero: { snr: zero },
      p,
      pMin: 0.001,
    }) as unknown as FalseAlarmResult;

  it("needs a detection, p below alpha and a gain over the zero vector to call motion detected", () => {
    expect(motionVerdict(fake(4.9, 4.9, 3, 0.001)).kind).toBe("none");
    expect(motionVerdict(fake(12, 12, 9, 0.001)).kind).toBe("detected");
    expect(motionVerdict(fake(12, 12, 9, 0.02)).kind).toBe("consistent");
    // Shuffles lose, but standing still stacks better than any motion: not a motion.
    expect(motionVerdict(fake(12, 11, 12, 0.001)).kind).toBe("consistent");
    expect(motionVerdict(fake(12, 12, 9, 0.02), { alpha: 0.05 }).kind).toBe("detected");
    expect(motionVerdict(fake(12, 11, 9, 0.001)).gain).toBe(2);
  });
});

// ---------- real cubes ----------

const here = path.dirname(fileURLToPath(import.meta.url));
const cubesDir = path.resolve(here, "../../data/cubes");
const wiseDir = path.join(cubesDir, "wise0855/D6");
// Suggested path in issue #21 (control cube requested from role A); skipped until it exists.
const controlDir = path.join(cubesDir, "wise0855_control/D6");
const haveWise = existsSync(path.join(wiseDir, "cube.json"));
const haveControl = existsSync(path.join(controlDir, "cube.json"));

function loadStatic(dir: string): StackableCube {
  const meta = JSON.parse(readFileSync(path.join(dir, "cube.json"), "utf8"));
  const buf = readFileSync(path.join(dir, meta.data_url));
  const data = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const [n, h, w] = meta.shape;
  return { n, h, w, data, meta };
}

// More shuffles for the README numbers: P03_SHUFFLES=500 npx vitest run search/significance.test.ts
const SHUFFLES = Number(process.env.P03_SHUFFLES ?? 20);

describe.skipIf(!haveWise)("falseAlarm on WISE 0855 (real SPHEREx D6 cube)", () => {
  it(`the real time order beats every one of ${SHUFFLES} shuffles`, () => {
    const fa = falseAlarm(loadStatic(wiseDir), SHUFFLES);
    const v = motionVerdict(fa);
    const mean = fa.nullScores.reduce((a, b) => a + b, 0) / fa.n;
    console.info(
      `WISE 0855 D6: n=${fa.n} real=${fa.moving.snr.toFixed(2)} at (${fa.moving.pmRa.toFixed(2)}, ` +
        `${fa.moving.pmDec.toFixed(2)}) zero=${fa.zero.snr.toFixed(2)} shuffles mean=${mean.toFixed(2)} ` +
        `max=${Math.max(...fa.nullScores).toFixed(2)} nExceed=${fa.nExceed} p=${fa.p.toFixed(4)} ` +
        `z=${fa.z.toFixed(2)} verdict=${v.kind} ${(fa.elapsedMs / 1000).toFixed(1)} s`,
    );
    expect(fa.nExceed).toBe(0);
    expect(fa.moving.snr).toBeGreaterThan(fa.zero.snr);
    expect(v.kind).not.toBe("none");
    // results.json (the /method page) records the run with 500 shuffles.
    const row = results.objects.find((o) => o.id === "wise0855")!;
    if (fa.n === row.shuffles.n) {
      const max = Number(Math.max(...fa.nullScores).toFixed(2));
      expect({ n: fa.n, nExceed: fa.nExceed, max, p: Number(fa.p.toFixed(4)) }).toEqual(row.shuffles);
      expect(v.kind).toBe(row.verdict);
    }
  }, 30000 + SHUFFLES * 3000);
});

describe.skipIf(!haveControl)("control cube near WISE 0855 (issue #21)", () => {
  it("blank sky: best score below DETECT_SNR and verdict 'none'", () => {
    const cube = loadStatic(controlDir);
    expect(velocityGrid(cube).gridBest.snr).toBeLessThan(DETECT_SNR);
    expect(scoreGrid(cube).gridBest.snr).toBeLessThan(DETECT_SNR);
    expect(motionVerdict(falseAlarm(cube, 20)).kind).toBe("none");
  }, 120000);
});
