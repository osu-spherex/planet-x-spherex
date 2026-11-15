import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadCube } from "./cube";
import { velocityGrid, type GridResult } from "../search/grid";
import type { FalseAlarmResult } from "../search/significance";
import { falseAlarm } from "../search/significance";
import {
  CATALOGUE_TOLERANCE,
  SEARCH_SNR_MIN,
  SHUFFLES,
  catalogueCheck,
  cellToVector,
  expectedStacks,
  gridVerdict,
  renderHeatmap,
  shuffleSentence,
  summarizeShuffles,
  vectorToCell,
  viridis,
  zeroScore,
} from "./searchView";

/** A 3 x 3 grid result (axes -3, 0, 3) with chosen scores; test-only. */
function grid(score: number[], best: { pmRa: number; pmDec: number; snr: number }): GridResult {
  const s = { ...best, x: 30, y: 30 };
  return {
    pmRaAxis: [-3, 0, 3],
    pmDecAxis: [-3, 0, 3],
    score: new Float32Array(score),
    gridBest: s,
    best: s,
    fitted: true,
    bestStack: null as never,
    refMjd: 0,
    step: 3,
    baselineYears: 1,
    nStacks: 10,
    elapsedMs: 1,
  };
}

describe("gridVerdict (question 1: is anything there?)", () => {
  const scores = [1, 2, 1, 2, 4, 2, 1, 9, 1]; // zero vector = centre cell = 4
  it("says nothing was found below P's DETECT_SNR of 5", () => {
    expect(SEARCH_SNR_MIN).toBe(5);
    const v = gridVerdict(grid(scores, { pmRa: 0, pmDec: 3, snr: 4.9 }), { pmRa: 0, pmDec: 3 });
    expect(v.kind).toBe("none");
    expect(v.zeroSnr).toBe(4);
  });

  it("only ever says a source is there, never that it moves, even when it matches the catalogue", () => {
    const v = gridVerdict(grid(scores, { pmRa: 1, pmDec: 4.5, snr: 9 }), { pmRa: 0, pmDec: 3 });
    expect(v.kind).toBe("source");
    expect(v.catalogue).toEqual({ distance: Math.hypot(1, 1.5), passes: true });
    expect(gridVerdict(grid(scores, { pmRa: 3, pmDec: 3, snr: 9 })).catalogue).toBeNull();
  });

  it("catalogueCheck passes within 2″/yr only", () => {
    expect(CATALOGUE_TOLERANCE).toBe(2);
    expect(catalogueCheck({ pmRa: 0, pmDec: 0 }, { pmRa: 0, pmDec: 2 })!.passes).toBe(true);
    expect(catalogueCheck({ pmRa: 0, pmDec: 0 }, { pmRa: 0, pmDec: 2.01 })!.passes).toBe(false);
  });
});

/** A falseAlarm result with chosen numbers (test-only). */
function fa(o: { best: number; moving: number; zero: number; nulls: number[] }): FalseAlarmResult {
  const n = o.nulls.length;
  const nExceed = o.nulls.filter((v) => v >= o.moving).length;
  const cell = (snr: number) => ({ pmRa: 0, pmDec: 0, snr, x: 30, y: 30 });
  return {
    grid: { gridBest: cell(o.best) } as never,
    zero: cell(o.zero),
    moving: cell(o.moving),
    nullScores: o.nulls,
    n,
    nExceed,
    p: (1 + nExceed) / (n + 1),
    pMin: 1 / (n + 1),
    z: 0,
    seed: 1,
    elapsedMs: 1,
  };
}

describe("shuffle test (question 2: does it move?)", () => {
  const hundred = (v: number) => Array.from({ length: 100 }, () => v);

  it("uses 100 shuffles, the fewest that can reach p < 0.01", () => {
    expect(SHUFFLES).toBe(100);
    expect(1 / (SHUFFLES + 1)).toBeLessThan(0.01);
  });

  it("detected: no shuffle reaches the real score and moving beats not moving", () => {
    const s = summarizeShuffles(fa({ best: 21, moving: 21, zero: 18.7, nulls: hundred(20) }));
    expect(s.kind).toBe("detected");
    expect(s.bestShuffle).toBe(20);
    expect(shuffleSentence(s)).toBe("None of the 100 random time orders scored this high (p < 0.01).");
  });

  it("consistent: some shuffles score as high", () => {
    const nulls = hundred(20);
    nulls[0] = nulls[1] = nulls[2] = 22;
    const s = summarizeShuffles(fa({ best: 21, moving: 21, zero: 18, nulls }));
    expect(s.kind).toBe("consistent");
    expect(shuffleSentence(s)).toBe("3 of the 100 random time orders scored at least this high (p = 0.04).");
  });

  it("consistent: not moving scores at least as high, whatever p is", () => {
    expect(summarizeShuffles(fa({ best: 30, moving: 21, zero: 30, nulls: hundred(1) })).kind).toBe("consistent");
  });

  it("none: below the blank-sky level", () => {
    expect(summarizeShuffles(fa({ best: 4, moving: 4, zero: 2, nulls: hundred(1) })).kind).toBe("none");
  });

  it("with few shuffles p cannot drop below 1/(n+1)", () => {
    const s = summarizeShuffles(fa({ best: 21, moving: 21, zero: 18, nulls: Array.from({ length: 20 }, () => 1) }));
    expect(s.kind).toBe("consistent");
    expect(shuffleSentence(s)).toBe("None of the 20 random time orders scored this high (p = 0.05).");
  });
});

