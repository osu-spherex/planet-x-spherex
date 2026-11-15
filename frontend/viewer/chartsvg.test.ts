// The width: 100% rule must reach only the outer chart svg. On the nested plot-area svg it overrode
// width={pw} (320 instead of 264 user units), so lines were drawn stretched while the points were not:
// Epsilon Indi B's east offsets sat about 1″ above the measured-motion line (found while taking B-17 screenshots).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "Viewer.module.css"), "utf8");

describe("chart svg sizing", () => {
  it("width: 100% applies to the outer svg only", () => {
    expect(css).not.toMatch(/\.chart svg\s*\{/);
    expect(css).toMatch(/\.chart > svg\s*\{[^}]*width: 100%/);
  });
});
