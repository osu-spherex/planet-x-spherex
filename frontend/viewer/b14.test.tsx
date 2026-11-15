import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MeasureView, noMeasureText } from "./Measure";
import { distanceLine, motionUrlFor, parallaxLine, type Measure, type MotionFile } from "./measureData";
import { isSaturatedCore, overflowShare } from "./overlayData";

const cubesDir =
  process.env.OSU_CUBES_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data/cubes");
const read = <T,>(...p: string[]) => JSON.parse(readFileSync(path.join(cubesDir, ...p), "utf8")) as T;
const has = (...p: string[]) => existsSync(path.join(cubesDir, ...p));

// ---------------------------------------------------------------------------------------------
// (1) Issue #87: saturated core note.
// ---------------------------------------------------------------------------------------------
describe("saturated core (B-14 (1))", () => {
  it("OVERFLOW at the centre in most frames", () => {
    const meta = {
      flag_names: { "1": "OVERFLOW", "21": "SOURCE" },
      frames: [{ flags: { any_frac: 1, center_bits: [1, 21] } }, { flags: { any_frac: 1, center_bits: [1] } }, { flags: { any_frac: 0, center_bits: [21] } }],
    };
    expect(overflowShare(meta)).toBeCloseTo(2 / 3, 12);
    expect(isSaturatedCore(meta)).toBe(true);
    expect(overflowShare({ frames: [{}] })).toBeNull();
    expect(isSaturatedCore({ frames: [{}] })).toBe(false);
  });

  it.skipIf(!has("barnard", "D1", "cube.json"))("real cubes: Barnard yes, WISE 0855 and Epsilon Indi B no", () => {
    expect(isSaturatedCore(read("barnard", "D1", "cube.json"))).toBe(true);
    expect(isSaturatedCore(read("wise0855", "D6", "cube.json"))).toBe(false);
    expect(isSaturatedCore(read("epsindb", "D2", "cube.json"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// (2) Issue #93: three states without a measurement file.
// ---------------------------------------------------------------------------------------------
describe("Measure tab without a measurement (B-14 (2))", () => {
  it("says what is happening instead of 'five example objects only'", () => {
    expect(noMeasureText("measuring")).toMatch(/^Measuring the source in every image/);
    expect(noMeasureText("failed")).toBe("The measurement could not be made for this position.");
    expect(noMeasureText("pending")).toMatch(/starts once all images/);
    expect(noMeasureText(undefined)).toMatch(/five example objects only/);
  });
});

// ---------------------------------------------------------------------------------------------
// (3) Issue #104: parallax line and the SPHEREx distance.
// ---------------------------------------------------------------------------------------------
describe("parallax and distance lines (B-14 (3))", () => {
  it("motionUrlFor", () => {
    expect(motionUrlFor("/cubes/epsindb/D2/cube.json")).toBe("/cubes/epsindb/motion.json");
    expect(motionUrlFor("/api/cube?ra=1&dec=2")).toBeNull();
  });

  it("no line for an unconfirmed motion or a plain straight-line fit", () => {
    const base = { pm_ra: 1, pm_dec: 1, err_ra: 0.1, err_dec: 0.1, n_epochs: 3 };
    expect(parallaxLine({ ...base, parallax_arcsec: 0.3, status: "unverified" })).toBe("");
    expect(parallaxLine({ ...base, parallax_arcsec: 0 })).toBe("");
    expect(distanceLine({ parallax_measured: null })).toBe("");
    expect(distanceLine({ parallax_measured: { parallax_arcsec: 0.005, err: 0.26, distance_pc: null } })).toBe("");
  });

  const real = has("barnard", "D1", "measure.json") && has("epsindb", "motion.json");
  it.skipIf(!real)("Barnard: the line, no distance; Epsilon Indi B: line and distance; WISE 0855: neither", () => {
    const barnard = read<Measure>("barnard", "D1", "measure.json");
    const eps = read<Measure>("epsindb", "D2", "measure.json");
    const wise = read<Measure>("wise0855", "D6", "measure.json");
    const barnardMotion = read<MotionFile>("barnard", "motion.json");
    const epsMotion = read<MotionFile>("epsindb", "motion.json");
    const wiseMotion = read<MotionFile>("wise0855", "motion.json");

    expect(parallaxLine(barnard.motion)).toBe(
      `Yearly parallax swing of ${barnard.motion!.parallax_arcsec!.toFixed(3)}″ (Gaia DR3) taken out. Without it: east −1.38 ± 1.54, north +9.97 ± 0.51″/yr.`,
    );
    expect(distanceLine(barnardMotion)).toBe("");

    expect(parallaxLine(eps.motion)).toMatch(/^Yearly parallax swing of 0\.271″ \(Gaia DR3\) taken out\./);
    // 0.303 ± 0.046″ from SPHEREx -> 3.3 pc; error 0.046 / 0.303² = 0.5 pc; Gaia 0.271″ -> 3.69 pc.
    expect(distanceLine(epsMotion)).toBe(
      "Distance from SPHEREx alone: 3.3 ± 0.5 pc (parallax 0.30 ± 0.05″, 5 detectors); Gaia DR3: 3.69 pc (0.271″).",
    );

    expect(parallaxLine(wise.motion)).toBe("");
    expect(distanceLine(wiseMotion)).toBe("");

    const html = renderToStaticMarkup(<MeasureView m={eps} motionFile={epsMotion} />);
    expect(html).toContain("Yearly parallax swing");
    expect(html).toContain("Distance from SPHEREx alone");
    // Visitor wording of the new lines (the stories test forbids these words).
    for (const s of [parallaxLine(barnard.motion), parallaxLine(eps.motion), distanceLine(epsMotion), noMeasureText("measuring")])
      expect(s).not.toMatch(/proper motion|epoch/i);
  });
});
