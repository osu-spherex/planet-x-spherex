import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEMO_OBJECTS } from "../lib/objects";
import { regionPeak, scoreGridOn, velocityGrid, type GridResult } from "./grid";
import results from "./results.json";
import { DETECT_SNR, MOTION_ALPHA, bestMoving, mulberry32, permutation, withTimes } from "./significance";
import { JULIAN_YEAR_DAYS, stack, type StackableCube } from "./stack";
import { checkSameGrid, multiSource, stackMulti, velocityGridMulti } from "./stackMulti";

// ---------- fixtures ----------

const PIX = 3;
const SIZE = 31;
const C = 15;
const N = 12; // frames per detector
// SPHEREx images its detectors at the same time, so both detectors share the frame times.
const MJDS = [0, 0.5, 1].flatMap((yr) => Array.from({ length: N / 3 }, (_, i) => 61000 + yr * JULIAN_YEAR_DAYS + i * 0.07));
const REF = MJDS.reduce((a, b) => a + b, 0) / MJDS.length;
const PM = { pmRa: -6, pmDec: 3 };

/** One detector: noise sigma `noise`, Gaussian source (sigma 1.2 px, peak `amp`) moving with PM. */
function detector(seed: number, amp: number, noise = 1, centre?: { ra: number; dec: number }): StackableCube {
  const rand = mulberry32(seed);
  const g = () => Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-12))) * Math.cos(2 * Math.PI * rand());
  const data = new Float32Array(N * SIZE * SIZE);
  MJDS.forEach((mjd, k) => {
    const dt = (mjd - REF) / JULIAN_YEAR_DAYS;
    const sx = C - (PM.pmRa * dt) / PIX;
    const sy = C - (PM.pmDec * dt) / PIX;
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
      data[k * SIZE * SIZE + y * SIZE + x] = amp * Math.exp(-((x - sx) ** 2 + (y - sy) ** 2) / 2.88) + noise * g();
    }
  });
  const meta = { pixscale_arcsec: PIX, frames: MJDS.map((mjd) => ({ mjd, noise })), ...(centre ? { center: centre } : {}) };
  return { n: N, h: SIZE, w: SIZE, data, meta };
}

/** SNR at the source's known pixel in a stack aligned on the true motion (a maximum over nearby
 *  pixels would add a noise bump to every stack and squeeze the ratios toward 1). */
const peak = (r: { snr: Float32Array; w: number }) => r.snr[C * r.w + C];
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
const SEEDS = [1, 2, 3, 4, 5, 6];

// ---------- stackMulti ----------

