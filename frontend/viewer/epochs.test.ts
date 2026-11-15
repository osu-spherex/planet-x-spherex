import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadCube, type Cube, type CubeMeta } from "./cube";
import {
  DIFF_MIN_SIGMAS,
  DIFF_NAN_RGB,
  DIFF_NEG_RGB,
  DIFF_POS_RGB,
  EPOCH_GAP_DAYS,
  defaultEpochPair,
  differenceImage,
  differenceLimit,
  epochMedian,
  extremum,
  groupEpochs,
  renderDifference,
  sharedLimits,
} from "./epochs";

// ---------------------------------------------------------------------------------------------
// groupEpochs
// ---------------------------------------------------------------------------------------------
describe("groupEpochs", () => {
  it("splits where consecutive frames are more than 20 days apart", () => {
    const frames = [
      { mjd: 100, lam_um: 1.0 },
      { mjd: 101, lam_um: 1.2 },
      { mjd: 120, lam_um: 1.1 }, // 19 days after 101: same epoch
      { mjd: 141, lam_um: 0.9 }, // 21 days after 120: new epoch
      { mjd: 300 },
    ];
    const e = groupEpochs(frames);
    expect(EPOCH_GAP_DAYS).toBe(20);
    expect(e.map((x) => x.frames)).toEqual([[0, 1, 2], [3], [4]]);
    expect(e.map((x) => x.epoch)).toEqual([0, 1, 2]);
    expect(e[0].mjdMin).toBe(100);
    expect(e[0].mjdMax).toBe(120);
    expect(e[0].mjdMean).toBeCloseTo(107, 12);
    expect([e[0].lamMin, e[0].lamMax]).toEqual([1.0, 1.2]);
    expect(Number.isNaN(e[2].lamMin)).toBe(true);
  });

  it("treats a gap of exactly 20 days as the same epoch", () => {
    expect(groupEpochs([{ mjd: 0 }, { mjd: 20 }]).length).toBe(1);
    expect(groupEpochs([{ mjd: 0 }, { mjd: 20.001 }]).length).toBe(2);
  });

  it("sorts unsorted frames by time but keeps their original indices", () => {
    const e = groupEpochs([{ mjd: 500 }, { mjd: 10 }, { mjd: 505 }, { mjd: 12 }]);
    expect(e.map((x) => x.frames)).toEqual([[1, 3], [0, 2]]);
  });

  it("returns nothing for no frames and skips frames without a time", () => {
    expect(groupEpochs([])).toEqual([]);
    expect(groupEpochs([{ mjd: Number.NaN }, { mjd: 5 }]).map((x) => x.frames)).toEqual([[1]]);
  });
});

