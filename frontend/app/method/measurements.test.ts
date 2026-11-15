// readMeasurements (the /method page, task P-08) against the real measure.json files.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findStory } from "../../content/stories";
import { DEMO_OBJECTS } from "../../lib/objects";
import { readMeasurements } from "./measurements";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../data/cubes");
const have = DEMO_OBJECTS.every((o) => existsSync(path.join(dir, o.id, o.band, "measure.json")));

describe.skipIf(!have)("readMeasurements on data/cubes", () => {
  const rows = have ? readMeasurements(dir) : [];
  const row = (id: string) => rows.find((r) => r.id === id)!;

  it("gives one row per demo object, in its demo detector", () => {
    expect(rows.map((r) => [r.id, r.band])).toEqual(DEMO_OBJECTS.map((o) => [o.id, o.band]));
  });

  it("uses the wing method exactly for the saturated stars, each with its own unit", () => {
    for (const r of rows) {
      expect(r.photometryMethod, r.id).toBe(r.saturated ? "wing" : "aperture");
      expect(r.photometryUnit, r.id).toBe(r.photometryMethod === "wing" ? "MJy/sr" : "mJy");
      expect(r.photometryNote.length, r.id).toBeGreaterThan(0);
    }
    expect(rows.filter((r) => r.saturated).map((r) => r.id).sort()).toEqual(["barnard", "rdra"]);
  });

  it("compares brightness only within 0.02 µm wavelength bins (data/photometry.py)", () => {
    for (const r of rows) expect(r.binWidthUm, r.id).toBe(0.02);
  });

  it("quotes the same brightness change as the object's story", () => {
    for (const r of rows.filter((x) => x.kind === "varies")) {
      const n = findStory(r.id)!.numbers;
      expect(r.brightness, r.id).not.toBeNull();
      expect(Number(r.brightness!.factor.toFixed(1)), r.id).toBe(n.brightnessFactor);
      expect(r.brightness!.lamMin, r.id).toBeCloseTo(n.brightnessBin!, 6);
    }
    for (const r of rows.filter((x) => x.kind === "moves")) expect(r.brightness, r.id).toBeNull();
  });

  it("marks a motion confirmed only where measure.json says ok, and keeps the reason otherwise", () => {
    expect(row("barnard").motion!.confirmed).toBe(true);
    expect(row("epsindb").motion!.confirmed).toBe(true);
    expect(row("wise0855").motion!.confirmed).toBe(false);
    for (const r of rows) if (r.motion && !r.motion.confirmed) expect(r.motion.note, r.id).toMatch(/Not a confirmed measurement/);
  });

  it("counts every image in exactly one data release, all from the cache", () => {
    for (const r of rows) {
      expect(Object.values(r.releases).reduce((a, b) => a + b, 0), r.id).toBe(r.images);
      expect(r.imagesUsed, r.id).toBeLessThanOrEqual(r.images);
      expect(r.fromCache, r.id).toBe(true);
    }
  });
});
