// The real-cube numbers quoted in docs/METHOD_SEARCH.md and search/README.md (role P, task P-05).
// Each test prints one "NUMBERS" line with the values the page quotes and checks the claim the
// page makes about them, so the page and the code cannot drift apart unnoticed.
//
//   npx vitest run search/numbers.test.ts --silent=false       # searches only, ~40 s (--silent=false prints the NUMBERS lines)
//   P05_SHUFFLES=100 npx vitest run search/numbers.test.ts --silent=false   # + shuffle tests on Barnard, eps Ind B, Teegarden (~25 min)
//
// The WISE 0855 shuffle numbers (n = 500) come from significance.test.ts (P03_SHUFFLES=500).
//
// results.json holds the same numbers for the /method page (task P-08). Each test below also checks
// that file against what it just computed, so the page cannot show a stale number.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEMO_OBJECTS } from "../lib/objects";
import { velocityGrid, type GridResult } from "./grid";
import results from "./results.json";
import { DETECT_SNR, MOTION_ALPHA, falseAlarm, motionVerdict, type FalseAlarmResult } from "./significance";
import { FRAME_DETECT_SNR, frameBrightness, frameShift, stack, type StackableCube } from "./stack";

const here = path.dirname(fileURLToPath(import.meta.url));
const cubesDir = path.resolve(here, "../../data/cubes");
const SHUFFLES = Number(process.env.P05_SHUFFLES ?? 0);

function loadStatic(rel: string): StackableCube {
  const dir = path.join(cubesDir, rel);
  const meta = JSON.parse(readFileSync(path.join(dir, "cube.json"), "utf8"));
  const buf = readFileSync(path.join(dir, meta.data_url));
  const data = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const [n, h, w] = meta.shape;
  return { n, h, w, data, meta };
}
const have = (rel: string) => existsSync(path.join(cubesDir, rel, "cube.json"));

/** Catalogue motion shown on the site for this object (lib/objects.ts). */
function catalogue(id: string): { pmRa: number; pmDec: number; source: string } {
  const m = DEMO_OBJECTS.find((o) => o.id === id)?.catalogueMotion;
  if (!m) throw new Error(`no catalogue motion for ${id}`);
  return m;
}

const f2 = (v: number) => v.toFixed(2);
const zeroOf = (r: GridResult) => r.score[r.pmDecAxis.indexOf(0) * r.pmRaAxis.length + r.pmRaAxis.indexOf(0)];

/** Detector recorded in cube.json (not part of StackableCube). */
const bandOf = (cube: StackableCube) => (cube.meta as { band?: string }).band;

/** Rounded as results.json stores it; `+ 0` turns -0 into 0. */
const r2 = (v: number) => Number(v.toFixed(2)) + 0;

function resultRow(id: string) {
  const row = results.objects.find((o) => o.id === id);
  if (!row) throw new Error(`results.json has no row for ${id}`);
  return row;
}

/** results.json (shown on /method) must hold what the search gives now. */
function expectResultsJson(id: string, cube: StackableCube, r: GridResult) {
  const row = resultRow(id);
  const cat = catalogue(id);
  expect({
    band: bandOf(cube),
    frames: cube.n,
    years: r2(r.baselineYears),
    step: r2(r.step),
    motions: r.score.length,
    best: { pmRa: r2(r.best.pmRa), pmDec: r2(r.best.pmDec) },
    off: r2(Math.hypot(r.best.pmRa - cat.pmRa, r.best.pmDec - cat.pmDec)),
    snrBest: r2(r.gridBest.snr),
    snrZero: r2(zeroOf(r)),
  }).toEqual({
    band: row.band,
    frames: row.frames,
    years: row.years,
    step: row.step,
    motions: row.motions,
    best: row.best,
    off: row.off,
    snrBest: row.snrBest,
    snrZero: row.snrZero,
  });
}

/** The shuffle numbers in results.json, checked when the run used the same number of shuffles. */
function expectShufflesJson(id: string, fa: FalseAlarmResult) {
  const s = resultRow(id).shuffles;
  if (fa.n !== s.n) return;
  expect({ n: fa.n, nExceed: fa.nExceed, max: r2(Math.max(...fa.nullScores)), p: Number(fa.p.toFixed(4)) }).toEqual(s);
  expect(motionVerdict(fa).kind).toBe(resultRow(id).verdict);
}