describe("stackMulti", () => {
  it("on one cube with equal frame noise is exactly stack()", () => {
    const d = detector(1, 2);
    for (const mode of ["clipped", "mean"] as const) {
      const m = stackMulti([d], PM.pmRa, PM.pmDec, REF, { mode });
      const s = stack(d, PM.pmRa, PM.pmDec, REF, mode);
      expect(Array.from(m.count)).toEqual(Array.from(s.count));
      for (let p = 0; p < m.image.length; p++) {
        if (Number.isNaN(s.image[p])) {
          expect(m.image[p]).toBeNaN();
          continue;
        }
        expect(m.image[p]).toBeCloseTo(s.image[p], 5);
        expect(m.snr[p]).toBeCloseTo(s.snr[p], 4);
      }
    }
  });

  it("two detectors with the same brightness: SNR grows by ~√2", () => {
    const ratios = SEEDS.map((s) => {
      const a = detector(100 + s, 1);
      const b = detector(200 + s, 1);
      return peak(stackMulti([a, b], PM.pmRa, PM.pmDec, REF)) / peak(stackMulti([a], PM.pmRa, PM.pmDec, REF));
    });
    expect(mean(ratios)).toBeGreaterThan(1.25);
    expect(mean(ratios)).toBeLessThan(1.6);
  });

  it("source in one detector only: combining is worse than that detector alone (~1/√2)", () => {
    const ratios = SEEDS.map((s) => {
      const bright = detector(300 + s, 1.5);
      const dark = detector(400 + s, 0);
      return peak(stackMulti([bright, dark], PM.pmRa, PM.pmDec, REF)) / peak(stackMulti([bright], PM.pmRa, PM.pmDec, REF));
    });
    for (const r of ratios) expect(r).toBeLessThan(1);
    expect(mean(ratios)).toBeGreaterThan(0.55);
    expect(mean(ratios)).toBeLessThan(0.85);
  });

  it("weights by 1/noise²: a 3x noisier detector still helps a little; an unweighted mean would hurt", () => {
    const weighted: number[] = [];
    const unweighted: number[] = [];
    for (const s of SEEDS) {
      const clean = detector(500 + s, 1, 1);
      const noisy = detector(600 + s, 1, 3);
      const alone = peak(stackMulti([clean], PM.pmRa, PM.pmDec, REF));
      weighted.push(peak(stackMulti([clean, noisy], PM.pmRa, PM.pmDec, REF)) / alone);
      // The same frames in one cube, plain mean: every frame counts equally.
      const merged: StackableCube = {
        n: 2 * N,
        h: SIZE,
        w: SIZE,
        data: Float32Array.from([...clean.data, ...noisy.data]),
        meta: { pixscale_arcsec: PIX, frames: [...clean.meta.frames, ...noisy.meta.frames] },
      };
      unweighted.push(peak(stack(merged, PM.pmRa, PM.pmDec, REF, "mean")) / alone);
    }
    // Expected: weighted sqrt(1 + 1/9) = 1.05, unweighted 2 / sqrt(1 + 9) = 0.63.
    expect(mean(weighted)).toBeGreaterThan(0.95);
    expect(mean(weighted)).toBeLessThan(1.2);
    expect(mean(unweighted)).toBeLessThan(0.8);
  });

  it("clips within each detector: a source bright in one detector keeps all its light", () => {
    const bright = detector(7, 20);
    const dark = detector(8, 0);
    dark.data[3 * SIZE * SIZE + 4 * SIZE + 27] += 1000; // cosmic ray, detector 2, frame 3, far from the source
    const r = stackMulti([bright, dark], PM.pmRa, PM.pmDec, REF);
    // Across detectors the bright samples would sit ~20 sigma from the median and be dropped.
    expect(r.count[C * SIZE + C]).toBe(2 * N);
    // With zero motion nothing is shifted, so the ray stays on its own pixel.
    const r0 = stackMulti([bright, dark], 0, 0, REF);
    expect(r0.count[4 * SIZE + 27]).toBe(2 * N - 1);
    expect(Math.abs(r0.image[4 * SIZE + 27])).toBeLessThan(1);
  });

  it("refuses cubes that do not share a grid", () => {
    const a = detector(1, 0, 1, { ra: 100, dec: 20 });
    expect(() => checkSameGrid([a, { ...a, w: 30, h: 30, data: new Float32Array(N * 900) }])).toThrow(/size/);
    expect(() => checkSameGrid([a, { ...a, meta: { ...a.meta, pixscale_arcsec: 6 } }])).toThrow(/pixel scale/);
    const shifted = (arcsec: number) => ({ ...a, meta: { ...a.meta, center: { ra: 100, dec: 20 + arcsec / 3600 } } });
    expect(() => checkSameGrid([a, shifted(3)])).toThrow(/centres/);
    expect(() => checkSameGrid([a, shifted(0.1)])).not.toThrow();
    expect(() => checkSameGrid([])).toThrow();
  });
});

// ---------- velocityGridMulti ----------

describe("velocityGridMulti", () => {
  it("finds the motion in two detectors, with a higher score than one detector", () => {
    const a = detector(11, 2);
    const b = detector(12, 2);
    const both = velocityGridMulti([a, b], { pmMax: 9 });
    const one = velocityGridMulti([a], { pmMax: 9 });
    expect(Math.abs(both.best.pmRa - PM.pmRa)).toBeLessThanOrEqual(both.step);
    expect(Math.abs(both.best.pmDec - PM.pmDec)).toBeLessThanOrEqual(both.step);
    expect(both.gridBest.snr).toBeGreaterThan(one.gridBest.snr);
    expect(both.baselineYears).toBeCloseTo(one.baselineYears, 9);
  });

  it("rejects stack modes it does not implement", () => {
    expect(() => velocityGridMulti([detector(1, 1)], { pmMax: 3, mode: "median" })).toThrow();
    expect(() => velocityGridMulti([detector(1, 1)], { pmMax: 3, clipScale: "pixel" })).toThrow();
  });
});

