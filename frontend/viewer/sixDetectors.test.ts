import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadCube, type Cube } from "./cube";
import { bandCubeUrl, offsetText } from "./SixDetectors";
import { centrePx, defaultStackMode, meanMjd, stackView } from "./stackView";

describe("bandCubeUrl", () => {
  it("swaps the detector folder of a static cube, and is null for live cubes", () => {
    expect(bandCubeUrl("/cubes/wise0855/D6/cube.json", "D2")).toBe("/cubes/wise0855/D2/cube.json");
    expect(bandCubeUrl("https://site.test/cubes/barnard/D1/cube.json", "D5")).toBe("https://site.test/cubes/barnard/D5/cube.json");
    expect(bandCubeUrl("https://api.test/api/cube?ra=1&dec=2&band=D1", "D2")).toBeNull();
    expect(bandCubeUrl("https://api.test/api/cubes/D6_x_p/cube.json", "D2")).toBeNull();
  });
});

describe("offsetText", () => {
  it("says on the target within one pixel, otherwise distance and direction (row 0 north, column 0 east)", () => {
    const at = { x: 30, y: 30 };
    expect(offsetText({ x: 31, y: 30 }, at, 3)).toBe("on the target");
    expect(offsetText({ x: 33, y: 29 }, at, 3)).toBe("9″ W of the target"); // 9″ west, 3″ north: mostly west
    expect(offsetText({ x: 30, y: 27 }, at, 3)).toBe("9″ N of the target");
    expect(offsetText({ x: 27, y: 33 }, at, 3)).toBe("13″ SE of the target");
  });
});

// ---------------------------------------------------------------------------------------------
// Real six-detector cubes (A-08). The same computation as the "All six detectors" tiles: each
// detector stacked with the catalogue motion around the cube centre, aligned on the mean time of
// the object's own detector. Catalogue motions as in lib/objects.ts (CatWISE2020, Gaia DR3).
// ---------------------------------------------------------------------------------------------
const cubesDir =
  process.env.OSU_CUBES_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data/cubes");
const json = (o: string, b: string) => path.join(cubesDir, o, b, "cube.json");
const fileFetch = (async (input: string | URL | Request) =>
  new Response(new Uint8Array(readFileSync(String(input))))) as typeof fetch;
const load = (o: string, b: string) => loadCube(json(o, b).replaceAll("\\", "/"), fileFetch);
const BANDS = ["D1", "D2", "D3", "D4", "D5", "D6"];

async function tiles(obj: string, ownBand: string, pm: [number, number]) {
  const own = await load(obj, ownBand);
  const refMjd = meanMjd(own);
  const at = centrePx(own);
  const out: Record<string, { peak: number; atSnr: number; offset: string }> = {};
  for (const b of BANDS) {
    const c: Cube = await load(obj, b);
    const v = stackView(c, pm[0], pm[1], defaultStackMode(c, at), refMjd, at);
    let atSnr = -Infinity;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) atSnr = Math.max(atSnr, v.result.snr[(at.y + dy) * c.w + at.x + dx]);
    out[b] = { peak: v.peak.snr, atSnr, offset: offsetText(v.peak, at, c.meta.pixscale_arcsec) };
  }
  return out;
}

describe.skipIf(!BANDS.every((b) => existsSync(json("wise0855", b))))("real cubes: WISE 0855, all six detectors", () => {
  it("D5 and D6 peak on the target with SNR > 5; in D1–D4 the peak is the neighbouring star ~8″ west", async () => {
    const t = await tiles("wise0855", "D6", [-7.97, 0.81]);
    for (const b of ["D5", "D6"]) {
      expect(t[b].peak, b).toBeGreaterThan(5);
      expect(t[b].offset, b).toBe("on the target");
    }
    // The neighbour is 8.2″ away (7.9″ W, 2.2″ N, spectrum.json); peaks sit on a 3″ grid.
    for (const b of ["D1", "D2", "D3", "D4"]) expect(t[b].offset, b).toMatch(/^([6-9]|10)″ N?W of the target$/);
  }, 60000);
});

describe.skipIf(!BANDS.every((b) => existsSync(json("epsindb", b))))("real cubes: eps Ind B, all six detectors", () => {
  it("is seen in every detector: SNR > 5 at the target in all six", async () => {
    const t = await tiles("epsindb", "D2", [3.967, -2.536]);
    for (const b of BANDS) expect(t[b].atSnr, b).toBeGreaterThan(5);
  }, 60000);
});

import { snrAt } from "./SixDetectors";
describe("snrAt", () => {
  it("is the highest SNR within one pixel of the point, NaN without data", () => {
    const s = new Float32Array([0, 1, 2, 3, 9, 4, NaN, 5, 6]); // 3 x 3
    expect(snrAt(s, 3, 3, { x: 1, y: 1 })).toBe(9);
    expect(snrAt(s, 3, 3, { x: 0, y: 0 })).toBe(9);
    expect(Number.isNaN(snrAt(new Float32Array([NaN]), 1, 1, { x: 0, y: 0 }))).toBe(true);
  });
});