describe("results.json (the /method page)", () => {
  it("has one row per moving demo object, in its demo detector", () => {
    const moving = DEMO_OBJECTS.filter((o) => o.kind === "moves");
    expect(results.objects.map((o) => o.id).sort()).toEqual(moving.map((o) => o.id).sort());
    for (const row of results.objects) expect(row.band).toBe(moving.find((o) => o.id === row.id)!.band);
    expect(results.detectSnr).toBe(DETECT_SNR);
    expect(results.alpha).toBe(MOTION_ALPHA);
  });

  it("states p and the verdict by the README's rule", () => {
    for (const row of results.objects) {
      const s = row.shuffles;
      expect(s.p, row.id).toBe(Number(((1 + s.nExceed) / (s.n + 1)).toFixed(4)));
      const verdict =
        row.snrBest < DETECT_SNR ? "none" : s.p < MOTION_ALPHA && row.snrBest > row.snrZero ? "detected" : "consistent";
      expect(row.verdict, row.id).toBe(verdict);
    }
    expect(results.control.verdict).toBe(results.control.snrBest < DETECT_SNR ? "none" : "not none");
  });
});

function report(name: string, cube: StackableCube, r: GridResult, cat: { pmRa: number; pmDec: number }) {
  const off = Math.hypot(r.best.pmRa - cat.pmRa, r.best.pmDec - cat.pmDec);
  console.info(
    `NUMBERS ${name}: frames=${cube.n} baseline=${f2(r.baselineYears)} yr step=${f2(r.step)} vectors=${r.score.length} ` +
      `best=(${f2(r.best.pmRa)}, ${f2(r.best.pmDec)}) SNR ${f2(r.best.snr)} fitted=${r.fitted} ` +
      `gridBest=(${f2(r.gridBest.pmRa)}, ${f2(r.gridBest.pmDec)}) SNR ${f2(r.gridBest.snr)} zero SNR ${f2(zeroOf(r))} ` +
      `catalogue=(${cat.pmRa}, ${cat.pmDec}) off=${f2(off)} ″/yr ` +
      `common brightness=${r.normalised} frames used=${r.framesUsed} ${(r.elapsedMs / 1000).toFixed(1)} s`,
  );
  return off;
}

/** A-13: which cubes are searched on a common brightness, and what the search was before. */
function brightness(name: string, cube: StackableCube) {
  const c = (cube.w - 1) / 2;
  const b = frameBrightness(cube, c, c, 4);
  const snr = Array.from(b.snr).filter(Number.isFinite).sort((x, y) => x - y);
  const amp = Array.from(b.amp).filter((_, k) => b.snr[k] >= FRAME_DETECT_SNR);
  console.info(
    `NUMBERS A-13 ${name}: frames that see the target ${b.nMeasurable} of ${cube.n}; aperture SNR min ${snr[0].toFixed(1)} ` +
      `median ${snr[snr.length >> 1].toFixed(1)} max ${snr[snr.length - 1].toFixed(1)}` +
      (amp.length > 1 ? `; brightness max/min ${(Math.max(...amp) / Math.min(...amp)).toFixed(1)}x` : ""),
  );
  return b;
}

