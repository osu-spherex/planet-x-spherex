// P-10 (issue #100): the search answer must not depend on the cube's field of view. The site opens
// 6′ live cubes (121 px), the static demo cubes are 3′ (61 px); on Barnard's Star the same 60 frames
// gave 1.66″/yr off Gaia on the 3′ cube and 5.09 on a 6′ one, because real pixels from outside the
// 3′ field shifted into the stacking box. Here the real 3′ cubes are put in the middle of a 121 x 121
// cube whose outer part is filled with arbitrary finite values (noise far above the frame noise and
// a bright fake star just outside the 3′ field): the search with the viewer's options must give
// exactly the 3′ answer, and without the 3′ field (field: Infinity) it must not.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PEAK_RADIUS_ARCSEC, STACK_BOX_ARCSEC, arcsecToPx } from "../viewer/stackView";
import { STATIC_FIELD_ARCMIN, fieldWindow, velocityGrid, type GridOptions, type GridResult } from "./grid";
import { stack, type StackableCube } from "./stack";

const here = path.dirname(fileURLToPath(import.meta.url));
const cubesDir = path.resolve(here, "../../data/cubes");
const have = (rel: string) => existsSync(path.join(cubesDir, rel, "cube.json"));

type MetaCube = StackableCube & { meta: StackableCube["meta"] & { shape?: number[] } };

function loadStatic(rel: string): MetaCube {
  const dir = path.join(cubesDir, rel);
  const meta = JSON.parse(readFileSync(path.join(dir, "cube.json"), "utf8"));
  const buf = readFileSync(path.join(dir, meta.data_url));
  const data = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const [n, h, w] = meta.shape;
  return { n, h, w, data, meta };
}

/** Deterministic pseudo-random numbers in [0, 1) (mulberry32). */
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

/** `small` in the middle of a size x size cube; every other pixel gets a finite made-up value. */
function embed(small: MetaCube, size: number, seed: number): MetaCube {
  const { n, h, w } = small;
  const ox = (size - w) / 2;
  const oy = (size - h) / 2;
  if (!Number.isInteger(ox) || !Number.isInteger(oy)) throw new Error("size must keep the centre pixel");
  const data = new Float32Array(n * size * size);
  const rand = rng(seed);
  const cx = (size - 1) / 2;
  const starX = cx + w / 2 + 2; // just outside the 3′ field, east of the target
  for (let f = 0; f < n; f++) {
    const noise = small.meta.frames[f].noise ?? 0.1;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const inside = x >= ox && x < ox + w && y >= oy && y < oy + h;
        const p = f * size * size + y * size + x;
        if (inside) {
          data[p] = small.data[f * h * w + (y - oy) * w + (x - ox)];
        } else {
          const star = 500 * noise * Math.exp(-((x - starX) ** 2 + (y - cx) ** 2) / 4);
          data[p] = 20 * noise * (rand() - 0.5) + star;
        }
      }
    }
  }
  return { n, h: size, w: size, data, meta: { ...small.meta, shape: [n, size, size] } };
}

/** The viewer's search options (viewer/Search.tsx), centred on the cube. */
function viewerOptions(cube: MetaCube, extra: GridOptions = {}): GridOptions {
  const c = (cube.w - 1) / 2;
  const asCube = { meta: cube.meta } as Parameters<typeof arcsecToPx>[0];
  return {
    centerX: c,
    centerY: c,
    radius: arcsecToPx(asCube, PEAK_RADIUS_ARCSEC),
    noiseBox: arcsecToPx(asCube, STACK_BOX_ARCSEC),
    ...extra,
  };
}

/** Same answer, pixel positions taken relative to the centre. */
function expectSameAnswer(big: GridResult, small: GridResult, offset: number) {
  const rel = (s: GridResult["best"], o: number) => ({ ...s, x: s.x - o, y: s.y - o });
  expect(big.pmRaAxis).toEqual(small.pmRaAxis);
  expect(big.pmDecAxis).toEqual(small.pmDecAxis);
  expect(Array.from(big.score)).toEqual(Array.from(small.score));
  expect(rel(big.gridBest, offset)).toEqual(rel(small.gridBest, 0));
  expect(rel(big.best, offset)).toEqual(rel(small.best, 0));
  expect(big.fitted).toBe(small.fitted);
  expect(big.normalised).toBe(small.normalised);
  expect(big.framesUsed).toBe(small.framesUsed);
}

