import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { flagSummary, releaseText } from "./overlayData";

const cubesDir =
  process.env.OSU_CUBES_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data/cubes");
const read = (...p: string[]) => JSON.parse(readFileSync(path.join(cubesDir, ...p), "utf8"));
const has = (...p: string[]) => existsSync(path.join(cubesDir, ...p));

// B-15 (#90): plain words under the image; pipeline names only behind "Details".
describe("flag line in plain words (#90)", () => {
  const meta = {
    flag_names: { "1": "OVERFLOW", "10": "HOT", "21": "SOURCE" },
    flags_informational: [21],
    frames: [
      { flags: { any_frac: 1, center_bits: [1, 21] } },
      { flags: { any_frac: 0.25, center_bits: [10] } },
      { flags: { any_frac: 0, center_bits: [21] } },
      {},
    ],
  };

  it("saturated, other flags, none, no data", () => {
    expect(flagSummary(meta, 0)).toBe(
      "The middle of this star is too bright for the detector (saturated). Flags mark 100 % of the pixels within 15″ of the centre.",
    );
    expect(flagSummary(meta, 1)).toBe(
      "Some pixels near the centre are marked as less reliable in this image. Flags mark 25 % of the pixels within 15″ of the centre.",
    );
    expect(flagSummary(meta, 2)).toBe("No problem pixels near the centre.");
    expect(flagSummary(meta, 3)).toBeNull();
  });

  it("release label in words", () => {
    expect(releaseText({ source: { releases: { qr3: 18, dr1: 42 } } } as never)).toBe(
      "Images from IRSA processing release DR1 + QR3 (DR = data release, QR = quick release).",
    );
    expect(releaseText({} as never)).toBe("");
  });

  it.skipIf(!has("barnard", "D1", "cube.json"))("Barnard image 1: saturated, no pipeline names in the line", () => {
    const s = flagSummary(read("barnard", "D1", "cube.json"), 0)!;
    expect(s).toMatch(/^The middle of this star is too bright for the detector \(saturated\)/);
    expect(s).not.toMatch(/OVERFLOW|TRANSIENT|BLOOM|SUR_ERROR|ERROR/);
  });
});

// B-15 (#92): overlay labels are HTML at a fixed CSS size, not SVG text in cube pixels.
import { renderToStaticMarkup } from "react-dom/server";
import { SkyOverlay } from "./SkyOverlay";
import { readFileSync as readSrc } from "node:fs";

describe("readable labels (#92)", () => {
  it("scale bar, N and E are HTML labels, not scaled SVG text", () => {
    const html = renderToStaticMarkup(<SkyOverlay w={61} h={61} pixscaleArcsec={3} showCentre />);
    expect(html).not.toContain("<text");
    expect(html).toMatch(/<span[^>]*>30″<\/span>/);
    expect(html).toMatch(/<span[^>]*>N<\/span>/);
    expect(html).toMatch(/<span[^>]*>E<\/span>/);
  });

  it("motion charts one per row; label size fixed at 12 px", () => {
    const css = readSrc(path.join(path.dirname(fileURLToPath(import.meta.url)), "Viewer.module.css"), "utf8");
    expect(css).toMatch(/\.charts \{[^}]*grid-template-columns: 1fr;/);
    expect(css).toMatch(/\.skyLabel \{[^}]*font-size: 12px;/);
  });
});

// B-15 (#91): the selected catalogue mark gets a dark rim; the legend says why some marks sit on dark sky.
describe("catalogue layer (#91)", () => {
  it("dark rim on the selected mark", () => {
    const css = readSrc(path.join(path.dirname(fileURLToPath(import.meta.url)), "Viewer.module.css"), "utf8");
    expect(css).toMatch(/\.catSelected,[^{]*\{[^}]*filter: drop-shadow\([^)]*#000\)/);
  });
});

// B-15 (#95): one-line explanations, no forbidden visitor words.
import { CLIPPED_MEAN_TEXT, SNR_TEXT, VISIT_TEXT } from "./words";

describe("words for a first-time visitor (#95)", () => {
  it("visit, SNR, clipped mean in one sentence each; (0, 0) labelled", () => {
    for (const t of [VISIT_TEXT, SNR_TEXT, CLIPPED_MEAN_TEXT]) {
      expect(t.split(/\. /).length).toBe(1);
      expect(t).not.toMatch(/proper motion|epoch/i);
    }
    expect(VISIT_TEXT).toMatch(/^A visit is/);
    expect(SNR_TEXT).toMatch(/^SNR \(signal-to-noise ratio\)/);
    const stack = readSrc(path.join(path.dirname(fileURLToPath(import.meta.url)), "Stack.tsx"), "utf8");
    expect(stack).toContain("No motion (0, 0)");
  });
});