describe.skipIf(!have("wise0855/D6"))("WISE 0855 D6", () => {
  it("best motion within 2″/yr of CatWISE2020, well above the zero vector", () => {
    const cube = loadStatic("wise0855/D6");
    const r = velocityGrid(cube);
    expect(report("WISE 0855", cube, r, catalogue("wise0855"))).toBeLessThan(2);
    expect(r.best.snr).toBeGreaterThan(zeroOf(r));
    expectResultsJson("wise0855", cube, r);
    // The grid reaches pmMax in both directions, never beyond.
    for (const axis of [r.pmRaAxis, r.pmDecAxis]) {
      expect(Math.max(...axis)).toBeLessThanOrEqual(results.pmMax);
      expect(Math.max(...axis)).toBeGreaterThan(results.pmMax - r.step);
      expect(Math.min(...axis)).toBe(-Math.max(...axis));
    }
  }, 30000);

  it("interpolation lowers the stack noise only a few % on the real (oversampled) cube", () => {
    // significance.ts: shifted stacks are bilinear-interpolated, the zero-motion stack is not.
    const cube = loadStatic("wise0855/D6");
    const cat = catalogue("wise0855");
    const ref = cube.meta.frames.reduce((a, f) => a + f.mjd, 0) / cube.n;
    const s0 = stack(cube, 0, 0, ref, "clipped").sigma;
    const s1 = stack(cube, cat.pmRa, cat.pmDec, ref, "clipped").sigma;
    console.info(`NUMBERS WISE 0855 stack noise: zero motion ${s0.toFixed(5)}, catalogue motion ${s1.toFixed(5)}, ratio ${(s1 / s0).toFixed(3)}`);
    expect(s1 / s0).toBeGreaterThan(0.9);
    expect(s1 / s0).toBeLessThan(1);
    expect({ zeroMotion: Number(s0.toFixed(5)), catalogueMotion: Number(s1.toFixed(5)) }).toEqual(results.interpolation);
  });

  it("interim control: 8 regions 45″ from the target stay below 5", () => {
    const cube = loadStatic("wise0855/D6");
    const maxima = [[15, 15], [45, 15], [15, 45], [45, 45], [30, 12], [30, 48], [12, 30], [48, 30]].map(
      ([cx, cy]) => velocityGrid(cube, { centerX: cx, centerY: cy }).gridBest.snr,
    );
    console.info(`NUMBERS WISE 0855 blank regions: ${maxima.map(f2).join(", ")} range ${f2(Math.min(...maxima))}-${f2(Math.max(...maxima))}`);
    expect(Math.max(...maxima)).toBeLessThan(DETECT_SNR);
    expect({ regions: maxima.length, min: r2(Math.min(...maxima)), max: r2(Math.max(...maxima)) }).toEqual(results.blank.nearWise);
  }, 60000);
});

describe.skipIf(!have("wise0855_control/D6"))("control cube near WISE 0855 (role A, issue #21)", () => {
  it("centre and 9 centres in the clean central ~30″ stay below 5", () => {
    const cube = loadStatic("wise0855_control/D6");
    const centre = velocityGrid(cube).gridBest.snr;
    // 3 x 3 centres 6 px (18″) apart; the bright source at the east edge (role A's note) stays out.
    const maxima: number[] = [];
    for (const dy of [-6, 0, 6]) for (const dx of [-6, 0, 6]) maxima.push(velocityGrid(cube, { centerX: 30 + dx, centerY: 30 + dy }).gridBest.snr);
    console.info(`NUMBERS control: centre ${f2(centre)}; 3x3 ${maxima.map(f2).join(", ")} range ${f2(Math.min(...maxima))}-${f2(Math.max(...maxima))}`);
    expect(centre).toBeLessThan(DETECT_SNR);
    expect(Math.max(...maxima)).toBeLessThan(DETECT_SNR);
    expect({ id: "wise0855_control", band: bandOf(cube), frames: cube.n, snrBest: r2(centre), verdict: "none" }).toEqual(results.control);
    expect({ regions: maxima.length, min: r2(Math.min(...maxima)), max: r2(Math.max(...maxima)) }).toEqual(results.blank.control);
  }, 60000);
});

describe.skipIf(!have("barnard/D1"))("Barnard's Star D1", () => {
  it("best motion within 2″/yr of Gaia DR3", () => {
    const cube = loadStatic("barnard/D1");
    const r = velocityGrid(cube);
    expect(report("Barnard", cube, r, catalogue("barnard"))).toBeLessThan(2);
    expectResultsJson("barnard", cube, r);
  }, 30000);

  it.skipIf(SHUFFLES < 1)(`shuffle test, n = ${SHUFFLES}`, () => {
    const fa = falseAlarm(loadStatic("barnard/D1"), SHUFFLES);
    console.info(
      `NUMBERS Barnard shuffles: n=${fa.n} moving=${f2(fa.moving.snr)} zero=${f2(fa.zero.snr)} max shuffle=${f2(Math.max(...fa.nullScores))} ` +
        `nExceed=${fa.nExceed} p=${fa.p.toFixed(4)} verdict=${motionVerdict(fa).kind} ${(fa.elapsedMs / 1000).toFixed(0)} s`,
    );
    expect(fa.nExceed).toBe(0);
    expectShufflesJson("barnard", fa);
  }, 60000 + SHUFFLES * 5000);
});

