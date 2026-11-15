import { describe, expect, it } from "vitest";
import {
  JULIAN_YEAR_DAYS,
  FRAME_DETECT_SNR,
  NATIVE_PIXEL_ARCSEC,
  brightnessScale,
  frameBrightness,
  frameShift,
  robustStats,
  sampleBilinear,
  stack,
  type StackableCube,
} from "./stack";

// ---------- fixtures ----------

/** Deterministic PRNG (mulberry32) so the noisy fixtures are the same on every run. */
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

function makeCube(n: number, h: number, w: number, mjds: number[], pix: number, data?: Float32Array): StackableCube {
  return {
    n,
    h,
    w,
    data: data ?? new Float32Array(n * h * w),
    meta: { pixscale_arcsec: pix, frames: mjds.map((mjd) => ({ mjd })) },
  };
}

const PIX = 3; // arcsec per pixel, as in the static cubes (data/cubes/README.md)
const SIZE = 41;
const X0 = 20; // object position at the reference epoch
const Y0 = 20;
const AMP = 3; // peak of the source; noise sigma is 1, so SNR 3 in one frame
const PSF_SIGMA = 1.2; // pixels
const REF_MJD = 61000;

/**
 * N frames of unit Gaussian noise with a Gaussian point source that moves with (pmRa, pmDec)
 * (arcsec/yr). The source is drawn analytically at its sub-pixel position, not interpolated,
 * so the test does not use the code under test to build its own answer.
 */
function movingSourceCube(mjds: number[], pmRa: number, pmDec: number, seed: number): StackableCube {
  const n = mjds.length;
  const cube = makeCube(n, SIZE, SIZE, mjds, PIX);
  const g = gaussian(rng(seed));
  for (let k = 0; k < n; k++) {
    const dtYears = (mjds[k] - REF_MJD) / JULIAN_YEAR_DAYS;
    // East (+RA) = toward column 0, north (+Dec) = toward row 0.
    const sx = X0 - (pmRa * dtYears) / PIX;
    const sy = Y0 - (pmDec * dtYears) / PIX;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const r2 = (x - sx) ** 2 + (y - sy) ** 2;
        cube.data[k * SIZE * SIZE + y * SIZE + x] = AMP * Math.exp(-r2 / (2 * PSF_SIGMA ** 2)) + g();
      }
    }
  }
  return cube;
}

/** 4 epochs a whole Julian year apart, 4 frames each: 16 frames. */
const EPOCH_MJDS = [0, 1, 2, 3].flatMap((yr) => Array(4).fill(REF_MJD + yr * JULIAN_YEAR_DAYS));
// Moves +2 px in x (west) and -1 px in y (north) per year: 6.7 px over 3 years, far more than the PSF.
const PM_RA = -6; // arcsec/yr
const PM_DEC = 3;

const at = (img: Float32Array, x: number, y: number) => img[y * SIZE + x];

// ---------- frameShift ----------

describe("frameShift", () => {
  it("moves east (+RA) toward column 0 and north (+Dec) toward row 0", () => {
    const yr = REF_MJD + JULIAN_YEAR_DAYS;
    expect(frameShift(PIX, 0, yr, REF_MJD, PIX)).toEqual({ dx: -1, dy: 0 });
    expect(frameShift(0, PIX, yr, REF_MJD, PIX)).toEqual({ dx: 0, dy: -1 });
    expect(frameShift(PIX, PIX, REF_MJD - JULIAN_YEAR_DAYS, REF_MJD, PIX)).toEqual({ dx: 1, dy: 1 });
  });

  it("is zero at the reference epoch and for zero motion", () => {
    expect(frameShift(5, -7, REF_MJD, REF_MJD, PIX)).toEqual({ dx: 0, dy: 0 });
    expect(frameShift(0, 0, REF_MJD + 400, REF_MJD, PIX)).toEqual({ dx: 0, dy: 0 });
  });

  it("matches Barnard's Star scale: 10.3 arcsec/yr north on 6.16 arcsec pixels is ~1.7 px/yr", () => {
    const s = frameShift(0, 10.3, REF_MJD + JULIAN_YEAR_DAYS, REF_MJD, 6.16);
    expect(s.dy).toBeCloseTo(-1.672, 3);
  });
});

