import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadCube, type Cube, type CubeMeta } from "./cube";
import {
  BRIGHT_SNR,
  PEAK_RADIUS_PX,
  SNR_LO,
  SNR_MIN_HI,
  centrePx,
  clampMotion,
  defaultStackMode,
  meanMjd,
  stackScales,
  stackView,
} from "./stackView";
import { JULIAN_YEAR_DAYS } from "../search/stack";

// ---------------------------------------------------------------------------------------------
// Small synthetic cube: a 1-pixel source on a 15 x 15 grid that moves 1 px west (+x) per frame,
// frames one Julian year apart, 3″ pixels -> the source moves -3″/yr in RA (west), 0 in Dec.
// Test-only fixture; never shown in the demo.
// ---------------------------------------------------------------------------------------------
function movingCube(flux: number, noiseSeed = 1): Cube {
  const n = 5;
  const w = 15;
  const h = 15;
  const data = new Float32Array(n * h * w);
  let s = noiseSeed;
  const rand = () => {
    s = (s * 16807) % 2147483647; // Park-Miller, deterministic
    return s / 2147483647 - 0.5;
  };
  for (let k = 0; k < n; k++) {
    for (let p = 0; p < h * w; p++) data[k * h * w + p] = 0.2 * rand();
    data[k * h * w + 7 * w + (5 + k)] += flux; // x = 5..9, the middle frame at the centre (7, 7)
  }
  const meta: CubeMeta = {
    center: { ra: 0, dec: 0 },
    pixscale_arcsec: 3,
    shape: [n, h, w],
    frames: Array.from({ length: n }, (_, k) => ({
      id: `f${k}`,
      band: "D1",
      mjd: 60000 + k * JULIAN_YEAR_DAYS,
      lam_um: 1,
      noise: 0.06,
      nan_frac: 0,
    })),
    data_url: "cube.f32",
  };
  return { meta, data, n, h, w };
}

describe("stackView on a synthetic moving source", () => {
  it("aligns on the mean time, and the right vector piles the source onto one pixel", () => {
    const cube = movingCube(5);
    expect(meanMjd(cube)).toBeCloseTo(60000 + 2 * JULIAN_YEAR_DAYS, 6);
    expect(centrePx(cube)).toEqual({ x: 7, y: 7 });

    const right = stackView(cube, -3, 0, "mean");
    const zero = stackView(cube, 0, 0, "mean");
    // Right vector: all 5 frames land on (7, 7), so the mean there is the full flux.
    expect(right.peak.x).toBe(7);
    expect(right.peak.y).toBe(7);
    expect(right.result.image[7 * cube.w + 7]).toBeCloseTo(5, 0);
    // Zero vector: the flux is spread over 5 pixels, a fifth on each.
    expect(zero.result.image[7 * cube.w + 7]).toBeCloseTo(1, 0);
    expect(right.peak.snr).toBeGreaterThan(3 * zero.peak.snr);
  });

  it("picks mean for a bright source and clipped for a faint one", () => {
    expect(BRIGHT_SNR).toBe(50);
    expect(defaultStackMode(movingCube(200))).toBe("mean");
    expect(defaultStackMode(movingCube(0.5))).toBe("clipped");
  });

  it("fixes the display scales from the zero-motion stack", () => {
    const zero = stackView(movingCube(0.5), 0, 0, "mean");
    const s = stackScales(zero);
    expect(s.snr.lo).toBe(SNR_LO);
    expect(s.snr.hi).toBe(Math.max(SNR_MIN_HI, zero.peak.snr));
    expect(s.image.hi).toBeGreaterThan(s.image.lo);
  });

  it("puts the image white point at the brightest pixel near the centre, not at a far bright star", () => {
    const cube = movingCube(5);
    cube.data[0] = 1000; // a bright pixel in a corner of frame 0, 9.9 px from the centre
    const zero = stackView(cube, 0, 0, "mean");
    // Near the centre the brightest stacked pixel is a fifth of the flux plus noise: about 1.
    const hi = stackScales(zero).image.hi;
    expect(hi).toBeGreaterThan(0.8);
    expect(hi).toBeLessThan(1.3);
  });
});

