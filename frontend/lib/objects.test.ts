import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEMO_OBJECTS, cubeUrl, findDemoObject } from "./objects";

const cubesDir =
  process.env.OSU_CUBES_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data/cubes");

describe("demo objects", () => {
  it("lists the five challenge objects with unique ids", () => {
    expect(DEMO_OBJECTS.map((o) => o.id)).toEqual(["barnard", "wise0855", "epsindb", "rwaur", "rdra"]);
  });

  it("falls back to the first object for an unknown id", () => {
    expect(findDemoObject("nope").id).toBe("barnard");
    expect(findDemoObject(null).id).toBe("barnard");
    expect(findDemoObject("rdra").name).toBe("R Draconis");
  });

  it("builds the static cube URL", () => {
    expect(cubeUrl(findDemoObject("wise0855"))).toBe("/cubes/wise0855/D6/cube.json");
  });

  it.skipIf(!existsSync(cubesDir))("gives each object the centre of its static cube", () => {
    for (const o of DEMO_OBJECTS) {
      const meta = JSON.parse(readFileSync(path.join(cubesDir, o.id, o.band, "cube.json"), "utf-8")) as {
        center: { ra: number; dec: number };
      };
      expect(o.ra, o.id).toBeCloseTo(meta.center.ra, 6);
      expect(o.dec, o.id).toBeCloseTo(meta.center.dec, 6);
    }
  });

  it.skipIf(!existsSync(cubesDir))("has a static cube on disk for every object", () => {
    for (const o of DEMO_OBJECTS) {
      expect(existsSync(path.join(cubesDir, o.id, o.band, "cube.json")), `${o.id}/${o.band}`).toBe(true);
      expect(existsSync(path.join(cubesDir, o.id, o.band, "cube.f32")), `${o.id}/${o.band}`).toBe(true);
    }
  });
});