// ---------- sampleBilinear ----------

describe("sampleBilinear", () => {
  const w = 5;
  const h = 4;
  const ramp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) ramp[y * w + x] = 2 * x + 3 * y + 1;

  it("reproduces a linear ramp exactly at fractional positions", () => {
    for (const [x, y] of [[0, 0], [1.25, 2.5], [3.9, 0.1], [4, 3], [2.5, 2.999]]) {
      expect(sampleBilinear(ramp, 0, w, h, x, y)).toBeCloseTo(2 * x + 3 * y + 1, 4);
    }
  });

  it("returns NaN outside the frame or next to a NaN pixel, but not for zero-weight neighbours", () => {
    expect(sampleBilinear(ramp, 0, w, h, -0.5, 1)).toBeNaN();
    expect(sampleBilinear(ramp, 0, w, h, 4.5, 1)).toBeNaN();
    const holed = ramp.slice();
    holed[1 * w + 2] = NaN;
    expect(sampleBilinear(holed, 0, w, h, 2.5, 1.5)).toBeNaN();
    expect(sampleBilinear(holed, 0, w, h, 3, 1)).toBe(2 * 3 + 3 * 1 + 1); // exact pixel next to the hole
  });

  it("reads the right frame through the offset", () => {
    const two = new Float32Array(2 * w * h);
    two.set(ramp, w * h);
    expect(sampleBilinear(two, w * h, w, h, 1, 1)).toBe(6);
  });
});

// ---------- stack: bookkeeping ----------

describe("stack bookkeeping", () => {
  it("keeps a constant image constant and drops pixels shifted in from outside", () => {
    const n = 3;
    const cube = makeCube(n, 6, 6, [REF_MJD, REF_MJD + JULIAN_YEAR_DAYS, REF_MJD + 2 * JULIAN_YEAR_DAYS], PIX);
    cube.data.fill(5);
    // 1 px/yr toward the west: frame k is sampled at x + k.
    const r = stack(cube, -PIX, 0, REF_MJD);
    expect(r.shifts.map((s) => s.dx)).toEqual([0, 1, 2]);
    for (let y = 0; y < 6; y++) {
      expect(Array.from(r.count.subarray(y * 6, y * 6 + 6))).toEqual([3, 3, 3, 3, 2, 1]);
      for (let x = 0; x < 6; x++) expect(r.image[y * 6 + x]).toBe(5);
    }
  });

  it("ignores NaN pixels per frame", () => {
    const cube = makeCube(3, 3, 3, [REF_MJD, REF_MJD, REF_MJD], PIX);
    cube.data.set([1, 1, 1, 1, 1, 1, 1, 1, 1], 0);
    cube.data.set([2, 2, 2, 2, NaN, 2, 2, 2, 2], 9);
    cube.data.set([6, 6, 6, 6, 6, 6, 6, 6, 6], 18);
    const mean = stack(cube, 0, 0, REF_MJD, "mean");
    expect(mean.image[4]).toBe(3.5);
    expect(mean.count[4]).toBe(2);
    expect(mean.image[0]).toBe(3);
    const med = stack(cube, 0, 0, REF_MJD, "median");
    expect(med.image[4]).toBe(3.5);
    expect(med.image[0]).toBe(2);
  });

  it("marks pixels with no data as NaN in image, noise and snr", () => {
    const cube = makeCube(1, 2, 2, [REF_MJD], PIX, new Float32Array([NaN, 1, 2, 3]));
    const r = stack(cube, 0, 0, REF_MJD);
    expect(r.count[0]).toBe(0);
    expect(r.image[0]).toBeNaN();
    expect(r.noise[0]).toBeNaN();
    expect(r.snr[0]).toBeNaN();
  });

  it("uses only the requested frames", () => {
    const cube = makeCube(3, 1, 1, [REF_MJD, REF_MJD, REF_MJD], PIX, new Float32Array([1, 10, 100]));
    const r = stack(cube, 0, 0, REF_MJD, "mean", { frames: [0, 2] });
    expect(r.image[0]).toBe(50.5);
    expect(r.frames).toEqual([0, 2]);
    expect(() => stack(cube, 0, 0, REF_MJD, "mean", { frames: [3] })).toThrow();
  });

  it("rejects a cube whose data does not match its shape", () => {
    const cube = makeCube(2, 2, 2, [REF_MJD, REF_MJD], PIX, new Float32Array(7));
    expect(() => stack(cube, 0, 0, REF_MJD)).toThrow();
  });
});