describe("clampMotion", () => {
  it("clamps to +/- max, rounds to 0.01 and turns junk into 0", () => {
    expect(clampMotion(3.14159, 15)).toBe(3.14);
    expect(clampMotion(-40, 15)).toBe(-15);
    expect(clampMotion(Number.NaN, 15)).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Real cubes (data/cubes/, role A). Catalogue motions, arcsec/yr, pmRa includes cos Dec:
//   Barnard's Star, Gaia DR3: (-0.80, +10.36)  https://simbad.cds.unistra.fr/simbad/sim-id?Ident=Barnard%27s+star
//   WISE 0855-0714, CatWISE2020: (-7.97, +0.81) (as in experiments/check_objects.py and lib/objects.ts)
// ---------------------------------------------------------------------------------------------
const cubesDir =
  process.env.OSU_CUBES_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data/cubes");
const fileFetch = (async (input: string | URL | Request) =>
  new Response(new Uint8Array(readFileSync(String(input))))) as typeof fetch;
const cubeJson = (obj: string, band: string) => path.join(cubesDir, obj, band, "cube.json");
const load = (obj: string, band: string) => loadCube(cubeJson(obj, band).replaceAll("\\", "/"), fileFetch);

/** Flux-weighted centroid and RMS widths of the positive pixels within r of (cx, cy). */
function moments(img: Float32Array, w: number, h: number, cx: number, cy: number, r: number) {
  let s = 0;
  let sx = 0;
  let sy = 0;
  const inside = (x: number, y: number) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = img[y * w + x];
      if (!inside(x, y) || !(v > 0)) continue;
      s += v;
      sx += v * x;
      sy += v * y;
    }
  const mx = sx / s;
  const my = sy / s;
  let vxx = 0;
  let vyy = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = img[y * w + x];
      if (!inside(x, y) || !(v > 0)) continue;
      vxx += v * (x - mx) ** 2;
      vyy += v * (y - my) ** 2;
    }
  return { x: mx, y: my, sx: Math.sqrt(vxx / s), sy: Math.sqrt(vyy / s) };
}

describe.skipIf(!existsSync(cubeJson("barnard", "D1")))("real cube: barnard D1 stack", () => {
  it("is compact with the Gaia vector and smeared north-south at (0, 0) by the expected amount", async () => {
    const cube = await load("barnard", "D1");
    expect(defaultStackMode(cube)).toBe("mean");
    const ref = meanMjd(cube);
    const cat = stackView(cube, -0.8, 10.36, "mean", ref);
    const zero = stackView(cube, 0, 0, "mean", ref);
    const c = centrePx(cube);
    const mCat = moments(cat.result.image, cube.w, cube.h, c.x, c.y, 6);
    const mZero = moments(zero.result.image, cube.w, cube.h, c.x, c.y, 6);

    // Without the shift, frame k holds the star dy_k = -pmDec * (t_k - ref) / pix rows from its
    // mean position. A mean of shifted copies has variance PSF^2 + var(dy_k) (variances add).
    const pix = cube.meta.pixscale_arcsec;
    const dy = cube.meta.frames.map((f) => (-10.36 * (f.mjd - ref)) / JULIAN_YEAR_DAYS / pix);
    const meanDy = dy.reduce((a, b) => a + b, 0) / dy.length;
    const varDy = dy.reduce((a, b) => a + (b - meanDy) ** 2, 0) / dy.length;
    const expectedSy = Math.sqrt(mCat.sy ** 2 + varDy);

    expect(Math.sqrt(varDy)).toBeGreaterThan(1); // more than a pixel of motion over the visits
    expect(mZero.sy).toBeGreaterThan(mCat.sy + 0.2); // visibly elongated north-south at (0, 0)
    expect(Math.abs(mZero.sy - expectedSy)).toBeLessThan(0.3); // by the amount the motion predicts
    expect(Math.abs(mZero.sx - mCat.sx)).toBeLessThan(0.2); // and hardly east-west (pmRa is small)
  });
});

describe.skipIf(!existsSync(cubeJson("wise0855", "D6")))("real cube: wise0855 D6 stack", () => {
  it("uses clipped, and the catalogue vector beats zero and the reversed vector", async () => {
    const cube = await load("wise0855", "D6");
    expect(defaultStackMode(cube)).toBe("clipped");
    const cat = stackView(cube, -7.97, 0.81, "clipped");
    const zero = stackView(cube, 0, 0, "clipped");
    const rev = stackView(cube, 7.97, -0.81, "clipped");
    expect(PEAK_RADIUS_PX).toBe(4);
    // Changing the vector changes both the image and the SNR.
    expect(cat.result.image).not.toEqual(zero.result.image);
    expect(cat.peak.snr).toBeGreaterThan(zero.peak.snr);
    expect(zero.peak.snr).toBeGreaterThan(rev.peak.snr);
  });
});