// ---------- real cubes: D1-D6 from role A (task A-08) ----------

const here = path.dirname(fileURLToPath(import.meta.url));
const cubesDir = path.resolve(here, "../../data/cubes");
const BANDS = ["D1", "D2", "D3", "D4", "D5", "D6"];
const haveBands = (obj: string) => BANDS.every((b) => existsSync(path.join(cubesDir, obj, b, "cube.json")));

function loadStatic(obj: string, band: string): StackableCube {
  const dir = path.join(cubesDir, obj, band);
  const meta = JSON.parse(readFileSync(path.join(dir, "cube.json"), "utf8"));
  const buf = readFileSync(path.join(dir, meta.data_url));
  const data = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const [n, h, w] = meta.shape;
  return { n, h, w, data, meta };
}

/** One search per (object, detectors), shared by the tests below (the six-detector ones take a while). */
const searched = new Map<string, { cubes: StackableCube[]; r: GridResult }>();
function search(obj: string, bands: readonly string[]) {
  const key = `${obj} ${bands.join("+")}`;
  let hit = searched.get(key);
  if (!hit) {
    const cubes = bands.map((b) => loadStatic(obj, b));
    hit = { cubes, r: velocityGridMulti(cubes) };
    searched.set(key, hit);
  }
  return hit;
}

// Numbers for search/README.md once role A's six-detector cubes (A-08) are in data/cubes/.
// No assertion about the direction: whether combining helps is what we want to find out.
describe.each([
  ["wise0855", ["D6"], [["D5", "D6"], BANDS]],
  ["epsindb", ["D2"], [BANDS]],
] as const)("combined detectors on %s (real cubes, A-08)", (obj, alone, combos) => {
  it.skipIf(!haveBands(obj))("best motion and score: one detector vs combined", () => {
    const cat = DEMO_OBJECTS.find((o) => o.id === obj)!.catalogueMotion!;
    const line = (label: string, bands: readonly string[]) => {
      const { r } = search(obj, bands);
      const off = Math.hypot(r.best.pmRa - cat.pmRa, r.best.pmDec - cat.pmDec);
      console.info(
        `NUMBERS P-06 ${obj} ${label} [${bands.join("+")}]: gridBest SNR ${r.gridBest.snr.toFixed(2)} ` +
          `best (${r.best.pmRa.toFixed(2)}, ${r.best.pmDec.toFixed(2)}) off ${off.toFixed(2)} ″/yr ${(r.elapsedMs / 1000).toFixed(1)} s`,
      );
      expect(Number.isFinite(r.gridBest.snr)).toBe(true);
      return r;
    };
    line("alone", alone);
    for (const bands of combos) line("combined", bands);
    // Same stacking with the original single cube path, for reference.
    console.info(`NUMBERS P-06 ${obj} velocityGrid(${alone[0]}): gridBest SNR ${velocityGrid(loadStatic(obj, alone[0])).gridBest.snr.toFixed(2)}`);
  }, 600000);
});

// ---------- results.json "multi" (task P-09) ----------
// The combined-detector numbers that search/README.md, docs/METHOD_SEARCH.md and the /method page
// quote. Every row is searched again here and must match the file.

/** Rounded as results.json stores it; `+ 0` turns -0 into 0 (as in numbers.test.ts). */
const r2 = (v: number) => Number(v.toFixed(2)) + 0;
const zeroOf = (r: GridResult) => r.score[r.pmDecAxis.indexOf(0) * r.pmRaAxis.length + r.pmRaAxis.indexOf(0)];
const multi = results.multi;
const rowOf = (id: string, bands: string) => {
  const row = multi.rows.find((m) => m.id === id && m.bands.join("+") === bands);
  if (!row) throw new Error(`results.json multi has no row for ${id} ${bands}`);
  return row;
};
const siteRow = (id: string) => results.objects.find((o) => o.id === id)!;
const haveRows = haveBands("wise0855") && haveBands("epsindb");