// ---------- stack: the science ----------

describe("stack SNR gain on a moving source", () => {
  const N = EPOCH_MJDS.length; // 16
  const singleSnr = AMP / 1; // true per-frame peak SNR
  const cube = movingSourceCube(EPOCH_MJDS, PM_RA, PM_DEC, 20261114);

  it("robust sigma of unit noise is ~1", () => {
    const one = stack(cube, 0, 0, REF_MJD, "mean", { frames: [5] });
    expect(one.sigma).toBeGreaterThan(0.9);
    expect(one.sigma).toBeLessThan(1.1);
  });

  it("grows the SNR by ~sqrt(N) with the right motion vector (mean)", () => {
    const r = stack(cube, PM_RA, PM_DEC, REF_MJD, "mean");
    const gain = at(r.snr, X0, Y0) / singleSnr;
    expect(gain).toBeGreaterThan(0.75 * Math.sqrt(N));
    expect(gain).toBeLessThan(1.25 * Math.sqrt(N));
    // Noise of the mean of N frames is sigma / sqrt(N).
    expect(r.sigma).toBeGreaterThan(0.8 / Math.sqrt(N));
    expect(r.sigma).toBeLessThan(1.2 / Math.sqrt(N));
  });

  it("does not grow the SNR with a zero motion vector", () => {
    const r = stack(cube, 0, 0, REF_MJD, "mean");
    // Only the 4 reference-epoch frames have the source at (X0, Y0): gain ~ 4/16 * sqrt(16) = 1.
    expect(at(r.snr, X0, Y0) / singleSnr).toBeLessThan(2);
    // And no pixel near the track reaches the right-vector level.
    let best = -Infinity;
    for (let y = 10; y <= 30; y++) for (let x = 15; x <= 35; x++) best = Math.max(best, at(r.snr, x, y));
    expect(best).toBeLessThan(0.6 * Math.sqrt(N) * singleSnr);
  });

  it("aligns on the object's position at refMjd", () => {
    const last = REF_MJD + 3 * JULIAN_YEAR_DAYS; // object is at (X0 + 6, Y0 - 3) then
    const r = stack(cube, PM_RA, PM_DEC, last, "mean");
    expect(at(r.snr, X0 + 6, Y0 - 3) / singleSnr).toBeGreaterThan(0.75 * Math.sqrt(N));
  });

  it("also gains with the median, a bit less than the mean", () => {
    const med = stack(cube, PM_RA, PM_DEC, REF_MJD, "median");
    const zero = stack(cube, 0, 0, REF_MJD, "median");
    // Median of Gaussian noise is ~1.25x noisier than the mean, so expect ~0.8 sqrt(N).
    expect(at(med.snr, X0, Y0) / singleSnr).toBeGreaterThan(0.55 * Math.sqrt(N));
    expect(at(zero.snr, X0, Y0) / singleSnr).toBeLessThan(2);
  });

  it("clipped mean ignores a cosmic ray that ruins the plain mean", () => {
    const hit = { ...cube, data: cube.data.slice() };
    hit.data[7 * SIZE * SIZE + 12 * SIZE + 9] = 10000; // one hot pixel, frame 7, far from the source
    const plain = stack(hit, PM_RA, PM_DEC, REF_MJD, "mean");
    const clipped = stack(hit, PM_RA, PM_DEC, REF_MJD, "clipped", { clipSigma: 5 });
    // Find the brightest SNR pixel anywhere: the cosmic ray wins for the mean, the source for clipped.
    const argmax = (img: Float32Array) => {
      let best = -Infinity;
      let bp = -1;
      img.forEach((v, p) => {
        if (v > best) {
          best = v;
          bp = p;
        }
      });
      return [bp % SIZE, Math.floor(bp / SIZE)];
    };
    expect(argmax(plain.snr)).not.toEqual([X0, Y0]);
    expect(argmax(clipped.snr)).toEqual([X0, Y0]);
    expect(at(clipped.snr, X0, Y0) / singleSnr).toBeGreaterThan(0.75 * Math.sqrt(N));
  });

  it("clipped mean keeps nearly all samples on clean data (frame noise computed when missing)", () => {
    const r = stack(cube, PM_RA, PM_DEC, REF_MJD, "clipped");
    // Edge pixels already have fewer frames because of the shift; compare with the plain coverage.
    const plain = stack(cube, PM_RA, PM_DEC, REF_MJD, "mean");
    let lost = 0;
    let maxLost = 0;
    r.count.forEach((c, p) => {
      const d = plain.count[p] - c;
      if (d > 0) lost++;
      maxLost = Math.max(maxLost, d);
    });
    // Few pixels lose a sample (5 sigma from the median is rare for 16 Gaussian samples); none lose many.
    expect(lost).toBeLessThan(0.02 * SIZE * SIZE);
    expect(maxLost).toBeLessThanOrEqual(2);
  });

  it("works with fractional shifts between frames (realistic MJDs)", () => {
    const mjds = Array.from({ length: 16 }, (_, k) => REF_MJD + k * 61.3 + (k % 3) * 0.17);
    const frac = movingSourceCube(mjds, -7.97, 0.81, 42); // WISE 0855's catalogue motion
    const r = stack(frac, -7.97, 0.81, REF_MJD, "mean");
    const zero = stack(frac, 0, 0, REF_MJD, "mean");
    // Bilinear shifts smooth the noise a little, so allow more headroom above sqrt(N).
    const gain = at(r.snr, X0, Y0) / singleSnr;
    expect(gain).toBeGreaterThan(0.75 * Math.sqrt(16));
    expect(gain).toBeLessThan(1.6 * Math.sqrt(16));
    expect(at(zero.snr, X0, Y0)).toBeLessThan(0.6 * at(r.snr, X0, Y0));
  });
});

