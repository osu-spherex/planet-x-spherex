import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CubeNotReadyError,
  NAN_RGB,
  getFrame,
  loadCube,
  mjdToDate,
  mjdToIsoDate,
  percentile,
  renderFrame,
  resolveDataUrl,
  stretchLimits,
  stretchValue,
  type CubeMeta,
} from "./cube";

// ---------------------------------------------------------------------------------------------
// Fixture: a tiny hand-written cube (2 frames, 2 rows, 3 columns). Test-only, never shown in the
// demo. Values are chosen so every expected number below can be checked by hand.
// ---------------------------------------------------------------------------------------------
const FIXTURE_VALUES = [
  // frame 0: row 0 (north), row 1
  0, 1, 2,
  3, Number.NaN, 5,
  // frame 1
  10, 11, 12,
  13, 14, 15,
];

function fixtureMeta(overrides: Partial<CubeMeta> = {}): CubeMeta {
  return {
    center: { ra: 269.4462864, dec: 4.7680655 },
    pixscale_arcsec: 3.0,
    shape: [2, 2, 3],
    frames: [
      { id: "f0", band: "D1", mjd: 60914.21253, lam_um: 0.74642, noise: 0.1, nan_frac: 1 / 6 },
      { id: "f1", band: "D1", mjd: 61285.257036, lam_um: 0.75503, noise: 0.1, nan_frac: 0 },
    ],
    data_url: "cube.f32",
    ...overrides,
  };
}