describe.skipIf(!have("epsindb/D2"))("Epsilon Indi B D2", () => {
  it("best motion within 2″/yr of eps Ind A (Gaia DR3, common proper motion)", () => {
    const cube = loadStatic("epsindb/D2");
    const r = velocityGrid(cube);
    expect(report("eps Ind B", cube, r, catalogue("epsindb"))).toBeLessThan(2);
    expectResultsJson("epsindb", cube, r);
  }, 60000);

  it.skipIf(SHUFFLES < 1)(`shuffle test, n = ${SHUFFLES}`, () => {
    const fa = falseAlarm(loadStatic("epsindb/D2"), SHUFFLES);
    console.info(
      `NUMBERS eps Ind B shuffles: n=${fa.n} moving=${f2(fa.moving.snr)} zero=${f2(fa.zero.snr)} max shuffle=${f2(Math.max(...fa.nullScores))} ` +
        `nExceed=${fa.nExceed} p=${fa.p.toFixed(4)} verdict=${motionVerdict(fa).kind} ${(fa.elapsedMs / 1000).toFixed(0)} s`,
    );
    // Before A-13 (11/14, n = 100): 6 shuffles reached the real order (p = 0.07), "consistent",
    // because the frame-noise clip dropped real starlight (the next test). With the frames on a
    // common brightness (A-13) no shuffle reaches it. "detected" needs n >= 100 (p < 1%).
    const v = motionVerdict(fa);
    expect(fa.grid.normalised).toBe(true);
    expect(fa.nExceed).toBe(0);
    expect(v.kind).toBe(SHUFFLES >= 100 ? "detected" : "consistent");
    expect(fa.moving.snr).toBeGreaterThan(fa.zero.snr);
    expectShufflesJson("epsindb", fa);
  }, 60000 + SHUFFLES * 12000);

  it.skipIf(SHUFFLES < 1)(`before A-13 (normalise "off"): shuffle test, n = ${SHUFFLES}`, () => {
    const fa = falseAlarm(loadStatic("epsindb/D2"), SHUFFLES, { normalise: "off" });
    console.info(
      `NUMBERS eps Ind B shuffles, frames as they are: n=${fa.n} moving=${f2(fa.moving.snr)} zero=${f2(fa.zero.snr)} ` +
        `max shuffle=${f2(Math.max(...fa.nullScores))} nExceed=${fa.nExceed} p=${fa.p.toFixed(4)} verdict=${motionVerdict(fa).kind}`,
    );
    expect(motionVerdict(fa).kind).toBe("consistent");
    const before = results.epsIndB.before;
    if (fa.n === before.shuffles.n) {
      expect({ n: fa.n, nExceed: fa.nExceed, max: r2(Math.max(...fa.nullScores)), p: Number(fa.p.toFixed(4)) }).toEqual(before.shuffles);
      expect(motionVerdict(fa).kind).toBe(before.verdict);
    }
  }, 60000 + SHUFFLES * 12000);

  it("before A-13: the frame-noise clip keeps only a few samples on the brightest stack pixel", () => {
    // Stack at the catalogue motion; the brightest pixel is the one with the most light in the
    // plain mean (within the search radius). The clipped stack's count there is what survives.
    const cube = loadStatic("epsindb/D2");
    const cat = catalogue("epsindb");
    const ref = cube.meta.frames.reduce((a, f) => a + f.mjd, 0) / cube.n;
    const mean = stack(cube, cat.pmRa, cat.pmDec, ref, "mean");
    const clipped = stack(cube, cat.pmRa, cat.pmDec, ref, "clipped");
    const c = (cube.w - 1) / 2;
    let p = -1;
    for (let y = 0; y < cube.h; y++) for (let x = 0; x < cube.w; x++) {
      if ((x - c) ** 2 + (y - c) ** 2 > 16) continue;
      const q = y * cube.w + x;
      if (p < 0 || mean.image[q] > mean.image[p]) p = q;
    }
    console.info(`NUMBERS eps Ind B, frames as they are: the clip keeps ${clipped.count[p]} of ${mean.count[p]} samples on the brightest pixel`);
    expect({ kept: clipped.count[p], of: mean.count[p] }).toEqual(results.epsIndB.clipKeeps);
  });

  it.skipIf(SHUFFLES < 1)("why: the clipped mean drops real starlight on this bright target (20 shuffles per mode)", () => {
    const cube = loadStatic("epsindb/D2");
    // How much the target's brightness changes between images (each sees it at its own wavelength):
    // brightest pixel / frame noise within 2 px of the catalogue track.
    const cat = catalogue("epsindb");
    const ref = cube.meta.frames.reduce((a, f) => a + f.mjd, 0) / cube.n;
    const peaks: number[] = [];
    for (let k = 0; k < cube.n; k++) {
      const f = cube.meta.frames[k];
      const s = frameShift(cat.pmRa, cat.pmDec, f.mjd, ref, cube.meta.pixscale_arcsec);
      const cx = Math.round((cube.w - 1) / 2 + s.dx);
      const cy = Math.round((cube.h - 1) / 2 + s.dy);
      let best = -Infinity;
      for (let y = cy - 2; y <= cy + 2; y++) for (let x = cx - 2; x <= cx + 2; x++) {
        const v = cube.data[k * cube.h * cube.w + y * cube.w + x];
        if (Number.isFinite(v)) best = Math.max(best, v);
      }
      peaks.push(best / (f.noise ?? 1));
    }
    peaks.sort((a, b) => a - b);
    console.info(`NUMBERS eps Ind B per-image peak/noise: min ${peaks[0].toFixed(0)} median ${peaks[peaks.length >> 1].toFixed(0)} max ${peaks[peaks.length - 1].toFixed(0)}`);
    // normalise "off": these four are the stacking rules as they were before A-13, on the frames
    // as they are. The default search now puts the frames on a common brightness first.
    const modes = [
      ["clipped", { mode: "clipped", normalise: "off" }],
      ["mean", { mode: "mean", normalise: "off" }],
      ["median", { mode: "median", normalise: "off" }],
      ["clipped, pixel scale (P-07)", { mode: "clipped", clipScale: "pixel", normalise: "off" }],
    ] as const;
    const runs = modes.map(([label, opts]) => {
      const fa = falseAlarm(cube, 20, opts);
      console.info(
        `NUMBERS eps Ind B shuffles, mode ${label}: real=${f2(fa.moving.snr)} zero=${f2(fa.zero.snr)} ` +
          `max shuffle=${f2(Math.max(...fa.nullScores))} nExceed=${fa.nExceed}/20 z=${f2(fa.z)}`,
      );
      return fa;
    });
    expect(runs[1].nExceed).toBe(0); // plain mean: the real order wins clearly
    expect(runs[1].z).toBeGreaterThan(runs[0].z);
    expect(runs[3].nExceed).toBe(0); // the P-07 scale fixes eps Ind B ...
    const e = results.epsIndB;
    expect({ min: Math.round(peaks[0]), max: Math.round(peaks[peaks.length - 1]) }).toEqual(e.peakOverNoise);
    expect({ n: runs[1].n, nExceed: runs[1].nExceed, z: r2(runs[1].z) }).toEqual(e.plainMean);
    expect({ n: runs[0].n, nExceed: runs[0].nExceed, z: r2(runs[0].z) }).toEqual(e.defaultClipped);
  }, 900000);
});

