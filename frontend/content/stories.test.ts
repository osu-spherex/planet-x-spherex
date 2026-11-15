import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEMO_OBJECTS } from "../lib/objects";
import { DATA_SOURCE, STORIES, findStory } from "./stories";

// The numbers a story quotes must be the numbers in the data files written by role A.
const cubesDir =
  process.env.OSU_CUBES_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data/cubes");

interface CubeJson {
  shape: [number, number, number];
  epochs: unknown[];
  frames: { mjd: number }[];
}
interface MeasureJson {
  saturated: boolean;
  motion: { pm_ra: number; pm_dec: number; err_ra: number; err_dec: number; status: string } | null;
  light_curves?: { lam_min: number; lam_max: number; points: { mjd: number; flux: number }[] }[];
}

function read<T>(id: string, band: string, name: string): T {
  return JSON.parse(readFileSync(path.join(cubesDir, id, band, name), "utf-8")) as T;
}

const one = (v: number) => Math.round(v * 10) / 10;

describe("stories", () => {
  it("has one story per demo object, in the same order", () => {
    expect(STORIES.map((s) => s.id)).toEqual(DEMO_OBJECTS.map((o) => o.id));
    expect(findStory("rdra")?.id).toBe("rdra");
    expect(findStory("nope")).toBeNull();
    expect(findStory(null)).toBeNull();
  });

  it("says what it is, what to look for, what to press and what was measured, in short text", () => {
    for (const s of STORIES) {
      for (const part of [s.what, s.look, s.tryThis, s.measured]) {
        expect(part.length, s.id).toBeGreaterThan(40);
        expect(part.length, s.id).toBeLessThan(520);
        expect(part, s.id).not.toMatch(/undefined|null|NaN/);
      }
      // the buttons the text sends people to exist in the viewer under these names
      expect(s.tryThis, s.id).toMatch(/“(Compare visits|Stack|Measure)”/);
    }
  });

  it("links a source for every object, by https where the site offers it", () => {
    for (const s of STORIES) {
      expect(s.sources.length, s.id).toBeGreaterThan(0);
      for (const src of s.sources) {
        expect(src.label.length).toBeGreaterThan(5);
        expect(() => new URL(src.url)).not.toThrow();
      }
    }
    expect(new URL(DATA_SOURCE.url).hostname).toBe("irsa.ipac.caltech.edu");
  });

  it("avoids words a visitor would not know", () => {
    for (const s of STORIES) {
      const text = [s.what, s.look, s.tryThis, s.measured].join(" ");
      expect(text, s.id).not.toMatch(/\b(cutout|PSF|centroid|epoch|proper motion|flux|LVF|FITS|WCS)\b/i);
    }
  });

  describe.skipIf(!existsSync(cubesDir))("numbers against data/cubes", () => {
    for (const o of DEMO_OBJECTS) {
      it(`${o.id}: images, visits and status`, () => {
        const s = findStory(o.id)!;
        const cube = read<CubeJson>(o.id, o.band, "cube.json");
        const m = read<MeasureJson>(o.id, o.band, "measure.json");
        expect(s.numbers.images).toBe(cube.shape[0]);
        expect(s.numbers.visits).toBe(cube.epochs.length);
        expect(s.numbers.status).toBe(m.motion?.status);
        expect(s.measured + s.tryThis).toContain(String(cube.shape[0]));
      });
    }

    it("quotes the measured motion of Barnard's Star and Epsilon Indi B to one decimal", () => {
      for (const id of ["barnard", "epsindb"]) {
        const o = DEMO_OBJECTS.find((d) => d.id === id)!;
        const n = findStory(id)!.numbers;
        const m = read<MeasureJson>(o.id, o.band, "measure.json").motion!;
        expect(n.pmRa, id).toBe(one(m.pm_ra));
        expect(n.pmDec, id).toBe(one(m.pm_dec));
        expect(n.errRa, id).toBe(one(m.err_ra));
        expect(n.errDec, id).toBe(one(m.err_dec));
      }
    });

    it("does not quote a motion the data file calls unverified", () => {
      for (const s of STORIES) {
        if (s.numbers.status === "unverified") {
          expect(s.numbers.pmRa, s.id).toBeNull();
          expect(s.numbers.pmDec, s.id).toBeNull();
          expect(s.measured, s.id).toMatch(/not confirmed/);
        }
      }
    });

    it("says a star is saturated exactly when the data file does", () => {
      for (const o of DEMO_OBJECTS) {
        const text = Object.values(findStory(o.id)!).filter((v) => typeof v === "string").join(" ");
        expect(/saturated/.test(text), o.id).toBe(read<MeasureJson>(o.id, o.band, "measure.json").saturated);
      }
    });

    it("quotes the brightness change of RW Aur and R Dra from one wavelength bin of their light curves", () => {
      for (const id of ["rwaur", "rdra"]) {
        const o = DEMO_OBJECTS.find((d) => d.id === id)!;
        const n = findStory(id)!.numbers;
        const curves = read<MeasureJson>(o.id, o.band, "measure.json").light_curves ?? [];
        const curve = curves.find((c) => Math.abs(c.lam_min - n.brightnessBin!) < 1e-6);
        expect(curve, `${id}: bin ${n.brightnessBin}`).toBeDefined();
        const flux = curve!.points.map((p) => p.flux);
        expect(n.brightnessFactor, id).toBe(one(Math.max(...flux) / Math.min(...flux)));
      }
    });

    it("RW Aur: the brightening it describes is between the first and the last visit", () => {
      const o = DEMO_OBJECTS.find((d) => d.id === "rwaur")!;
      const n = findStory("rwaur")!.numbers;
      const curve = read<MeasureJson>(o.id, o.band, "measure.json").light_curves!.find(
        (c) => Math.abs(c.lam_min - n.brightnessBin!) < 1e-6,
      )!;
      const pts = [...curve.points].sort((a, b) => a.mjd - b.mjd);
      expect(one(pts[pts.length - 1].flux / pts[0].flux)).toBe(n.brightnessFactor);
      // The text says "between September 2025 and September 2026". MJD 60919 = 2025-09-01,
      // 60949 = 2025-10-01, 61284 = 2026-09-01, 61314 = 2026-10-01 (astropy.time, 2026-11-14).
      expect(findStory("rwaur")!.look).toContain("between September 2025 and September 2026");
      expect(pts[0].mjd).toBeGreaterThanOrEqual(60919);
      expect(pts[0].mjd).toBeLessThan(60949);
      expect(pts[pts.length - 1].mjd).toBeGreaterThanOrEqual(61284);
      expect(pts[pts.length - 1].mjd).toBeLessThan(61314);
    });
  });
});
