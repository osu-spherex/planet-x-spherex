import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FullSpectrum } from "./Spectrum";
import { MeasureView } from "./Measure";
import {
  bandSummaries,
  loadSpectrum,
  measured,
  seams,
  spectrumUrlFor,
  undetectedLines,
  type SpectrumFile,
  type SpectrumPoint,
} from "./spectrumData";

// Test-only fixture in the spectrum.json shape (ARCHITECTURE "Интерфейсийн нэмэлт"). Made-up numbers.
const pt = (band: string, lam: number, flux: number | null, ok = true, why = "", epoch = 0): SpectrumPoint => ({
  band,
  mjd: 60900 + epoch * 100,
  epoch,
  lam_um: lam,
  flux,
  err: flux === null ? null : 0.1,
  ok,
  why,
});
const fixture = (): SpectrumFile => ({
  object: "test",
  unit: "mJy",
  note: "No aperture correction between detectors.",
  points: [
    pt("D2", 1.2, 30),
    pt("D2", 1.6, 35, true, "", 1),
    pt("D3", 1.7, 20),
    pt("D3", 2.4, 22, false, "flagged pixel in the aperture"),
    pt("D1", 0.8, null, false, "too faint"),
    pt("D1", 1.0, null, false, "too faint"),
  ],
});

describe("spectrumData", () => {
  it("spectrumUrlFor is next to the band folders", () => {
    expect(spectrumUrlFor("/cubes/epsindb/D2/cube.json")).toBe("/cubes/epsindb/spectrum.json");
    expect(spectrumUrlFor("/api/cube?ra=1")).toBeNull();
    expect(spectrumUrlFor("https://api.example.test/api/cubes/D2_331.1_-56.8_p/cube.json")).toBeNull();
  });

  it("summarises detectors in D1..D6 order with counts, ranges and reasons", () => {
    const s = bandSummaries(fixture().points);
    expect(s.map((b) => [b.band, b.n, b.nOk])).toEqual([
      ["D1", 2, 0],
      ["D2", 2, 2],
      ["D3", 2, 1],
    ]);
    expect([s[1].lamMin, s[1].lamMax]).toEqual([1.2, 1.6]);
    expect(s[0].reasons).toEqual(["too faint"]);
  });

  it("puts a seam halfway between neighbouring detectors", () => {
    const s = seams(bandSummaries(fixture().points));
    expect(s).toHaveLength(2);
    expect(s[0]).toBeCloseTo((1.0 + 1.2) / 2, 12); // D1 ends 1.0, D2 starts 1.2
    expect(s[1]).toBeCloseTo((1.6 + 1.7) / 2, 12);
  });

  it("says in words which detectors detected nothing", () => {
    expect(undetectedLines(bandSummaries(fixture().points))).toEqual(["D1: not detected in 2 images (too faint)."]);
    expect(measured(pt("D1", 1, 5, false))).toBe(false);
  });

  it("loadSpectrum: 404 is no spectrum; a file without points is an error", async () => {
    expect(await loadSpectrum("/s.json", (async () => new Response("x", { status: 404 })) as typeof fetch)).toBeNull();
    await expect(
      loadSpectrum("/s.json", (async () => new Response(JSON.stringify({ unit: "mJy" }))) as typeof fetch),
    ).rejects.toThrow(/points/);
  });
});

describe("FullSpectrum", () => {
  it("draws measured points, flagged points faint with their reason, seams, and names undetected detectors", () => {
    const html = renderToStaticMarkup(<FullSpectrum spectrum={fixture()} />);
    // 4 points with a flux are drawn (D1 has none); one of them faint.
    expect(html.match(/data-faded/g)?.length).toBe(1);
    expect(html).toContain("not used: flagged pixel in the aperture");
    expect(html.match(/data-vline/g)?.length).toBe(2);
    expect(html).toContain("D1: not detected in 2 images (too faint).");
    expect(html).toContain("No aperture correction between detectors.");
    expect(html).toContain("brightness (mJy)");
    // Detector key with counts: D2 2 of 2, D3 1 of 2; D1 has no measured point so no key.
    expect(html).toContain("D2 (2 of 2)");
    expect(html).toContain("D3 (1 of 2)");
    expect(html).not.toContain("D1 (");
  });

  it("MeasureView shows the full spectrum instead of the single-detector one when given", () => {
    const m = { epochs: [], motion: null, photometry: [{ mjd: 1, lam_um: 1.1, flux: 2, err: 0.1, ok: true }] };
    const withFull = renderToStaticMarkup(<MeasureView m={m} fullSpectrum={fixture()} />);
    const without = renderToStaticMarkup(<MeasureView m={m} />);
    expect(withFull).toContain("Full spectrum, all detectors");
    expect(withFull).not.toContain("Brightness against wavelength");
    expect(without).toContain("Brightness against wavelength");
  });
});