describe.skipIf(!haveRows)("results.json multi: combined detectors on the real cubes (P-09)", () => {
  it.each(multi.rows.map((row) => [`${row.id} ${row.bands.join("+")}`, row] as const))("%s", (_, row) => {
    const { cubes, r } = search(row.id, row.bands);
    const cat = DEMO_OBJECTS.find((o) => o.id === row.id)!.catalogueMotion!;
    // Cube orientation (cube.json): row 0 = north, column 0 = east.
    const c = (cubes[0].w - 1) / 2;
    const pix = cubes[0].meta.pixscale_arcsec;
    expect({
      id: row.id,
      bands: row.bands,
      frames: cubes.reduce((a, q) => a + q.n, 0),
      snrBest: r2(r.gridBest.snr),
      snrZero: r2(zeroOf(r)),
      best: { pmRa: r2(r.best.pmRa), pmDec: r2(r.best.pmDec) },
      off: r2(Math.hypot(r.best.pmRa - cat.pmRa, r.best.pmDec - cat.pmDec)),
      peak: { east: r2((c - r.best.x) * pix), north: r2((c - r.best.y) * pix) },
    }).toEqual(row);
  }, 600000);

  it("has the rows the README table and the /method page read", () => {
    for (const [id, bands] of [
      ["wise0855", "D6"],
      ["wise0855", "D5+D6"],
      ["wise0855", "D1+D2+D3+D4+D5+D6"],
      ["epsindb", "D2"],
      ["epsindb", "D1+D2+D3+D4+D5+D6"],
    ]) rowOf(id, bands);
    // "alone" is the demo detector, the one the site searches.
    expect(siteRow("wise0855").band).toBe("D6");
    expect(siteRow("epsindb").band).toBe("D2");
  });

  it("WISE 0855: D5+D6 scores above D6 alone and is no further from the catalogue", () => {
    const one = rowOf("wise0855", "D6");
    const two = rowOf("wise0855", "D5+D6");
    expect(two.snrBest).toBeGreaterThan(one.snrBest);
    expect(two.off).toBeLessThan(one.off);
    expect(two.off).toBeLessThan(2); // P-02's requirement for WISE 0855
  });

  it("WISE 0855: all six score higher still, but on the neighbouring star, not on the target", () => {
    const two = rowOf("wise0855", "D5+D6");
    const short = rowOf("wise0855", "D1+D2+D3+D4");
    const six = rowOf("wise0855", "D1+D2+D3+D4+D5+D6");
    // A higher score is not a more correct motion.
    expect(six.snrBest).toBeGreaterThan(two.snrBest);
    expect(six.off).toBeGreaterThan(2);
    // Role A's record of the neighbour (Gaia DR3 5756956644387831296, issue #75).
    const spectrum = JSON.parse(readFileSync(path.join(cubesDir, "wise0855", "spectrum.json"), "utf8"));
    const nb = spectrum.neighbour as { east_arcsec: number; north_arcsec: number; sep_arcsec: number; bands: string[] };
    expect({ east: nb.east_arcsec, north: nb.north_arcsec, sep: nb.sep_arcsec, bands: nb.bands }).toEqual(multi.neighbour.at);
    const pix = 3;
    const fromNeighbour = (row: { peak: { east: number; north: number } }) =>
      Math.hypot(row.peak.east - nb.east_arcsec, row.peak.north - nb.north_arcsec);
    // The brightest pixel of the six-detector stack is the neighbour's (within one 3″ pixel), the
    // same pixel as with D1-D4 only, i.e. without the two detectors that see WISE 0855.
    expect(fromNeighbour(six)).toBeLessThan(pix);
    expect(six.peak).toEqual(short.peak);
    expect(fromNeighbour(two)).toBeGreaterThan(pix);
    // And its best motion is that of a star that does not move: under one grid step from zero.
    const step = search("wise0855", six.bands).r.step;
    expect(Math.hypot(six.best.pmRa, six.best.pmDec)).toBeLessThan(step);
    expect(Math.hypot(two.best.pmRa, two.best.pmDec)).toBeGreaterThan(2 * step);
    // Adding D5 and D6 to D1-D4 did not help the neighbour either: it is faint there.
    expect(six.snrBest).toBeLessThan(short.snrBest);
  });

  it("Epsilon Indi B: six detectors do worse than the site's one-detector search", () => {
    const six = rowOf("epsindb", "D1+D2+D3+D4+D5+D6");
    const site = siteRow("epsindb");
    expect(six.snrBest).toBeLessThan(site.snrBest);
    expect(six.off).toBeGreaterThan(site.off);
    // ...and below the best single detector run through the same stacking.
    expect(six.snrBest).toBeLessThan(rowOf("epsindb", "D5").snrBest);
  });
});