// ---------- A-13: frames on a common brightness when single frames see the target ----------

describe.skipIf(!have("wise0855/D6") || !have("barnard/D1") || !have("epsindb/D2"))("A-13: common brightness", () => {
  it("is used for Barnard and eps Ind B, not for WISE 0855, the control field or blank regions", () => {
    const wise = loadStatic("wise0855/D6");
    const fs = results.framesSeen;
    const wiseSeen = brightness("WISE 0855", wise).nMeasurable;
    expect(wiseSeen * 2).toBeLessThan(wise.n);
    expect({ seen: wiseSeen, of: wise.n }).toEqual(fs.wise0855);
    expect(velocityGrid(wise).normalised).toBe(false);
    for (const [id, rel] of [["barnard", "barnard/D1"], ["epsindb", "epsindb/D2"]] as const) {
      const cube = loadStatic(rel);
      const seen = brightness(rel, cube).nMeasurable;
      expect(seen, rel).toBe(cube.n);
      expect({ seen, of: cube.n }).toEqual(fs[id]);
    }
    const regions = [[15, 15], [45, 15], [15, 45], [45, 45], [30, 12], [30, 48], [12, 30], [48, 30]];
    const seen = regions.map(([cx, cy]) => frameBrightness(wise, cx, cy, 4).nMeasurable);
    console.info(`NUMBERS A-13 WISE 0855 blank regions: frames that see something ${seen.join(", ")} of ${wise.n}`);
    expect(Math.max(...seen) * 2).toBeLessThan(wise.n);
    expect({ seen: Math.max(...seen), of: wise.n }).toEqual(fs.blankNearWiseMax);
    if (have("wise0855_control/D6")) {
      const control = loadStatic("wise0855_control/D6");
      const controlSeen = brightness("control", control).nMeasurable;
      expect(controlSeen * 2).toBeLessThan(control.n);
      expect({ seen: controlSeen, of: control.n }).toEqual(fs.control);
    }
  }, 60000);

  it("WISE 0855 is searched exactly as before (same scores with normalise off)", () => {
    const cube = loadStatic("wise0855/D6");
    const a = velocityGrid(cube);
    const b = velocityGrid(cube, { normalise: "off" });
    expect(Array.from(a.score)).toEqual(Array.from(b.score));
    expect(a.best).toEqual(b.best);
  }, 60000);

  it("before and after on the two bright movers; the search takes less than twice as long", () => {
    for (const [id, rel] of [["barnard", "barnard/D1"], ["epsindb", "epsindb/D2"]] as const) {
      const cube = loadStatic(rel);
      const cat = catalogue(id);
      const before = velocityGrid(cube, { normalise: "off" });
      const after = velocityGrid(cube);
      const off = (r: GridResult) => Math.hypot(r.best.pmRa - cat.pmRa, r.best.pmDec - cat.pmDec);
      console.info(
        `NUMBERS A-13 ${id}: before best=(${f2(before.best.pmRa)}, ${f2(before.best.pmDec)}) off=${f2(off(before))} gridBest ${f2(before.gridBest.snr)} ` +
          `zero ${f2(zeroOf(before))} ${(before.elapsedMs / 1000).toFixed(1)} s; after best=(${f2(after.best.pmRa)}, ${f2(after.best.pmDec)}) ` +
          `off=${f2(off(after))} gridBest ${f2(after.gridBest.snr)} zero ${f2(zeroOf(after))} ${(after.elapsedMs / 1000).toFixed(1)} s`,
      );
      expect(after.normalised).toBe(true);
      expect(off(after)).toBeLessThan(2);
      expect(after.elapsedMs).toBeLessThan(2 * before.elapsedMs);
      const was = id === "epsindb" ? results.epsIndB.before : results.barnard.before;
      expect({
        best: { pmRa: r2(before.best.pmRa), pmDec: r2(before.best.pmDec) },
        off: r2(off(before)),
        snrBest: r2(before.gridBest.snr),
        snrZero: r2(zeroOf(before)),
      }).toEqual({ best: was.best, off: was.off, snrBest: was.snrBest, snrZero: was.snrZero });
    }
  }, 120000);
});