// ---------------------------------------------------------------------------------------------
// Real files from role A (data/cubes/<obj>/spectrum.json, task A-08). Skipped until they exist.
// ---------------------------------------------------------------------------------------------
const cubesDir =
  process.env.OSU_CUBES_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data/cubes");
const specPath = (obj: string) => path.join(cubesDir, obj, "spectrum.json");
const readSpec = (obj: string) => JSON.parse(readFileSync(specPath(obj), "utf8")) as SpectrumFile;
const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};

describe.skipIf(!existsSync(specPath("epsindb")))("real spectrum.json: eps Ind B", () => {
  it("shows the 1.35-1.40 µm dip (water absorption in a brown dwarf)", () => {
    const s = readSpec("epsindb");
    const ok = s.points.filter(measured);
    const inBand = (a: number, b: number) => ok.filter((p) => p.lam_um >= a && p.lam_um < b).map((p) => p.flux as number);
    const dip = median(inBand(1.35, 1.4));
    const around = Math.min(median(inBand(1.2, 1.3)), median(inBand(1.5, 1.6)));
    expect(dip).toBeLessThan(0.5 * around);
    const html = renderToStaticMarkup(<FullSpectrum spectrum={s} />);
    expect(html).toContain("Full spectrum, all detectors");
  });
});

describe.skipIf(!existsSync(specPath("wise0855")))("real spectrum.json: WISE 0855", () => {
  it("every detector without a measured point is named as not detected", () => {
    const s = readSpec("wise0855");
    const html = renderToStaticMarkup(<FullSpectrum spectrum={s} />);
    for (const b of bandSummaries(s.points).filter((x) => x.nOk === 0)) expect(html).toContain(`${b.band}: not detected`);
  });
});

// ---------------------------------------------------------------------------------------------
// Detectors where the target is not seen (issue #75, A-08: bands[].detected, why_not, neighbour).
// ---------------------------------------------------------------------------------------------
import { bandDetected, notTargetLines } from "./spectrumData";

const withBands = (): SpectrumFile => ({
  ...fixture(),
  note: "Sum within 15 arcsec. Another source lies 8.2 arcsec from the position; in D1, D2 it is what the images show, not the target. It is inside the aperture.",
  neighbour: { east_arcsec: -7.9, north_arcsec: 2.2, sep_arcsec: 8.2, bands: ["D1", "D2"] },
  bands: [
    { band: "D1", detected: false, why_not: "no significant light at the position" },
    { band: "D2", detected: false, why_not: "the light in the aperture comes from another source, 8.3 arcsec from the position" },
    { band: "D3", detected: true, why_not: "" },
  ],
});

describe("detectors where the target is not seen", () => {
  it("bandDetected follows the file, and counts every detector when the file has no bands", () => {
    expect(bandDetected(withBands(), "D2")).toBe(false);
    expect(bandDetected(withBands(), "D3")).toBe(true);
    expect(bandDetected(fixture(), "D2")).toBe(true);
  });

  it("notTargetLines quotes the file's reason, one sentence per detector", () => {
    expect(notTargetLines(withBands())).toEqual([
      "D1: no significant light at the position.",
      "D2: the light in the aperture comes from another source, 8.3 arcsec from the position.",
    ]);
  });

  it("leaves those detectors out of the chart, explains why, and prints the note in full", () => {
    const html = renderToStaticMarkup(<FullSpectrum spectrum={withBands()} />);
    expect(html).toContain("Not the target in 2 detectors");
    expect(html).toContain("comes from another source, 8.3 arcsec from the position.");
    // Only D3's two points are drawn (D2's two are left out). D3's rejected one (22, ok: false) lies
    // above the range set by the measured one (20), so it is an arrow on the top edge (B-11).
    expect(html.match(/<g stroke=/g)?.length).toBe(1);
    expect(html.match(/data-offscale="above"/g)?.length).toBe(1);
    expect(html).not.toContain("D2 (2 of 2)");
    expect(html).toContain("D3 (1 of 2)");
    expect(html).toContain("in D1, D2 it is what the images show, not the target. It is inside the aperture.");
  });
});

