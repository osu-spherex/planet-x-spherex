import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getFrame, loadCube } from "./cube";
import {
  FLAG_RGBA,
  PM_ARROW_MIN,
  catalogUrlFor,
  centerFlagNames,
  loadCatalog,
  loadFlags,
  mjdToJulianYear,
  releaseLabel,
  renderFlags,
  sourceLabel,
  sourcePixel,
  totalPm,
  type CatalogSource,
} from "./overlayData";

const meta = { center: { ra: 100, dec: 0 }, pixscale_arcsec: 3 };
const src = (o: Partial<CatalogSource> = {}): CatalogSource => ({
  cat: "gaia_dr3",
  id: 1,
  ra: 100,
  dec: 0,
  epoch: 2016,
  pm_ra: null,
  pm_dec: null,
  mag: 10,
  mag_band: "G",
  ...o,
});

describe("catalogUrlFor", () => {
  it("is one folder above the band folder of a static cube", () => {
    expect(catalogUrlFor("/cubes/barnard/D1/cube.json")).toBe("/cubes/barnard/catalog.json");
  });

  it("for a live cube is the backend's /api/catalog with a radius of 50″ per arcminute of field", () => {
    const base = "https://api.example.test";
    expect(catalogUrlFor(`${base}/api/cube?ra=133.79513&dec=-7.24515&band=D6`)).toBe(
      `${base}/api/catalog?ra=133.79513&dec=-7.24515&radius=150`,
    );
    expect(catalogUrlFor(`${base}/api/cube?ra=1&dec=2&band=D1&fov=6`)).toBe(`${base}/api/catalog?ra=1&dec=2&radius=300`);
    expect(catalogUrlFor("/api/cube?band=D1")).toBeNull();
    expect(catalogUrlFor("/somewhere/else?ra=1&dec=2")).toBeNull();
  });

  it("is none for a backend first look (/api/cubes/<key>/cube.json, C-10) or other cube.json paths", () => {
    expect(catalogUrlFor("https://api.example.test/api/cubes/D6_133.7951_-7.2451_f6_p/cube.json")).toBeNull();
    expect(catalogUrlFor("/other/cube.json")).toBeNull();
    expect(catalogUrlFor("https://site.test/cubes/barnard/D1/cube.json")).toBe("https://site.test/cubes/barnard/catalog.json");
  });
});

describe("mjdToJulianYear", () => {
  it("J2000.0 is MJD 51544.5 and a Julian year is 365.25 days", () => {
    expect(mjdToJulianYear(51544.5)).toBe(2000);
    expect(mjdToJulianYear(51544.5 + 25 * 365.25)).toBeCloseTo(2025, 12);
  });
});

describe("sourcePixel", () => {
  const at2016 = 51544.5 + 16 * 365.25;
  it("puts a source at the centre on the centre pixel of any grid size", () => {
    for (const n of [61, 121, 201]) expect(sourcePixel(src(), at2016, meta, n, n)).toEqual({ x: (n - 1) / 2, y: (n - 1) / 2 });
  });

  it("east is left (-x) and north is up (-y)", () => {
    // 6″ east and 9″ north at dec 0: 2 px left, 3 px up.
    const p = sourcePixel(src({ ra: 100 + 6 / 3600, dec: 9 / 3600 }), at2016, meta, 61, 61);
    expect(p.x).toBeCloseTo(28, 9);
    expect(p.y).toBeCloseTo(27, 9);
  });

  it("moves with the proper motion from the catalogue epoch: 3″/yr north for 2 years = 2 px up", () => {
    const p = sourcePixel(src({ pm_ra: 0, pm_dec: 3 }), at2016 + 2 * 365.25, meta, 61, 61);
    expect(p.x).toBeCloseTo(30, 9);
    expect(p.y).toBeCloseTo(28, 9);
  });

  it("uses cos(dec) for RA offsets and handles the 0/360 wrap", () => {
    const m60 = { center: { ra: 0.001, dec: 60 }, pixscale_arcsec: 3 };
    // 0.001° west of the centre across RA 0: dRA = -0.002° = -7.2″, times cos 60° = -3.6″ east = 1.2 px right.
    const p = sourcePixel(src({ ra: 359.999, dec: 60 }), at2016, m60, 61, 61);
    expect(p.x).toBeCloseTo(31.2, 6);
    expect(p.y).toBeCloseTo(30, 9);
  });
});