// A sixth object that was not looked at while the rule was designed: Teegarden's Star, D1, 55
// frames in 3 visits (cube built 11/14 with data.fetch_field + data.cube). Motion from Gaia DR3
// source 35227046884571776: pmra 3429.08, pmdec -3805.54 mas/yr (data/catalog.py sources_near).
describe.skipIf(!have("teegarden/D1"))("A-13 check on an object not used for the design: Teegarden's Star D1", () => {
  const check = results.check;
  const cat = check.catalogue;

  it("results.json records it with the Gaia DR3 motion", () => {
    expect(check.id).toBe("teegarden");
    expect(cat).toEqual({ pmRa: 3.429, pmDec: -3.806 });
    expect(check.verdict).toBe(check.shuffles.p < MOTION_ALPHA && check.snrBest > check.snrZero ? "detected" : "consistent");
  });

  it("best motion within 2″/yr of Gaia DR3, on a common brightness", () => {
    const cube = loadStatic("teegarden/D1");
    brightness("Teegarden", cube);
    const before = velocityGrid(cube, { normalise: "off" });
    console.info(
      `NUMBERS Teegarden before A-13: best=(${f2(before.best.pmRa)}, ${f2(before.best.pmDec)}) ` +
        `off=${f2(Math.hypot(before.best.pmRa - cat.pmRa, before.best.pmDec - cat.pmDec))} gridBest ${f2(before.gridBest.snr)}`,
    );
    const r = velocityGrid(cube);
    expect(r.normalised).toBe(true);
    const off = report("Teegarden", cube, r, cat);
    expect(off).toBeLessThan(2);
    expect({
      band: bandOf(cube),
      frames: cube.n,
      years: r2(r.baselineYears),
      step: r2(r.step),
      motions: r.score.length,
      best: { pmRa: r2(r.best.pmRa), pmDec: r2(r.best.pmDec) },
      off: r2(off),
      snrBest: r2(r.gridBest.snr),
      snrZero: r2(zeroOf(r)),
    }).toEqual({
      band: check.band,
      frames: check.frames,
      years: check.years,
      step: check.step,
      motions: check.motions,
      best: check.best,
      off: check.off,
      snrBest: check.snrBest,
      snrZero: check.snrZero,
    });
  }, 60000);

  it.skipIf(SHUFFLES < 1)(`shuffle test, n = ${SHUFFLES}`, () => {
    const cube = loadStatic("teegarden/D1");
    for (const [label, opts] of [["common brightness", {}], ["frames as they are", { normalise: "off" }]] as const) {
      const fa = falseAlarm(cube, SHUFFLES, opts);
      console.info(
        `NUMBERS Teegarden shuffles, ${label}: n=${fa.n} moving=${f2(fa.moving.snr)} zero=${f2(fa.zero.snr)} ` +
          `max shuffle=${f2(Math.max(...fa.nullScores))} nExceed=${fa.nExceed} p=${fa.p.toFixed(4)} verdict=${motionVerdict(fa).kind}`,
      );
      if (label !== "common brightness") continue;
      expect(fa.nExceed).toBe(0);
      if (fa.n === check.shuffles.n) {
        expect({ n: fa.n, nExceed: fa.nExceed, max: r2(Math.max(...fa.nullScores)), p: Number(fa.p.toFixed(4)) }).toEqual(check.shuffles);
        expect(motionVerdict(fa).kind).toBe(check.verdict);
      }
    }
  }, 120000 + SHUFFLES * 12000);
});