describe("robustStats", () => {
  it("returns median and 1.4826 * MAD, skipping NaN", () => {
    const s = robustStats([1, 2, 3, 4, 100, NaN]);
    expect(s.median).toBe(3);
    expect(s.sigma).toBeCloseTo(1.4826 * 1, 6);
  });
});

describe("clipped: scale of the clipping (task P-07)", () => {
  // 20 frames of unit noise with a bright source at the centre whose brightness changes ~40x
  // between frames, from 30 to 1200 sigma (as eps Ind B D2: 27 to 1254, LVF wavelengths), and one
  // 50-sigma cosmic ray in frame 3 far from the source.
  const N = 20;
  const S = 21;
  const C = 10;
  const mjds = Array.from({ length: N }, (_, k) => REF_MJD + k * 0.07);
  const g = gaussian(rng(77));
  const data = new Float32Array(N * S * S);
  for (let k = 0; k < N; k++) {
    const amp = 30 * 40 ** (k / (N - 1));
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        data[k * S * S + y * S + x] = amp * Math.exp(-((x - C) ** 2 + (y - C) ** 2) / (2 * PSF_SIGMA ** 2)) + g();
      }
    }
  }
  const RAY = { k: 3, x: 3, y: 17 };
  data[RAY.k * S * S + RAY.y * S + RAY.x] += 50;
  const cube: StackableCube = {
    ...makeCube(N, S, S, mjds, PIX, data),
    meta: { pixscale_arcsec: PIX, frames: mjds.map((mjd) => ({ mjd, noise: 1 })) },
  };
  const px = (p: number[] | Uint16Array | Float32Array, x: number, y: number) => p[y * S + x];

  it("defaults to the frame noise (behaviour unchanged)", () => {
    const def = stack(cube, 0, 0, REF_MJD, "clipped");
    const frame = stack(cube, 0, 0, REF_MJD, "clipped", { clipScale: "frame" });
    expect(Array.from(def.image)).toEqual(Array.from(frame.image));
    expect(Array.from(def.count)).toEqual(Array.from(frame.count));
  });

  it("frame scale drops real starlight of the bright source; pixel scale keeps all of it", () => {
    const frame = stack(cube, 0, 0, REF_MJD, "clipped", { clipScale: "frame" });
    const pixel = stack(cube, 0, 0, REF_MJD, "clipped", { clipScale: "pixel" });
    const mean = stack(cube, 0, 0, REF_MJD, "mean");
    expect(px(frame.count, C, C)).toBeLessThan(N / 2);
    expect(px(pixel.count, C, C)).toBe(N);
    expect(px(pixel.image, C, C)).toBeCloseTo(px(mean.image, C, C), 3);
  });

  it("rejects a 50-sigma spike in one frame with either scale", () => {
    for (const clipScale of ["frame", "pixel"] as const) {
      const r = stack(cube, 0, 0, REF_MJD, "clipped", { clipScale });
      expect(px(r.count, RAY.x, RAY.y), clipScale).toBe(N - 1);
      expect(Math.abs(px(r.image, RAY.x, RAY.y)), clipScale).toBeLessThan(1);
    }
  });
});