// Does the motion found with D5+D6 pass the shuffle test (significance.ts)? Each detector's frames
// keep their own set of dates, handed out at random within that detector. Opt-in (about 5 min):
//   P09_SHUFFLES=100 npx vitest run search/stackMulti.test.ts -t "shuffle"
const P09_SHUFFLES = Number(process.env.P09_SHUFFLES ?? 0);

function falseAlarmMulti(cubes: StackableCube[], n: number, seed = 1) {
  const real = scoreGridOn(multiSource(cubes));
  const moving = bestMoving(real);
  const rand = mulberry32(seed);
  const nullScores: number[] = [];
  for (let k = 0; k < n; k++) {
    const shuffled = cubes.map((cube) => withTimes(cube, permutation(cube.n, rand)));
    nullScores.push(bestMoving(scoreGridOn(multiSource(shuffled))).snr);
  }
  const nExceed = nullScores.filter((v) => v >= moving.snr).length;
  return { real, moving, nullScores, nExceed, p: (1 + nExceed) / (n + 1) };
}

describe.skipIf(!haveBands("wise0855"))("WISE 0855 D5+D6: shuffle test and blank sky (P-09)", () => {
  it("the recorded verdict follows the README's rule", () => {
    for (const s of multi.shuffles) {
      expect(s.p).toBe(Number(((1 + s.nExceed) / (s.n + 1)).toFixed(4)));
      const row = rowOf(s.id, s.bands.join("+"));
      const verdict = row.snrBest < DETECT_SNR ? "none" : s.p < MOTION_ALPHA && s.moving > s.zero ? "detected" : "consistent";
      expect(s.verdict).toBe(verdict);
    }
  });

  it.skipIf(P09_SHUFFLES === 0).each(multi.shuffles.map((s) => [s.bands.join("+"), s] as const))("shuffle test, %s", (_, s) => {
    const fa = falseAlarmMulti(s.bands.map((b) => loadStatic(s.id, b)), P09_SHUFFLES);
    const max = Math.max(...fa.nullScores);
    console.info(
      `NUMBERS P-09 shuffles ${s.id} [${s.bands.join("+")}] n ${P09_SHUFFLES}: best moving ${fa.moving.snr.toFixed(2)} at ` +
        `(${fa.moving.pmRa.toFixed(2)}, ${fa.moving.pmDec.toFixed(2)}), zero ${fa.real.zero.snr.toFixed(2)}, ` +
        `${fa.nExceed} reach it, max ${max.toFixed(2)}, p ${fa.p.toFixed(4)}`,
    );
    if (P09_SHUFFLES !== s.n) return;
    expect({ n: P09_SHUFFLES, nExceed: fa.nExceed, max: r2(max), p: Number(fa.p.toFixed(4)), moving: r2(fa.moving.snr), zero: r2(fa.real.zero.snr) }).toEqual({
      n: s.n,
      nExceed: s.nExceed,
      max: s.max,
      p: s.p,
      moving: s.moving,
      zero: s.zero,
    });
  }, 3600000);

  it("blank sky: the 8 regions 45″ from the target, D5+D6", () => {
    const cubes = [loadStatic("wise0855", "D5"), loadStatic("wise0855", "D6")];
    // The same 8 centres as numbers.test.ts ("interim control"), which stay below 5 in D6.
    const centres = [[15, 15], [45, 15], [15, 45], [45, 45], [30, 12], [30, 48], [12, 30], [48, 30]];
    const scores = centres.map(([cx, cy]) => velocityGridMulti(cubes, { centerX: cx, centerY: cy }).gridBest.snr);
    console.info(`NUMBERS P-09 wise0855 D5+D6 blank regions: ${scores.map((v) => v.toFixed(2)).join(", ")}`);
    expect(scores.map(r2)).toEqual(multi.blank.scores);
    // One of them is not blank in D5: it holds a catalogued star (role A's catalog.json).
    const above = scores.map((v, k) => (v >= DETECT_SNR ? k : -1)).filter((k) => k >= 0);
    expect(above).toEqual(multi.blank.above.map((a) => a.region));
    const catalog = JSON.parse(readFileSync(path.join(cubesDir, "wise0855", "catalog.json"), "utf8")) as {
      center: { ra: number; dec: number };
      sources: { id: string; ra: number; dec: number }[];
    };
    const cosDec = Math.cos((catalog.center.dec * Math.PI) / 180);
    for (const a of multi.blank.above) {
      const [cx, cy] = centres[a.region];
      const star = catalog.sources.find((src) => src.id === a.star)!;
      const x = 30 - ((star.ra - catalog.center.ra) * cosDec * 3600) / 3;
      const y = 30 - ((star.dec - catalog.center.dec) * 3600) / 3;
      expect(Math.hypot(x - cx, y - cy)).toBeLessThan(4); // inside the search radius
    }
  }, 120000);

  it.skipIf(!existsSync(path.join(cubesDir, "wise0855_control", "D6", "cube.json")))(
    "control field (D6 only: there is no D5 control cube) stays below 5 with this stacking",
    () => {
      const score = velocityGridMulti([loadStatic("wise0855_control", "D6")]).gridBest.snr;
      console.info(`NUMBERS P-09 control D6, weighted: ${score.toFixed(2)}`);
      expect(score).toBeLessThan(DETECT_SNR);
      expect(r2(score)).toBe(multi.control.snrBest);
    },
    60000,
  );
});