/** A fetch stand-in that serves a map of URL -> body and records what was asked for. */
function fakeFetch(routes: Record<string, { status?: number; json?: unknown; bytes?: ArrayBuffer }>) {
  const calls: string[] = [];
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    const route = routes[url];
    if (!route) return new Response("not found", { status: 404, statusText: "Not Found" });
    if (route.bytes) return new Response(route.bytes, { status: route.status ?? 200 });
    return new Response(JSON.stringify(route.json), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { impl: impl as typeof fetch, calls };
}

const fixtureBytes = () => new Float32Array(FIXTURE_VALUES).buffer;

describe("loadCube", () => {
  it("loads cube.json and the Float32 data next to it", async () => {
    const { impl, calls } = fakeFetch({
      "/cubes/barnard/D1/cube.json": { json: fixtureMeta() },
      "/cubes/barnard/D1/cube.f32": { bytes: fixtureBytes() },
    });
    const cube = await loadCube("/cubes/barnard/D1/cube.json", impl);

    expect(calls).toEqual(["/cubes/barnard/D1/cube.json", "/cubes/barnard/D1/cube.f32"]);
    expect([cube.n, cube.h, cube.w]).toEqual([2, 2, 3]);
    expect(cube.data).toBeInstanceOf(Float32Array);
    expect(cube.data.length).toBe(12);
    expect(cube.data[0]).toBe(0);
    expect(cube.data[5]).toBe(5);
    expect(Number.isNaN(cube.data[4])).toBe(true);
    expect(cube.data[11]).toBe(15);
    expect(cube.meta.frames[1].lam_um).toBe(0.75503);
  });

  it("resolves an absolute data_url against the origin of the JSON (backend /api/cube style)", async () => {
    const jsonUrl = "https://api.example.org/api/cube?ra=269.45&dec=4.77&band=D1";
    const { impl, calls } = fakeFetch({
      [jsonUrl]: { json: { status: "done", ...fixtureMeta({ data_url: "/api/cubes/abc/cube.f32" }) } },
      "https://api.example.org/api/cubes/abc/cube.f32": { bytes: fixtureBytes() },
    });
    const cube = await loadCube(jsonUrl, impl);
    expect(calls[1]).toBe("https://api.example.org/api/cubes/abc/cube.f32");
    expect(cube.n).toBe(2);
  });

  it("throws CubeNotReadyError while the backend is still building the cube", async () => {
    const { impl } = fakeFetch({
      "/api/cube?ra=1&dec=2&band=D1": { status: 202, json: { status: "downloading", progress: 0.4 } },
    });
    const err = await loadCube("/api/cube?ra=1&dec=2&band=D1", impl).catch((e) => e);
    expect(err).toBeInstanceOf(CubeNotReadyError);
    expect(err.status).toBe("downloading");
    expect(err.progress).toBe(0.4);
  });

  it("rejects an HTTP error with the status in the message", async () => {
    const { impl } = fakeFetch({});
    await expect(loadCube("/cubes/nope/D1/cube.json", impl)).rejects.toThrow(/404/);
  });

  it("rejects data whose size does not match shape", async () => {
    const { impl } = fakeFetch({
      "/c/cube.json": { json: fixtureMeta() },
      "/c/cube.f32": { bytes: new Float32Array(11).buffer },
    });
    await expect(loadCube("/c/cube.json", impl)).rejects.toThrow(/48 bytes.*44|44.*48/);
  });

  it("rejects metadata whose frame list does not match shape", async () => {
    const meta = fixtureMeta();
    meta.frames = meta.frames.slice(0, 1);
    const { impl } = fakeFetch({ "/c/cube.json": { json: meta }, "/c/cube.f32": { bytes: fixtureBytes() } });
    await expect(loadCube("/c/cube.json", impl)).rejects.toThrow(/frames/);
  });

  it("rejects metadata without a usable shape", async () => {
    const { impl } = fakeFetch({ "/c/cube.json": { json: { ...fixtureMeta(), shape: [2, 0, 3] } } });
    await expect(loadCube("/c/cube.json", impl)).rejects.toThrow(/shape/);
  });
});

describe("resolveDataUrl", () => {
  it("keeps site-relative URLs site-relative", () => {
    expect(resolveDataUrl("cube.f32", "/cubes/barnard/D1/cube.json")).toBe("/cubes/barnard/D1/cube.f32");
    expect(resolveDataUrl("/api/cubes/k/cube.f32", "/api/cube?ra=1&dec=2")).toBe("/api/cubes/k/cube.f32");
  });
  it("follows an absolute JSON URL", () => {
    expect(resolveDataUrl("cube.f32", "https://x.org/cubes/rdra/D1/cube.json")).toBe(
      "https://x.org/cubes/rdra/D1/cube.f32",
    );
  });
});

describe("getFrame", () => {
  it("returns frame i as a view in row-major order (row 0 first)", async () => {
    const { impl } = fakeFetch({ "/c/cube.json": { json: fixtureMeta() }, "/c/cube.f32": { bytes: fixtureBytes() } });
    const cube = await loadCube("/c/cube.json", impl);
    expect(Array.from(getFrame(cube, 1))).toEqual([10, 11, 12, 13, 14, 15]);
    // frame 0, row y = 1, column x = 2  ->  index y * W + x = 5
    expect(getFrame(cube, 0)[1 * cube.w + 2]).toBe(5);
    expect(() => getFrame(cube, 2)).toThrow(RangeError);
    expect(() => getFrame(cube, -1)).toThrow(RangeError);
  });
});

describe("percentile", () => {
  it("matches numpy's linear interpolation on known inputs", () => {
    // np.percentile([1,2,3,4,5], [0, 25, 50, 100]) -> 1, 2, 3, 5
    const v = new Float32Array([5, 1, 4, 2, 3]);
    expect(percentile(v, 0)).toBe(1);
    expect(percentile(v, 25)).toBe(2);
    expect(percentile(v, 50)).toBe(3);
    expect(percentile(v, 100)).toBe(5);
    // np.percentile([10, 20], 25) -> 12.5
    expect(percentile(new Float32Array([20, 10]), 25)).toBeCloseTo(12.5, 6);
    // np.percentile(arange(101), 99.5) -> 99.5
    expect(percentile(Float32Array.from({ length: 101 }, (_, i) => i), 99.5)).toBeCloseTo(99.5, 6);
  });

  it("ignores NaN and infinite pixels", () => {
    const v = new Float32Array([Number.NaN, 1, 2, 3, Number.POSITIVE_INFINITY, Number.NaN]);
    expect(percentile(v, 50)).toBe(2);
  });

  it("returns NaN when no pixel is valid", () => {
    expect(Number.isNaN(percentile(new Float32Array([Number.NaN, Number.NaN]), 50))).toBe(true);
    expect(Number.isNaN(percentile(new Float32Array(0), 50))).toBe(true);
  });
});

describe("stretchLimits", () => {
  it("defaults to the 1st and 99.5th percentile of valid pixels", () => {
    const v = Float32Array.from({ length: 1001 }, (_, i) => i); // 0..1000
    const { lo, hi } = stretchLimits(v);
    expect(lo).toBeCloseTo(10, 4); // 1 % of 1000
    expect(hi).toBeCloseTo(995, 4); // 99.5 % of 1000
  });
});

describe("stretchValue", () => {
  it("maps lo to 0 and hi to 1 and clips outside, in both modes", () => {
    for (const mode of ["linear", "asinh"] as const) {
      expect(stretchValue(2, 2, 10, mode)).toBe(0);
      expect(stretchValue(10, 2, 10, mode)).toBeCloseTo(1, 12);
      expect(stretchValue(-50, 2, 10, mode)).toBe(0);
      expect(stretchValue(999, 2, 10, mode)).toBeCloseTo(1, 12);
    }
  });

  it("is linear in linear mode", () => {
    expect(stretchValue(4, 2, 10, "linear")).toBeCloseTo(0.25, 12);
    expect(stretchValue(6, 2, 10, "linear")).toBeCloseTo(0.5, 12);
  });

  it("lifts faint pixels in asinh mode and stays monotonic", () => {
    // asinh(10 * 0.1) / asinh(10) = 0.881374 / 2.998223 = 0.293965
    expect(stretchValue(1, 0, 10, "asinh")).toBeCloseTo(0.293965, 5);
    let prev = -1;
    for (let v = 0; v <= 10; v += 0.5) {
      const t = stretchValue(v, 0, 10, "asinh");
      expect(t).toBeGreaterThan(prev);
      expect(t).toBeGreaterThanOrEqual(stretchValue(v, 0, 10, "linear") - 1e-12);
      prev = t;
    }
  });

  it("does not divide by zero on a flat frame", () => {
    expect(stretchValue(3, 3, 3, "linear")).toBe(0);
    expect(stretchValue(3, 3, 3, "asinh")).toBe(0);
  });
});

describe("renderFrame", () => {
  const frame = new Float32Array([0, 5, 10, Number.NaN, -3, 20]);
  const px = (rgba: Uint8ClampedArray, i: number) => Array.from(rgba.subarray(i * 4, i * 4 + 4));

  it("writes opaque grey levels in pixel order and marks NaN with the no-data colour", () => {
    const rgba = renderFrame(frame, { lo: 0, hi: 10 }, "linear");
    expect(rgba.length).toBe(6 * 4);
    expect(px(rgba, 0)).toEqual([0, 0, 0, 255]);
    expect(px(rgba, 1)).toEqual([128, 128, 128, 255]);
    expect(px(rgba, 2)).toEqual([255, 255, 255, 255]);
    expect(px(rgba, 3)).toEqual([...NAN_RGB, 255]);
    expect(px(rgba, 4)).toEqual([0, 0, 0, 255]); // below lo: clipped
    expect(px(rgba, 5)).toEqual([255, 255, 255, 255]); // above hi: clipped
  });

  it("uses a no-data colour that no grey level can produce", () => {
    const [r, g, b] = NAN_RGB;
    expect(r === g && g === b).toBe(false);
  });

  it("marks every pixel as no-data when the limits are not finite (all-NaN frame)", () => {
    const blank = new Float32Array([Number.NaN, Number.NaN]);
    const rgba = renderFrame(blank, stretchLimits(blank), "linear");
    expect(px(rgba, 0)).toEqual([...NAN_RGB, 255]);
    expect(px(rgba, 1)).toEqual([...NAN_RGB, 255]);
  });

  it("reuses the output buffer when one is given", () => {
    const out = new Uint8ClampedArray(6 * 4);
    expect(renderFrame(frame, { lo: 0, hi: 10 }, "asinh", out)).toBe(out);
    expect(px(out, 1)[0]).toBeGreaterThan(128); // asinh is brighter than linear at mid level
  });
});

describe("mjdToDate", () => {
  it("converts known MJD values", () => {
    // MJD 40587.0 is the Unix epoch; MJD 51544.5 is J2000.0 (2000-01-01 12:00 TT, taken here as UTC).
    expect(mjdToDate(40587).toISOString()).toBe("1970-01-01T00:00:00.000Z");
    expect(mjdToDate(51544.5).toISOString()).toBe("2000-01-01T12:00:00.000Z");
    expect(mjdToIsoDate(60914.21253)).toBe("2025-08-27");
    expect(mjdToIsoDate(61285.257036)).toBe("2026-09-02");
  });
});

// ---------------------------------------------------------------------------------------------
// The real Barnard cube from role A (data/cubes/, PR #8). Skipped until that folder is in the
// checkout; point OSU_CUBES_DIR at a copy to run it earlier. The expected numbers come from the
// Python side (cube.json written by data/cube.py), not from this loader.
// ---------------------------------------------------------------------------------------------
const cubesDir =
  process.env.OSU_CUBES_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data/cubes");
const barnardJson = path.join(cubesDir, "barnard", "D1", "cube.json");

describe.skipIf(!existsSync(barnardJson))("real cube: barnard D1", () => {
  const fileFetch = (async (input: string | URL | Request) => {
    const buf = readFileSync(String(input));
    return new Response(new Uint8Array(buf));
  }) as typeof fetch;

  it("loads 60 frames of 61 x 61 whose NaN fractions match cube.json", async () => {
    const cube = await loadCube(barnardJson.replaceAll("\\", "/"), fileFetch);
    expect([cube.n, cube.h, cube.w]).toEqual([60, 61, 61]);
    expect(cube.meta.pixscale_arcsec).toBe(3);
    expect(cube.meta.source?.from_cache).toBe(true);

    for (let i = 0; i < cube.n; i++) {
      const frame = getFrame(cube, i);
      let nan = 0;
      for (const v of frame) if (Number.isNaN(v)) nan++;
      expect(nan / frame.length).toBeCloseTo(cube.meta.frames[i].nan_frac, 3);
      if (i > 0) expect(cube.meta.frames[i].mjd).toBeGreaterThanOrEqual(cube.meta.frames[i - 1].mjd);
      const { lo, hi } = stretchLimits(frame);
      expect(hi).toBeGreaterThan(lo);
    }
  });
});