describe("fieldWindow", () => {
  it("is the whole 61-pixel static cube and the middle 61 pixels of a 121-pixel cube", () => {
    expect(STATIC_FIELD_ARCMIN).toBe(3);
    const whole61 = { x0: 0, y0: 0, x1: 61, y1: 61 };
    const middle121 = { x0: 30, y0: 30, x1: 91, y1: 91 };
    expect(fieldWindow(30, 30, 61, 61, 3, STATIC_FIELD_ARCMIN)).toEqual(whole61);
    // Off-centre searches on a static cube (the blank regions 45″ out) still use the whole cube.
    expect(fieldWindow(45, 30, 61, 61, 3, STATIC_FIELD_ARCMIN)).toEqual(whole61);
    expect(fieldWindow(0, 60, 61, 61, 3, STATIC_FIELD_ARCMIN)).toEqual(whole61);
    expect(fieldWindow(60, 60, 121, 121, 3, STATIC_FIELD_ARCMIN)).toEqual(middle121);
    expect(fieldWindow(75, 45, 121, 121, 3, STATIC_FIELD_ARCMIN)).toEqual(middle121);
    // Outside the middle 3′ of a wide cube: a 3′ field around the search centre.
    expect(fieldWindow(110, 60, 121, 121, 3, STATIC_FIELD_ARCMIN)).toEqual({ x0: 80, y0: 30, x1: 141, y1: 91 });
    expect(fieldWindow(60, 60, 121, 121, 3, Infinity)).toBeUndefined();
    expect(() => fieldWindow(60, 60, 121, 121, 3, 0)).toThrow();
  });
});

describe("stack with a window equals the stack of the cut-out cube", () => {
  it("synthetic cube: same pixels, noise and SNR inside the window", () => {
    const n = 6;
    const rand = rng(7);
    const small: MetaCube = {
      n,
      h: 21,
      w: 21,
      data: Float32Array.from({ length: n * 21 * 21 }, () => rand() - 0.5),
      meta: { pixscale_arcsec: 3, frames: Array.from({ length: n }, (_, f) => ({ mjd: 60000 + 60 * f, noise: 0.29 })) },
    };
    const big = embed(small, 41, 3);
    const win = { x0: 10, y0: 10, x1: 31, y1: 31 };
    for (const mode of ["mean", "median", "clipped"] as const) {
      const a = stack(small, 3, -5, 60150, mode);
      const b = stack(big, 3, -5, 60150, mode, { window: win });
      expect(b.background).toBe(a.background);
      expect(b.sigma).toBe(a.sigma);
      for (let y = 0; y < 41; y++) {
        for (let x = 0; x < 41; x++) {
          const inside = x >= 10 && x < 31 && y >= 10 && y < 31;
          const p = y * 41 + x;
          if (!inside) {
            expect(b.count[p]).toBe(0);
            continue;
          }
          const q = (y - 10) * 21 + (x - 10);
          expect(b.count[p]).toBe(a.count[q]);
          expect(Object.is(b.image[p], a.image[q]) || b.image[p] === a.image[q]).toBe(true);
          expect(Object.is(b.snr[p], a.snr[q]) || b.snr[p] === a.snr[q]).toBe(true);
        }
      }
    }
  });
});

const CASES: Array<{ rel: string; seed: number }> = [
  { rel: "barnard/D1", seed: 1 },
  { rel: "wise0855/D6", seed: 2 },
];

for (const { rel, seed } of CASES) {
  describe.skipIf(!have(rel))(`${rel}: 3′ cube inside a 6′ cube`, () => {
    it("the search gives exactly the 3′ answer; without the 3′ field it does not", () => {
      const small = loadStatic(rel);
      expect([small.h, small.w]).toEqual([61, 61]);
      const big = embed(small, 121, seed);

      const r61 = velocityGrid(small, viewerOptions(small));
      const r121 = velocityGrid(big, viewerOptions(big));
      expectSameAnswer(r121, r61, 30);

      // Off-centre inside the 3′ field (the blank regions are 45″ = 15 px out): also identical.
      const off61 = velocityGrid(small, viewerOptions(small, { centerX: 45, centerY: 30 }));
      const off121 = velocityGrid(big, viewerOptions(big, { centerX: 75, centerY: 60 }));
      expectSameAnswer(off121, off61, 30);

      // The outer pixels did matter before P-10: the whole-cube search on the 121 cube differs.
      const before = velocityGrid(big, viewerOptions(big, { field: Infinity }));
      expect(Array.from(before.score)).not.toEqual(Array.from(r61.score));
      // And on the 61-pixel cube the 3′ field is the whole cube: nothing changes there.
      const whole61 = velocityGrid(small, viewerOptions(small, { field: Infinity }));
      expect(Array.from(whole61.score)).toEqual(Array.from(r61.score));

      console.log(
        `NUMBERS P-10 ${rel}: 3′ best (${r61.best.pmRa.toFixed(2)}, ${r61.best.pmDec.toFixed(2)}) SNR ${r61.best.snr.toFixed(2)}; ` +
          `6′ now identical; 6′ before (${before.best.pmRa.toFixed(2)}, ${before.best.pmDec.toFixed(2)}) SNR ${before.best.snr.toFixed(2)}; ` +
          `time 6′ now ${r121.elapsedMs.toFixed(0)} ms, before ${before.elapsedMs.toFixed(0)} ms`,
      );
    }, 120_000);
  });
}