// ---------- P-07: clipping against each pixel's own spread (tried, not the default) ----------

describe.skipIf(!have("wise0855/D6") || !have("barnard/D1") || !have("epsindb/D2"))(
  "P-07 experiment: clipScale 'pixel' fixes eps Ind B but moves WISE 0855 and Barnard off",
  () => {
    it("best motion vs catalogue with the pixel scale", () => {
      const off: Record<string, number> = {};
      for (const [id, rel] of [["wise0855", "wise0855/D6"], ["barnard", "barnard/D1"], ["epsindb", "epsindb/D2"]] as const) {
        const cube = loadStatic(rel);
        const r = velocityGrid(cube, { clipScale: "pixel", normalise: "off" }); // P-07 as it was run
        const cat = catalogue(id);
        off[id] = Math.hypot(r.best.pmRa - cat.pmRa, r.best.pmDec - cat.pmDec);
        console.info(
          `NUMBERS P-07 pixel scale, ${id}: best=(${f2(r.best.pmRa)}, ${f2(r.best.pmDec)}) off=${f2(off[id])} ″/yr ` +
            `gridBest SNR ${f2(r.gridBest.snr)}`,
        );
      }
      // Why it is not the default: P-02 needs WISE 0855 within 2″/yr of the catalogue.
      expect(off.wise0855).toBeGreaterThan(2);
      expect(off.barnard).toBeGreaterThan(2);
      expect(off.epsindb).toBeLessThan(1);
      expect({ wise0855: r2(off.wise0855), barnard: r2(off.barnard), epsindb: r2(off.epsindb) }).toEqual(results.epsIndB.pixelClipOff);
    }, 60000);

    it("and the median, the other rule-free option, moves WISE 0855 off too", () => {
      const off: Record<string, number> = {};
      for (const [id, rel] of [["wise0855", "wise0855/D6"], ["barnard", "barnard/D1"], ["epsindb", "epsindb/D2"]] as const) {
        const r = velocityGrid(loadStatic(rel), { mode: "median", normalise: "off" });
        const cat = catalogue(id);
        off[id] = Math.hypot(r.best.pmRa - cat.pmRa, r.best.pmDec - cat.pmDec);
        console.info(`NUMBERS P-07 median, ${id}: best=(${f2(r.best.pmRa)}, ${f2(r.best.pmDec)}) off=${f2(off[id])} ″/yr`);
      }
      expect(off.wise0855).toBeGreaterThan(2);
    }, 60000);
  },
);