describe.skipIf(!existsSync(specPath("wise0855")) || !readSpec("wise0855").bands)("real spectrum.json with bands: WISE 0855", () => {
  it("D1–D4 are not drawn as WISE 0855 and their reasons are shown; D5 and D6 are", () => {
    const s = readSpec("wise0855");
    const off = s.bands!.filter((b) => !b.detected).map((b) => b.band);
    expect(off).toEqual(["D1", "D2", "D3", "D4"]);
    const html = renderToStaticMarkup(<FullSpectrum spectrum={s} />);
    for (const b of off) expect(html).toContain(`${b}: the light in the aperture comes from another source`);
    expect(html).toMatch(/D5 \(\d+ of \d+\)/);
    expect(html).toMatch(/D6 \(\d+ of \d+\)/);
    expect(html).not.toMatch(/D2 \(\d+ of \d+\)/);
  });
});

// ---------------------------------------------------------------------------------------------
// B-11: rejected points do not set the y axis.
// ---------------------------------------------------------------------------------------------
import { robustYRange } from "./charts";

describe("robust y axis (B-11)", () => {
  it("uses only points that count, so two far rejected points cannot flatten the spectrum", () => {
    const good = Array.from({ length: 30 }, (_, i) => ({ x: 4 + i / 30, y: 0.4 + 0.01 * i, err: 0.05 }));
    const bad = [
      { x: 4.2, y: 60, faded: true },
      { x: 4.3, y: -25, faded: true },
    ];
    const [lo, hi] = robustYRange([...good, ...bad], [0]);
    expect(lo).toBeLessThanOrEqual(0);
    expect(lo).toBeGreaterThan(-0.2);
    expect(hi).toBeGreaterThan(0.69);
    expect(hi).toBeLessThan(1);
  });

  it("falls back to every point when none counts", () => {
    expect(robustYRange([{ x: 1, y: 5, faded: true }], [])).toEqual([4, 6]);
  });
});

describe.skipIf(!existsSync(specPath("wise0855")) || !readSpec("wise0855").bands)("real spectrum.json: WISE 0855 axis (B-11)", () => {
  it("D5–D6 fill the chart: the y axis stops near 1 mJy instead of 60, x spans all detectors", () => {
    const html = renderToStaticMarkup(<FullSpectrum spectrum={readSpec("wise0855")} />);
    const yTicks = [...html.matchAll(/text-anchor="end"[^>]*>([^<]+)</g)].map((m) => Number(m[1].replace("−", "-")));
    expect(Math.max(...yTicks)).toBeLessThan(3);
    const xTicks = [...html.matchAll(/text-anchor="middle"[^>]*>([\d.]+)</g)].map((m) => Number(m[1]));
    // 0.74-5.0 µm gives ticks 2, 4; with only D5-D6 (3.8-5.0 µm) they would be 4, 4.5, 5.
    expect(Math.max(...xTicks) - Math.min(...xTicks)).toBeGreaterThanOrEqual(2);
  });
});

import { bandRange, neighbourSummary } from "./spectrumData";

describe("neighbour summary (issue #75)", () => {
  it("bandRange shortens a run of detectors", () => {
    expect(bandRange(["D1", "D2", "D3", "D4"])).toBe("D1–D4");
    expect(bandRange(["D1", "D3"])).toBe("D1, D3");
    expect(bandRange(["D5", "D6"])).toBe("D5, D6");
  });

  it("one sentence for the detectors where a neighbouring source is what the images show", () => {
    const s = withBands();
    expect(neighbourSummary(s)).toBe(
      "D1, D2: the light in the aperture comes from another source 8.2″ from the position (7.9″ west, 2.2″ north), not the target.",
    );
    expect(neighbourSummary({ ...s, neighbour: null })).toBeNull();
    expect(neighbourSummary(fixture())).toBeNull();
  });
});

describe.skipIf(!existsSync(specPath("wise0855")) || !readSpec("wise0855").neighbour)("real spectrum.json: WISE 0855 neighbour line", () => {
  it("says D1–D4 in one sentence", () => {
    expect(neighbourSummary(readSpec("wise0855"))).toMatch(/^D1–D4: the light in the aperture comes from another source 8\.2″ from the position \(7\.9″ west, 2\.2″ north\), not the target\.$/);
  });
});