// Runs now, on the single-detector cubes: what the 1/noise^2 weighting alone does. stackMulti
// weights frames even within one detector (stack() does not), and P-06's "one detector" reference
// uses the same weighted stacking as "combined".
describe.each([
  ["wise0855", "D6"],
  ["barnard", "D1"],
  ["epsindb", "D2"],
] as const)("1/noise² weighting on one real detector: %s %s", (obj, band) => {
  it.skipIf(!existsSync(path.join(cubesDir, obj, band, "cube.json")))("raises the score; prints the best motion", () => {
    const cube = loadStatic(obj, band);
    const cat = DEMO_OBJECTS.find((o) => o.id === obj)!.catalogueMotion!;
    const plain = velocityGrid(cube, { normalise: "off" }); // stack()'s plain rule, without the A-13 brightness scale
    const weighted = velocityGridMulti([cube]);
    const off = (r: typeof plain) => Math.hypot(r.best.pmRa - cat.pmRa, r.best.pmDec - cat.pmDec).toFixed(2);
    const noise = cube.meta.frames.map((f) => f.noise ?? NaN);
    const lo = Math.min(...noise);
    const hi = Math.max(...noise);
    console.info(`NUMBERS P-06 frame noise ${obj} ${band}: ${lo.toFixed(4)}-${hi.toFixed(4)} (x${(hi / lo).toFixed(1)})`);
    console.info(
      `NUMBERS P-06 weighting ${obj} ${band}: unweighted gridBest ${plain.gridBest.snr.toFixed(2)} off ${off(plain)} ″/yr; ` +
        `weighted gridBest ${weighted.gridBest.snr.toFixed(2)} best (${weighted.best.pmRa.toFixed(2)}, ${weighted.best.pmDec.toFixed(2)}) off ${off(weighted)} ″/yr`,
    );
    expect(weighted.gridBest.snr).toBeGreaterThan(plain.gridBest.snr);
  }, 60000);
});