describe("labels", () => {
  it("totalPm and sourceLabel", () => {
    expect(PM_ARROW_MIN).toBe(0.5);
    expect(totalPm(src({ pm_ra: 3, pm_dec: 4 }))).toBe(5);
    expect(totalPm(src())).toBe(0);
    expect(sourceLabel(src({ id: 42, mag: 9.5, pm_ra: 0, pm_dec: 10.4 }))).toBe("Gaia DR3 42 · G 9.50 · pm 10.40″/yr");
    expect(sourceLabel(src({ cat: "catwise2020", id: "J1", mag: null, mag_band: "W2" }))).toBe("CatWISE2020 J1");
  });

  it("centerFlagNames names known bits and numbers unknown ones", () => {
    const m = { flag_names: { "0": "SATURATED" }, frames: [{ flags: { any_frac: 0.1, center_bits: [0, 7] } }, {}] };
    expect(centerFlagNames(m, 0)).toEqual(["SATURATED", "bit 7"]);
    expect(centerFlagNames(m, 1)).toEqual([]);
  });

  it("releaseLabel lists the cube's releases", () => {
    expect(releaseLabel({ source: { releases: { qr3: 10, qr2: 50 } } as never })).toBe("QR2 + QR3");
    expect(releaseLabel({ source: { from_cache: true } })).toBe("");
  });
});

describe("loaders and flag layer", () => {
  const fake = (status: number, body?: BodyInit) => (async () => new Response(body ?? "x", { status })) as typeof fetch;

  it("a missing file means no layer (null), never invented data", async () => {
    expect(await loadCatalog("/c.json", fake(404))).toBeNull();
    expect(await loadFlags("/f.u8", { n: 1, h: 1, w: 1 }, fake(404))).toBeNull();
    await expect(loadCatalog("/c.json", fake(200, JSON.stringify({ center: {} })))).rejects.toThrow(/sources/);
  });

  it("loadFlags checks the size against the cube", async () => {
    const ok = await loadFlags("/f.u8", { n: 2, h: 1, w: 2 }, fake(200, new Uint8Array([0, 1, 1, 0])));
    expect(Array.from(ok!)).toEqual([0, 1, 1, 0]);
    await expect(loadFlags("/f.u8", { n: 2, h: 2, w: 2 }, fake(200, new Uint8Array(4)))).rejects.toThrow(/expected 8/);
  });

  it("renderFlags colours flagged pixels of the chosen frame only", () => {
    const flags = new Uint8Array([1, 0, 0, 1]); // 2 frames of 1 x 2
    const f1 = renderFlags(flags, 1, 2, 1);
    expect(Array.from(f1.slice(0, 4))).toEqual([0, 0, 0, 0]);
    expect(Array.from(f1.slice(4, 8))).toEqual([...FLAG_RGBA]);
  });
});

// ---------------------------------------------------------------------------------------------
// Real files (role A): data/cubes/barnard/catalog.json (A-11). Skipped until it exists. The Gaia
// mark must sit on the star in the first and the last frame: flux-weighted centroid of the star
// within 5 px of the mark, distance <= 1.5 cube px (task B-07).
// ---------------------------------------------------------------------------------------------
const cubesDir =
  process.env.OSU_CUBES_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data/cubes");
const barnardCatalog = path.join(cubesDir, "barnard", "catalog.json");
const fileFetch = (async (input: string | URL | Request) =>
  new Response(new Uint8Array(readFileSync(String(input))))) as typeof fetch;