describe("zeroScore and cell mapping", () => {
  it("reads the (0, 0) cell and maps vectors to cells and back", () => {
    const r = grid([1, 2, 3, 4, 5, 6, 7, 8, 9], { pmRa: 0, pmDec: 0, snr: 5 });
    expect(zeroScore(r)).toBe(5);
    // pmRa -3 is column 0 (centre x 0.5); pmDec +3 is the top row (centre y 0.5).
    expect(vectorToCell(r, -3, 3)).toEqual({ x: 0.5, y: 0.5 });
    expect(vectorToCell(r, 0, 0)).toEqual({ x: 1.5, y: 1.5 });
    expect(cellToVector(r, 2.5, 2.5)).toEqual({ pmRa: 3, pmDec: -3 });
    const back = vectorToCell(r, ...(Object.values(cellToVector(r, 0.9, 2.2)) as [number, number]));
    expect(back.x).toBeCloseTo(0.9, 9);
    expect(back.y).toBeCloseTo(2.2, 9);
  });
});

describe("renderHeatmap", () => {
  it("puts the most positive pmDec row on top and spans the colour map", () => {
    // Row 0 of the score is pmDec = -3 (bottom); its value 0 is the lowest.
    const { rgba, lo, hi } = renderHeatmap(new Float32Array([0, 0, 0, 5, 5, 5, 10, 10, NaN]), 3, 3);
    expect([lo, hi]).toEqual([0, 10]);
    expect(Array.from(rgba.slice(0, 4))).toEqual([...viridis(1), 255]); // top-left: pmDec +3, score 10
    expect(Array.from(rgba.slice(8, 12))).toEqual([40, 40, 40, 255]); // NaN cell
    expect(Array.from(rgba.slice(24, 28))).toEqual([...viridis(0), 255]); // bottom-left: score 0
  });

  it("viridis ends at its published end colours", () => {
    expect(viridis(0)).toEqual([68, 1, 84]);
    expect(viridis(1)).toEqual([253, 231, 37]);
    expect(viridis(Number.NaN)).toEqual([68, 1, 84]);
  });
});