describe("per-frame brightness scale (task A-13)", () => {
  // The P-07 fixture again: a source 40x brighter in the last frame than in the first (as an LVF
  // frame sees a target at its own wavelength), unit noise, a 50-sigma cosmic ray in frame 3.
  const N = 20;
  const S = 21;
  const C = 10;
  const mjds = Array.from({ length: N }, (_, k) => REF_MJD + k * 0.07);
  const amps = Array.from({ length: N }, (_, k) => 30 * 40 ** (k / (N - 1)));
  function build(seed: number, withSource: boolean): StackableCube {
    const g = gaussian(rng(seed));
    const data = new Float32Array(N * S * S);
    for (let k = 0; k < N; k++) {
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const s = withSource ? amps[k] * Math.exp(-((x - C) ** 2 + (y - C) ** 2) / (2 * PSF_SIGMA ** 2)) : 0;
          data[k * S * S + y * S + x] = s + g();
        }
      }
    }
    return {
      ...makeCube(N, S, S, mjds, PIX, data),
      meta: { pixscale_arcsec: PIX, frames: mjds.map((mjd) => ({ mjd, noise: 1 })) },
    };
  }
  const cube = build(77, true);
  const RAY = { k: 3, x: 3, y: 17 };
  cube.data[RAY.k * S * S + RAY.y * S + RAY.x] += 50;
  const px = (p: number[] | Uint16Array | Float32Array, x: number, y: number) => p[y * S + x];

  it("frameBrightness: aperture = search radius + one native pixel; every frame sees the source", () => {
    const b = frameBrightness(cube, C, C, 4);
    expect(b.apertureRadius).toBeCloseTo(4 + NATIVE_PIXEL_ARCSEC / PIX, 12);
    expect(b.nMeasurable).toBe(N);
    // Sum of a Gaussian of peak A and sigma s is 2 pi s^2 A.
    for (let k = 0; k < N; k++) expect(b.amp[k] / (2 * Math.PI * PSF_SIGMA ** 2 * amps[k])).toBeCloseTo(1, 0);
    expect(Math.min(...b.snr)).toBeGreaterThan(FRAME_DETECT_SNR);
  });

  it("brightnessScale follows the source: 40x between first and last frame, median 1", () => {
    const scale = brightnessScale(cube, C, C, 4)!;
    expect(scale).not.toBeNull();
    expect(scale[N - 1] / scale[0]).toBeGreaterThan(40 * 0.9);
    expect(scale[N - 1] / scale[0]).toBeLessThan(40 * 1.1);
    expect(robustStats(scale).median).toBeCloseTo(1, 6);
  });

  it("is null on blank sky and on a source too faint for single frames: frames are stacked as they are", () => {
    expect(brightnessScale(build(5, false), C, C, 4)).toBeNull();
    // AMP = 3 at unit noise: SNR 3 in the peak pixel, ~1 in the aperture sum.
    const faint = movingSourceCube(mjds, 0, 0, 6);
    const b = frameBrightness(faint, X0, Y0, 4);
    expect(b.nMeasurable).toBeLessThan(mjds.length / 2);
    expect(brightnessScale(faint, X0, Y0, 4)).toBeNull();
  });

  it("with the scale every frame shows the same brightness, so the clip keeps all the starlight", () => {
    const scale = brightnessScale(cube, C, C, 4)!;
    const r = stack(cube, 0, 0, REF_MJD, "clipped", { clipScale: "pixel", scale });
    expect(px(r.count, C, C)).toBe(N);
    // The stack keeps the cube's units: the peak is that of a frame of median brightness.
    const typicalPeak = robustStats(amps).median;
    expect(px(r.image, C, C) / typicalPeak).toBeGreaterThan(0.9);
    expect(px(r.image, C, C) / typicalPeak).toBeLessThan(1.1);
    // Frame by frame the scaled peak agrees to a few %, where the raw peaks differ 40x.
    const peaks = amps.map((_, k) => cube.data[k * S * S + C * S + C] / scale[k]);
    expect(Math.max(...peaks) / Math.min(...peaks)).toBeLessThan(1.2);
  });

  it("still rejects the 50-sigma cosmic ray", () => {
    const scale = brightnessScale(cube, C, C, 4)!;
    const r = stack(cube, 0, 0, REF_MJD, "clipped", { clipScale: "pixel", scale });
    expect(px(r.count, RAY.x, RAY.y)).toBe(N - 1);
    const clean = stack(cube, 0, 0, REF_MJD, "mean", { scale, frames: mjds.map((_, k) => k).filter((k) => k !== RAY.k) });
    expect(px(r.image, RAY.x, RAY.y)).toBeCloseTo(px(clean.image, RAY.x, RAY.y), 5);
  });

  it("leaves out frames without a usable scale and rejects a scale of the wrong length", () => {
    const scale = Array.from(brightnessScale(cube, C, C, 4)!);
    scale[2] = NaN;
    scale[5] = 0;
    const r = stack(cube, 0, 0, REF_MJD, "mean", { scale });
    expect(r.frames).toEqual(mjds.map((_, k) => k).filter((k) => k !== 2 && k !== 5));
    expect(px(r.count, C, C)).toBe(N - 2);
    expect(() => stack(cube, 0, 0, REF_MJD, "mean", { scale: [1, 2, 3] })).toThrow(/scale/);
  });

  it("a scale of all ones changes nothing", () => {
    const ones = new Float64Array(N).fill(1);
    for (const mode of ["mean", "median", "clipped"] as const) {
      const a = stack(cube, 2, -3, REF_MJD, mode);
      const b = stack(cube, 2, -3, REF_MJD, mode, { scale: ones });
      expect(Array.from(b.image), mode).toEqual(Array.from(a.image));
      expect(Array.from(b.count), mode).toEqual(Array.from(a.count));
    }
  });
});