describe.skipIf(!existsSync(barnardCatalog))("real catalog.json: Barnard D1", () => {
  it("the fastest Gaia source follows the star in the first and the last frame", async () => {
    const cube = await loadCube(path.join(cubesDir, "barnard", "D1", "cube.json").replaceAll("\\", "/"), fileFetch);
    const cat = (await loadCatalog(barnardCatalog, fileFetch))!;
    const gaia = cat.sources.filter((s) => s.cat === "gaia_dr3");
    const star = gaia.reduce((a, b) => (totalPm(b) > totalPm(a) ? b : a));
    expect(totalPm(star)).toBeGreaterThan(10); // Barnard's Star, ~10.4″/yr
    for (const k of [0, cube.n - 1]) {
      const p = sourcePixel(star, cube.meta.frames[k].mjd, cube.meta, cube.w, cube.h);
      const img = getFrame(cube, k);
      let s = 0;
      let sx = 0;
      let sy = 0;
      for (let y = 0; y < cube.h; y++)
        for (let x = 0; x < cube.w; x++) {
          const v = img[y * cube.w + x];
          if ((x - p.x) ** 2 + (y - p.y) ** 2 > 25 || !(v > 0)) continue;
          s += v;
          sx += v * x;
          sy += v * y;
        }
      expect(Math.hypot(sx / s - p.x, sy / s - p.y)).toBeLessThanOrEqual(1.5);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Any cube size (fov 3′ / 6′ / 10′ = 61 / 121 / 201 px at 3″, ARCHITECTURE "Интерфейсийн нэмэлт").
// ---------------------------------------------------------------------------------------------
import { renderToStaticMarkup } from "react-dom/server";
import { SkyOverlay } from "./SkyOverlay";
import { stackBox } from "./stackView";

describe("any cube size", () => {
  it("the scale bar stays 30″ long on 61, 121 and 201 px cubes", () => {
    for (const n of [61, 121, 201]) {
      const html = renderToStaticMarkup(<SkyOverlay w={n} h={n} pixscaleArcsec={3} showCentre />);
      // The bar is the horizontal line near the bottom edge (y = h - 2.5 k, k = n / 61).
      const lines = [...html.matchAll(/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"/g)];
      const bar = lines.find((m) => m[2] === m[4] && Number(m[2]) > n * 0.9);
      expect(bar, `scale bar on ${n} px`).toBeDefined();
      expect(Number(bar![3]) - Number(bar![1])).toBeCloseTo(10, 9); // 30″ / 3″ per px
    }
  });

  it("stacks a 3′ cube whole and only a 3′ box of bigger ones", () => {
    const cube = (n: number) => ({ meta: { pixscale_arcsec: 3 }, w: n, h: n }) as never;
    expect(stackBox(cube(61), { x: 30, y: 30 })).toBeUndefined();
    expect(stackBox(cube(121), { x: 60, y: 60 })).toEqual({ x0: 30, y0: 30, x1: 91, y1: 91 });
    expect(stackBox(cube(201), { x: 5, y: 195 })).toEqual({ x0: 0, y0: 165, x1: 36, y1: 201 });
  });
});

// ---------------------------------------------------------------------------------------------
// Which sources to draw (B-10).
// ---------------------------------------------------------------------------------------------
import { ALL_SOURCES_MAX, MOVING_PM_MIN, selectSources, sourceKey } from "./overlayData";
import { CatalogLayer, MARK_RADIUS } from "./OverlayLayers";

describe("selectSources", () => {
  const cat = (n: number, c: string, pm = 0, magStart = 10): CatalogSource[] =>
    Array.from({ length: n }, (_, i) => src({ cat: c, id: `${c}${i}`, mag: magStart + i, pm_ra: 0, pm_dec: pm }));

  it("moving: only pm >= 0.1″/yr", () => {
    expect(MOVING_PM_MIN).toBe(0.1);
    const s = { sources: [...cat(5, "gaia_dr3"), src({ id: "fast", pm_ra: 0.06, pm_dec: 0.08 }), src({ id: "slow", pm_ra: 0.05, pm_dec: 0 })] };
    const r = selectSources(s, "moving");
    expect(r.sources.map((x) => x.id)).toEqual(["fast"]); // 0.1 exactly counts
    expect([r.total, r.moving]).toEqual([7, 1]);
  });

  it("all: the 40 brightest, taking Gaia and CatWISE in turn by their own magnitude, plus moving ones", () => {
    expect(ALL_SOURCES_MAX).toBe(40);
    const s = { sources: [...cat(50, "gaia_dr3", 0, 20), ...cat(50, "catwise2020", 0, 5), src({ id: "mover", mag: 99, pm_dec: 3 })] };
    const r = selectSources(s, "all");
    expect(r.sources.length).toBe(41);
    expect(r.sources.slice(0, 4).map(sourceKey)).toEqual([
      "gaia_dr3:gaia_dr30",
      "catwise2020:catwise20200",
      "gaia_dr3:gaia_dr31",
      "catwise2020:catwise20201",
    ]);
    expect(r.sources.filter((x) => x.cat === "gaia_dr3" && x.id !== "mover").length).toBe(20);
    expect(r.sources.at(-1)!.id).toBe("mover");
    expect(r.total).toBe(101);
  });
});

describe("CatalogLayer marks", () => {
  it("are under 5% of the image across, at 3′, 6′ and 10′", () => {
    expect((2 * MARK_RADIUS) / 61).toBeLessThanOrEqual(0.05);
    for (const n of [61, 121, 201]) {
      const cube = { w: n, h: n, n: 1, data: new Float32Array(0), meta: { ...meta, frames: [], shape: [1, n, n], data_url: "" } } as never;
      const html = renderToStaticMarkup(<CatalogLayer sources={[src()]} cube={cube} mjd={51544.5 + 16 * 365.25} />);
      const r = Number(/<circle cx="[\d.]+" cy="[\d.]+" r="([\d.]+)"/.exec(html.replace(/<circle class="[^"]*catHit[^"]*"[^>]*>/, ""))![1]);
      expect((2 * r) / n).toBeLessThanOrEqual(0.05);
    }
  });
});

describe.skipIf(!existsSync(barnardCatalog))("real catalog.json: moving sources (B-10)", () => {
  it("Barnard 1, WISE 0855 3, eps Ind B 1, RW Aur 0", async () => {
    for (const [obj, n] of [["barnard", 1], ["wise0855", 3], ["epsindb", 1], ["rwaur", 0]] as const) {
      const c = (await loadCatalog(path.join(cubesDir, obj, "catalog.json"), fileFetch))!;
      expect(selectSources(c, "moving").sources.length, obj).toBe(n);
      expect(selectSources(c, "all").sources.length, obj).toBeLessThanOrEqual(ALL_SOURCES_MAX + n);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Flags (A-09 in data/cubes): informational bits apart; Barnard's saturated centre is flagged.
// ---------------------------------------------------------------------------------------------
import { centerFlagDescriptions, centerInfoFlagNames } from "./overlayData";

describe("flag names with informational bits (A-09)", () => {
  const m = {
    flag_names: { "1": "OVERFLOW", "21": "SOURCE", "26": "BLOOM" },
    flag_descriptions: { "1": "Overflow detected during SUR", "21": "Pixel is part of a known source" },
    flags_informational: [12, 21],
    frames: [{ flags: { any_frac: 0.4, center_bits: [1, 21, 26] } }, { flags: { any_frac: 0, center_bits: [21] } }],
  };
  it("lists damage flags only; SOURCE is information", () => {
    expect(centerFlagNames(m, 0)).toEqual(["OVERFLOW", "BLOOM"]);
    expect(centerInfoFlagNames(m, 0)).toEqual(["SOURCE"]);
    expect(centerFlagNames(m, 1)).toEqual([]);
    expect(centerFlagDescriptions(m, 0)).toEqual(["OVERFLOW: Overflow detected during SUR", "BLOOM"]);
  });
});

const barnardFlags = path.join(cubesDir, "barnard", "D1", "flags.u8");
describe.skipIf(!existsSync(barnardFlags))("real flags.u8: Barnard D1 (B-07)", () => {
  it("loads, and the saturated centre (3 x 3) is flagged in every frame; OVERFLOW is named", async () => {
    const cube = await loadCube(path.join(cubesDir, "barnard", "D1", "cube.json").replaceAll("\\", "/"), fileFetch);
    const flags = (await loadFlags(barnardFlags, cube, fileFetch))!;
    const c = (cube.w - 1) / 2;
    for (let k = 0; k < cube.n; k++) {
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) expect(flags[k * cube.h * cube.w + (c + dy) * cube.w + c + dx], `frame ${k}`).toBe(1);
      const names = centerFlagNames(cube.meta as never, k);
      expect(names).toContain("OVERFLOW");
      expect(names).not.toContain("SOURCE");
    }
    // A corner of the field is not flagged in most frames: the layer marks problems, not the whole image.
    let corner = 0;
    for (let k = 0; k < cube.n; k++) corner += flags[k * cube.h * cube.w + 10 * cube.w + 10];
    expect(corner).toBeLessThan(cube.n / 2);
  });
});