describe("expectedStacks", () => {
  it("matches the grid that velocityGrid builds (one refit included)", () => {
    // 1 Julian year baseline, 3″ pixels -> step 3″/yr, axis -15..15 -> 11 values.
    expect(expectedStacks([{ mjd: 0 }, { mjd: 365.25 }], 3)).toBe(11 * 11 + 1);
    expect(expectedStacks([{ mjd: 1 }], 3)).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Real cubes (data/cubes/, role A). Catalogue motions (arcsec/yr, pmRa includes cos Dec):
//   WISE 0855-0714, CatWISE2020: (-7.97, +0.81); Barnard's Star, Gaia DR3: (-0.80, +10.36)
//   (lib/objects.ts, experiments/check_objects.py).
// Blank regions: 15 px from the target, as in role P's control (search/grid.test.ts).
// ---------------------------------------------------------------------------------------------
const cubesDir =
  process.env.OSU_CUBES_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data/cubes");
const cubeJson = (obj: string, band: string) => path.join(cubesDir, obj, band, "cube.json");
const fileFetch = (async (input: string | URL | Request) =>
  new Response(new Uint8Array(readFileSync(String(input))))) as typeof fetch;
const load = (obj: string, band: string) => loadCube(cubeJson(obj, band).replaceAll("\\", "/"), fileFetch);

describe.skipIf(!existsSync(cubeJson("wise0855", "D6")))("real cubes: search verdicts", () => {
  it("WISE 0855 D6: a source, best motion within 2″/yr of CatWISE (search check passes)", async () => {
    const cube = await load("wise0855", "D6");
    const r = velocityGrid(cube);
    expect(expectedStacks(cube.meta.frames, cube.meta.pixscale_arcsec)).toBe(r.nStacks);
    const v = gridVerdict(r, { pmRa: -7.97, pmDec: 0.81 });
    expect(v.kind).toBe("source");
    expect(v.catalogue!.passes).toBe(true);
    expect(v.zeroSnr).toBeLessThan(v.bestSnr);
  }, 20000);

  it("WISE 0855 D6, blank region 15 px away: nothing found", async () => {
    const cube = await load("wise0855", "D6");
    expect(gridVerdict(velocityGrid(cube, { centerX: 15, centerY: 45 })).kind).toBe("none");
  }, 20000);

  it.skipIf(!existsSync(cubeJson("wise0855_control", "D6")))(
    "wise0855_control D6 (blank field, role A): nothing found, and the shuffle test agrees",
    async () => {
      const cube = await load("wise0855_control", "D6");
      expect(gridVerdict(velocityGrid(cube)).kind).toBe("none");
      // A few shuffles are enough here: "none" depends only on the real order's best score.
      expect(summarizeShuffles(falseAlarm(cube, 3)).kind).toBe("none");
    },
    30000,
  );

  it.skipIf(!existsSync(cubeJson("barnard", "D1")))("Barnard D1: a source, search check passes against Gaia", async () => {
    const cube = await load("barnard", "D1");
    const v = gridVerdict(velocityGrid(cube), { pmRa: -0.8, pmDec: 10.36 });
    expect(v.kind).toBe("source");
    expect(v.catalogue!.passes).toBe(true);
  }, 20000);

  it.skipIf(!existsSync(cubeJson("rwaur", "D1")))("RW Aur D1, blank corner: nothing found", async () => {
    const cube = await load("rwaur", "D1");
    expect(gridVerdict(velocityGrid(cube, { centerX: 48, centerY: 12 })).kind).toBe("none");
  }, 20000);

  // ~100 s: the full "How sure is this?" run. Opt in with B06_SLOW=1.
  it.skipIf(!process.env.B06_SLOW)("WISE 0855 D6, 100 shuffles: detected", async () => {
    const cube = await load("wise0855", "D6");
    const s = summarizeShuffles(falseAlarm(cube, SHUFFLES));
    expect(s.kind).toBe("detected");
    expect(shuffleSentence(s)).toContain("p < 0.01");
  }, 600000);
});

// ---------------------------------------------------------------------------------------------
// Which stacking path ran (A-13, issue #79).
// ---------------------------------------------------------------------------------------------
import { searchPathLine } from "./searchView";

describe("searchPathLine", () => {
  it("names the common-brightness path with the frames used, the plain path in a few words, older results not at all", () => {
    expect(searchPathLine({ normalised: true, framesUsed: 93 }, 93)).toMatch(/^Bright target: 93 of 93 images put on a common brightness before stacking/);
    expect(searchPathLine({ normalised: true, framesUsed: 41 }, 45)).toMatch(/^Bright target: 41 of 45 images/);
    expect(searchPathLine({ normalised: false, framesUsed: 43 }, 43)).toBe("Faint target: images stacked as they are.");
    expect(searchPathLine({}, 43)).toBe("");
  });
});

// Runs only with role P's A-13 search code (velocityGrid sets `normalised`), i.e. once PR #76 is in.
const hasA13 = (() => {
  const n = 3, w = 5, h = 5;
  const data = new Float32Array(n * w * h).map(() => Math.random());
  const r = velocityGrid({ n, w, h, data, meta: { pixscale_arcsec: 3, frames: [{ mjd: 0 }, { mjd: 200 }, { mjd: 400 }] } } as never, { pmMax: 3 });
  return (r as { normalised?: boolean }).normalised !== undefined;
})();

describe.runIf(hasA13 && existsSync(cubeJson("barnard", "D1")) && existsSync(cubeJson("wise0855", "D6")))("search path on the static cubes (A-13)", () => {
  it("Barnard D1: bright, all 60 images on a common brightness; WISE 0855 D6: faint, stacked as they are", async () => {
    const barnard = await load("barnard", "D1");
    const rb = velocityGrid(barnard) as ReturnType<typeof velocityGrid> & { normalised?: boolean; framesUsed?: number };
    expect(searchPathLine(rb, barnard.n)).toMatch(/^Bright target: 60 of 60 images/);
    const wise = await load("wise0855", "D6");
    const rw = velocityGrid(wise) as ReturnType<typeof velocityGrid> & { normalised?: boolean };
    expect(searchPathLine(rw, wise.n)).toBe("Faint target: images stacked as they are.");
  }, 60000);
});