describe("defaultEpochPair", () => {
  const ep = (sizes: number[]) =>
    groupEpochs(sizes.flatMap((n, k) => Array.from({ length: n }, (_, i) => ({ mjd: k * 100 + i }))));

  it("takes the first and last epoch with at least 3 frames", () => {
    expect(defaultEpochPair(ep([1, 5, 45, 99]))).toEqual([1, 3]); // R Dra D1: visit 1 has one image
    expect(defaultEpochPair(ep([19, 5, 18, 18]))).toEqual([0, 3]);
  });

  it("falls back to first and last, and gives null for a single epoch", () => {
    expect(defaultEpochPair(ep([1, 2, 1]))).toEqual([0, 2]);
    expect(defaultEpochPair(ep([10]))).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Medians and differences on a hand-written cube: 3 frames of 1 x 3 pixels.
// ---------------------------------------------------------------------------------------------
function tinyCube(values: number[], mjds: number[], h: number, w: number): Cube {
  const meta: CubeMeta = {
    center: { ra: 0, dec: 0 },
    pixscale_arcsec: 3,
    shape: [mjds.length, h, w],
    frames: mjds.map((mjd, i) => ({ id: `f${i}`, band: "D1", mjd, lam_um: 1, noise: 1, nan_frac: 0 })),
    data_url: "cube.f32",
  };
  return { meta, data: new Float32Array(values), n: mjds.length, h, w };
}

describe("epochMedian", () => {
  it("is the per-pixel median of the epoch's frames, ignoring NaN", () => {
    // pixel 0: 1, 7, 3 -> 3;  pixel 1: NaN, 4, 2 -> 3;  pixel 2: NaN everywhere -> NaN
    const cube = tinyCube([1, NaN, NaN, 7, 4, NaN, 3, 2, NaN, 100, 100, 100], [0, 1, 2, 400], 1, 3);
    const [first, second] = groupEpochs(cube.meta.frames);
    const m = epochMedian(cube, first);
    expect(m.image[0]).toBe(3);
    expect(m.image[1]).toBe(3);
    expect(Number.isNaN(m.image[2])).toBe(true);
    expect(Array.from(m.count)).toEqual([3, 2, 0]);
    // The later frame (MJD 400) is a separate epoch and does not leak into the first.
    expect(Array.from(epochMedian(cube, second).image)).toEqual([100, 100, 100]);
  });
});

describe("differenceImage", () => {
  it("is B - A, NaN where either is NaN", () => {
    const d = differenceImage(new Float32Array([1, 2, NaN, 4]), new Float32Array([3, 1, 5, NaN]));
    expect(d[0]).toBe(2);
    expect(d[1]).toBe(-1);
    expect(Number.isNaN(d[2])).toBe(true);
    expect(Number.isNaN(d[3])).toBe(true);
  });

  it("refuses images of different size", () => {
    expect(() => differenceImage(new Float32Array(2), new Float32Array(3))).toThrow(/size/);
  });

  it("turns a star moved by one pixel into a +/- pair and a fixed star into zero", () => {
    // A: moving star at x = 1, fixed star at x = 4.  B: moving star at x = 2, fixed star unchanged.
    const a = new Float32Array([0, 10, 0, 0, 5, 0]);
    const b = new Float32Array([0, 0, 10, 0, 5, 0]);
    expect(Array.from(differenceImage(a, b))).toEqual([0, -10, 10, 0, 0, 0]);
  });
});

describe("sharedLimits", () => {
  it("uses the pixels of both images, so both blink frames share one scale", () => {
    const a = new Float32Array([0, 1, 2, 3, 4]);
    const b = new Float32Array([5, 6, 7, 8, 9]);
    expect(sharedLimits(a, b, 0, 100)).toEqual({ lo: 0, hi: 9 });
    expect(sharedLimits(a, b, 50, 50).lo).toBeCloseTo(4.5, 6);
  });
});

describe("differenceLimit", () => {
  it("is the 99.5th percentile of |B - A| when that is above the noise floor", () => {
    const d = new Float32Array(201);
    for (let i = 0; i < 201; i++) d[i] = (i % 2 ? 1 : -1) * 0.01 * (i % 7); // tiny noise
    d[100] = 50;
    d[101] = -80;
    const lim = differenceLimit(d);
    // 201 values, |d| sorted: rank 0.995 * 200 = 199 -> the second largest, 50.
    expect(lim).toBeCloseTo(50, 4);
  });

  it("never drops below 5 robust sigmas, so pure noise stays dim", () => {
    // Values -1, +1 alternating: median 0, MAD 1, sigma 1.4826; 99.5th percentile of |d| is 1.
    const d = new Float32Array(100).map((_, i) => (i % 2 ? 1 : -1));
    expect(DIFF_MIN_SIGMAS).toBe(5);
    expect(differenceLimit(d)).toBeCloseTo(5 * 1.4826, 4);
  });

  it("is NaN for an image without valid pixels", () => {
    expect(Number.isNaN(differenceLimit(new Float32Array([NaN, NaN])))).toBe(true);
  });
});

describe("renderDifference", () => {
  it("maps 0 to black, +limit to red, -limit to blue, beyond the limit clipped, NaN to grey", () => {
    const rgba = renderDifference(new Float32Array([0, 2, -2, 1, 10, NaN]), 2);
    const px = (i: number) => Array.from(rgba.slice(i * 4, i * 4 + 4));
    expect(px(0)).toEqual([0, 0, 0, 255]);
    expect(px(1)).toEqual([...DIFF_POS_RGB, 255]);
    expect(px(2)).toEqual([...DIFF_NEG_RGB, 255]);
    expect(px(3)).toEqual([...DIFF_POS_RGB.map((c) => Math.round(c / 2)), 255]);
    expect(px(4)).toEqual([...DIFF_POS_RGB, 255]);
    expect(px(5)).toEqual([...DIFF_NAN_RGB, 255]);
  });

  it("draws everything grey when the limit is unusable, and reuses a given buffer", () => {
    const out = new Uint8ClampedArray(8);
    const rgba = renderDifference(new Float32Array([1, -1]), NaN, out);
    expect(rgba).toBe(out);
    expect(Array.from(rgba)).toEqual([...DIFF_NAN_RGB, 255, ...DIFF_NAN_RGB, 255]);
  });
});

describe("extremum", () => {
  it("finds the brightest and the darkest finite pixel", () => {
    const img = new Float32Array([0, NaN, 5, -3, 1, 0]);
    expect(extremum(img, 3, 1)).toEqual({ x: 2, y: 0, value: 5 });
    expect(extremum(img, 3, -1)).toEqual({ x: 0, y: 1, value: -3 });
    expect(extremum(new Float32Array([NaN]), 1, 1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Real cubes from role A (data/cubes/, PR #8). The expected motion comes from Gaia DR3, not from
// this code: the dipole must point where the catalogue says the star went.
//
// Barnard's Star, Gaia DR3: pmra = -801.551 mas/yr (includes cos Dec),
//   pmdec = +10362.394 mas/yr. https://simbad.cds.unistra.fr/simbad/sim-id?Ident=Barnard%27s+star
// Epsilon Indi B moves with eps Ind A (common proper motion pair), Gaia DR3:
//   pmra = +3966.661 mas/yr, pmdec = -2536.192 mas/yr.
//   https://simbad.cds.unistra.fr/simbad/sim-id?Ident=eps+Ind+A
// The same values are used by experiments/check_objects.py and tests/test_motion.py (-0.80, 10.36).
//
// Cube geometry (data/cubes/README.md): 3" pixels, row 0 north, column 0 east, so +RA motion is
// -x and +Dec motion is -y. Tolerance 1.5 px (4.5"): peak pixels are integers (+/- 0.5 px each),
// the PSF (6.16" SPHEREx pixels resampled to 3") is wider than the shift, so the +/- lobes overlap
// and their peaks are pushed apart by up to about a pixel.
// ---------------------------------------------------------------------------------------------
const cubesDir =
  process.env.OSU_CUBES_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data/cubes");
const fileFetch = (async (input: string | URL | Request) =>
  new Response(new Uint8Array(readFileSync(String(input))))) as typeof fetch;
const cubeJson = (obj: string, band: string) => path.join(cubesDir, obj, band, "cube.json");
const load = (obj: string, band: string) => loadCube(cubeJson(obj, band).replaceAll("\\", "/"), fileFetch);

const JULIAN_YEAR = 365.25;
const PIX_TOL = 1.5;

/** Sum of |d| over a (2r+1)^2 box divided by the sum of A over the same box. */
function residualRatio(a: Float32Array, d: Float32Array, w: number, x0: number, y0: number, r: number): number {
  let sa = 0;
  let sd = 0;
  for (let y = y0 - r; y <= y0 + r; y++) {
    for (let x = x0 - r; x <= x0 + r; x++) {
      const p = y * w + x;
      if (Number.isFinite(a[p]) && Number.isFinite(d[p])) {
        sa += a[p];
        sd += Math.abs(d[p]);
      }
    }
  }
  return sd / sa;
}

describe.skipIf(!existsSync(cubeJson("barnard", "D1")))("real cube: barnard D1 difference", () => {
  it("groups frames into the same 4 epochs as cube.json", async () => {
    const cube = await load("barnard", "D1");
    const epochs = groupEpochs(cube.meta.frames);
    expect(epochs.map((e) => e.frames.length)).toEqual(cube.meta.epochs!.map((e) => e.n));
    epochs.forEach((e, k) => {
      expect(e.mjdMin).toBeCloseTo(cube.meta.epochs![k].mjd_min, 5);
      expect(e.mjdMax).toBeCloseTo(cube.meta.epochs![k].mjd_max, 5);
      for (const f of e.frames) expect(cube.meta.frames[f].epoch).toBe(k);
    });
  });

  it("shows a red/blue pair displaced north by Barnard's proper motion, and a fixed star cancels", async () => {
    const cube = await load("barnard", "D1");
    const epochs = groupEpochs(cube.meta.frames);
    const [ia, ib] = defaultEpochPair(epochs)!;
    expect([ia, ib]).toEqual([0, 3]);
    const A = epochMedian(cube, epochs[ia]);
    const B = epochMedian(cube, epochs[ib]);
    const d = differenceImage(A.image, B.image);

    const dtYears = (epochs[ib].mjdMean - epochs[ia].mjdMean) / JULIAN_YEAR;
    const expectDx = (0.801551 * dtYears) / 3; // -pmra * dt / pix: about +0.26 px (west)
    const expectDy = (-10.362394 * dtYears) / 3; // about -3.4 px (north)

    const red = extremum(d, cube.w, 1)!; // where the star is in B
    const blue = extremum(d, cube.w, -1)!; // where it was in A
    expect(Math.abs(red.x - blue.x - expectDx)).toBeLessThanOrEqual(PIX_TOL);
    expect(Math.abs(red.y - blue.y - expectDy)).toBeLessThanOrEqual(PIX_TOL);
    // Both lobes sit on Barnard's Star, close to the cube centre (30, 30).
    for (const p of [red, blue]) expect(Math.hypot(p.x - 30, p.y - 30)).toBeLessThan(6);
    // A real pair, not noise: both lobes far above the noise of the two medians.
    const sigma = Math.hypot(A.sigma, B.sigma);
    expect(red.value / sigma).toBeGreaterThan(50);
    expect(-blue.value / sigma).toBeGreaterThan(50);

    // The moving star leaves more |B - A| than its own flux (two separate lobes: ratio up to 2);
    // the field star at (39, 8) in this cube (36 sigma in visit 1) does not move and nearly cancels.
    expect(residualRatio(A.image, d, cube.w, 30, 30, 8)).toBeGreaterThan(0.8);
    expect(A.image[8 * cube.w + 39] / A.sigma).toBeGreaterThan(20);
    expect(residualRatio(A.image, d, cube.w, 39, 8, 2)).toBeLessThan(0.3);
  });
});

describe.skipIf(!existsSync(cubeJson("epsindb", "D2")))("real cube: epsindb D2 difference", () => {
  it("shows a pair displaced south-east by the eps Ind proper motion", async () => {
    const cube = await load("epsindb", "D2");
    const epochs = groupEpochs(cube.meta.frames);
    expect(epochs.map((e) => e.frames.length)).toEqual(cube.meta.epochs!.map((e) => e.n));
    const [ia, ib] = defaultEpochPair(epochs)!;
    const d = differenceImage(epochMedian(cube, epochs[ia]).image, epochMedian(cube, epochs[ib]).image);

    const dtYears = (epochs[ib].mjdMean - epochs[ia].mjdMean) / JULIAN_YEAR;
    const expectDx = (-3.966661 * dtYears) / 3; // east: about -1.9 px
    const expectDy = (2.536192 * dtYears) / 3; // south: about +1.2 px
    const red = extremum(d, cube.w, 1)!;
    const blue = extremum(d, cube.w, -1)!;
    expect(Math.abs(red.x - blue.x - expectDx)).toBeLessThanOrEqual(PIX_TOL);
    expect(Math.abs(red.y - blue.y - expectDy)).toBeLessThanOrEqual(PIX_TOL);
  });
});
