import { describe, expect, it } from "vitest";
import { readyNote } from "./staticCubes";

describe("readyNote (B-11 (4))", () => {
  const all = ["D1", "D2", "D3", "D4", "D5", "D6"] as const;
  it("says all six are prepared once A-08's cubes exist", () => {
    expect(readyNote("WISE 0855−0714", all, "D2", 3)).toBe(" All six detectors are prepared for WISE 0855−0714 at 3′.");
    expect(readyNote("WISE 0855−0714", all, "D2", 6)).toBe(
      " All six detectors are prepared for WISE 0855−0714 at 3′. Fields wider than 3′ are fetched from NASA’s archive when you open them.",
    );
  });

  it("lists what is prepared when only some detectors are (older deployment)", () => {
    expect(readyNote("Epsilon Indi B", ["D2"], "D5", 3)).toBe(" Prepared for Epsilon Indi B at 3′: D2. D5 is fetched from NASA’s archive.");
    expect(readyNote("Epsilon Indi B", ["D2"], "D2", 3)).toBe(" Prepared for Epsilon Indi B at 3′: D2.");
  });

  it("says nothing while checking", () => {
    expect(readyNote("Barnard's Star", null, "D1", 3)).toBe("");
  });
});
