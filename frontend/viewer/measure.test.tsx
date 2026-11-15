import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Chart, extent, niceTicks } from "./charts";
import { MeasureView } from "./Measure";
import {
  defaultLightCurve,
  lineThrough,
  loadMeasure,
  measureUrlFor,
  motionConfirmed,
  noteWithoutHeading,
  spectrumPoints,
  type Measure,
} from "./measureData";

// ---------------------------------------------------------------------------------------------
// Test-only fixture in the measure.json shape (Issue #18). Numbers are made up for the tests and
// never shown in the demo.
// ---------------------------------------------------------------------------------------------
function fixture(overrides: Partial<Measure> = {}): Measure {
  return {
    saturated: false,
    epochs: [
      { epoch: 0, mjd: 60000, n: 10, dra_arcsec: 0, ddec_arcsec: -5, err_ra: 0.5, err_dec: 0.5 },
      { epoch: 1, mjd: 60365.25, n: 10, dra_arcsec: 0, ddec_arcsec: 5, err_ra: 0.5, err_dec: 0.5 },
    ],
    motion: { pm_ra: 0.12, pm_dec: 10, err_ra: 0.3, err_dec: 0.4, n_epochs: 2, status: "ok", note: "" },
    photometry: [
      { mjd: 60000, epoch: 0, lam_um: 1.1, flux: 2, err: 0.1, ok: true },
      { mjd: 60001, epoch: 0, lam_um: 1.3, flux: 3, err: null, ok: true },
      { mjd: 60002, epoch: 0, lam_um: 1.5, flux: null, err: null, ok: false, why: "masked" },
      { mjd: 60366, epoch: 1, lam_um: 1.1, flux: 4, err: 0.2, ok: true },
    ],
    photometry_method: "aperture",
    photometry_unit: "mJy",
    light_curves: [
      { lam_min: 1.3, lam_max: 1.32, points: [{ mjd: 60001, flux: 3, err: 0.1, n: 1 }] },
      {
        lam_min: 1.1,
        lam_max: 1.12,
        points: [
          { mjd: 60000, flux: 2, err: 0.1, n: 1 },
          { mjd: 60366, flux: 4, err: 0.2, n: 1 },
        ],
      },
    ],
    ...overrides,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("measureUrlFor", () => {
  it("puts measure.json next to a static cube.json, and gives null for other URLs", () => {
    expect(measureUrlFor("/cubes/barnard/D1/cube.json")).toBe("/cubes/barnard/D1/measure.json");
    expect(measureUrlFor("/api/cube?ra=1&dec=2&band=D1")).toBeNull();
    expect(measureUrlFor("/cubes/x/D1/other.json")).toBeNull();
  });
});

describe("loadMeasure", () => {
  it("returns null for a missing file (no measurements yet), never invented data", async () => {
    const f = (async () => new Response("nope", { status: 404 })) as typeof fetch;
    expect(await loadMeasure("/cubes/x/D1/measure.json", f)).toBeNull();
  });

  it("fills missing photometry and motion with empty values and rejects a file without epochs", async () => {
    const ok = (async () => json({ epochs: [] })) as typeof fetch;
    const m = await loadMeasure("/m.json", ok);
    expect(m).toEqual({ epochs: [], motion: null, photometry: [] });
    const bad = (async () => json({ motion: null })) as typeof fetch;
    await expect(loadMeasure("/m.json", bad)).rejects.toThrow(/epochs/);
    const err = (async () => new Response("x", { status: 500, statusText: "Server Error" })) as typeof fetch;
    await expect(loadMeasure("/m.json", err)).rejects.toThrow(/500/);
  });
});

describe("helpers", () => {
  it("motionConfirmed: ok or missing status is confirmed, anything else is not", () => {
    expect(motionConfirmed({ pm_ra: 0, pm_dec: 0, err_ra: 1, err_dec: 1, n_epochs: 2 })).toBe(true);
    expect(motionConfirmed({ pm_ra: 0, pm_dec: 0, err_ra: 1, err_dec: 1, n_epochs: 2, status: "unverified" })).toBe(false);
  });

  it("spectrumPoints keeps only valid points and treats a missing error as 0", () => {
    const s = spectrumPoints(fixture());
    expect(s.map((p) => [p.lam, p.flux, p.err])).toEqual([
      [1.1, 2, 0.1],
      [1.3, 3, 0],
      [1.1, 4, 0.2],
    ]);
  });

  it("defaultLightCurve picks the bin with the most visits, -1 without curves", () => {
    expect(defaultLightCurve(fixture().light_curves)).toBe(1);
    expect(defaultLightCurve([])).toBe(-1);
    expect(defaultLightCurve(undefined)).toBe(-1);
  });

  it("lineThrough passes through the weighted mean with the given slope per Julian year", () => {
    const l = lineThrough(
      [
        { t: 60000, v: -5, err: 0.5 },
        { t: 60365.25, v: 5, err: 0.5 },
      ],
      10,
    )!;
    expect(l.at(60000)).toBeCloseTo(-5, 9);
    expect(l.at(60365.25)).toBeCloseTo(5, 9);
    expect(lineThrough([], 1)).toBeNull();
  });
});

describe("charts", () => {
  it("niceTicks gives round steps covering the range", () => {
    expect(niceTicks(0, 10, 5)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(niceTicks(-0.37, 0.41, 4)).toEqual([-0.2, 0, 0.2, 0.4]);
    expect(niceTicks(3, 3)).toEqual([3]);
    expect(niceTicks(Number.NaN, 1)).toEqual([]);
  });

  it("extent includes error bars and pads", () => {
    expect(extent([{ v: 0, err: 1 }, { v: 10 }], 0)).toEqual([-1, 10]);
    expect(extent([{ v: 2 }], 0.1)).toEqual([1, 3]);
    expect(extent([], 0.1)).toEqual([0, 1]);
  });

  it("draws one error bar per point with a positive error", () => {
    const html = renderToStaticMarkup(
      <Chart
        title="t"
        xLabel="x"
        yLabel="y"
        series={[{ label: "s", color: "red", points: [{ x: 0, y: 1, err: 0.5 }, { x: 1, y: 2 }, { x: 2, y: 3, err: 0 }] }]}
      />,
    );
    expect(html.match(/<circle/g)?.length).toBe(3);
    expect(html.match(/data-errbar/g)?.length).toBe(1);
    expect(html).toContain("y against x");
  });
});

describe("MeasureView (fixture)", () => {
  it("shows the motion with errors, the light curve of the default bin and the spectrum", () => {
    const html = renderToStaticMarkup(
      <MeasureView m={fixture()} catalogueMotion={{ pmRa: 0.1, pmDec: 9.9, source: "Test catalogue" }} />,
    );
    expect(html).toContain("+10.00");
    expect(html).toContain("± 0.40");
    expect(html).toContain("Test catalogue");
    expect(html).toContain("Light curve, 1.10–1.12 µm");
    expect(html).toContain("brightness (mJy)");
    expect(html).toContain("Brightness against wavelength");
    expect(html).not.toContain("Not a confirmed measurement");
    expect(html).not.toContain("Saturated star");
  });

  it("prints the method text whole, ending in exactly one period", () => {
    const a = renderToStaticMarkup(<MeasureView m={fixture({ method: "Gaussian fit, median per epoch" })} />);
    const b = renderToStaticMarkup(<MeasureView m={fixture({ method: "Gaussian fit, median per epoch." })} />);
    expect(a).toContain("Method: Gaussian fit, median per epoch.");
    expect(b).toContain("Method: Gaussian fit, median per epoch.");
    expect(b).not.toContain("epoch..");
  });

  it("says plainly what is missing instead of drawing empty charts", () => {
    const html = renderToStaticMarkup(
      <MeasureView m={fixture({ motion: null, photometry: [], light_curves: [] })} />,
    );
    expect(html).toContain("No motion could be measured");
    expect(html).toContain("Brightness measurements for this object are not available yet");
    expect(html).toContain("No spectrum for this object yet");
  });

  it("warns for saturated stars and unconfirmed motion", () => {
    const m = fixture({ saturated: true });
    m.motion = { ...m.motion!, status: "unverified", note: "Found in only 2 images." };
    const html = renderToStaticMarkup(<MeasureView m={m} />);
    expect(html).toContain("Saturated star");
    expect(html).toContain("Not a confirmed measurement");
    expect(html).toContain("Found in only 2 images.");
  });

  it("does not repeat the heading when the note starts with it (A-07 notes do)", () => {
    expect(noteWithoutHeading("Not a confirmed measurement: the source is found in only 27 of 43 images.")).toBe(
      "The source is found in only 27 of 43 images.",
    );
    expect(noteWithoutHeading("only 2 epochs")).toBe("Only 2 epochs");
    expect(noteWithoutHeading(undefined)).toBe("");
    const m = fixture();
    m.motion = { ...m.motion!, status: "unverified", note: "Not a confirmed measurement: too faint." };
    const html = renderToStaticMarkup(<MeasureView m={m} />);
    expect(html.match(/Not a confirmed measurement/g)?.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Real files from role A (data/cubes/<obj>/<band>/measure.json, task A-07). Skipped until they are
// in the checkout; OSU_CUBES_DIR can point at a copy. The values themselves are A's; here we only
// check that the panel shows them as they are.
// ---------------------------------------------------------------------------------------------
const cubesDir =
  process.env.OSU_CUBES_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data/cubes");
const measureJson = (obj: string, band: string) => path.join(cubesDir, obj, band, "measure.json");
const fileFetch = (async (input: string | URL | Request) =>
  new Response(new Uint8Array(readFileSync(String(input))))) as typeof fetch;
const loadReal = (obj: string, band: string) => loadMeasure(measureJson(obj, band), fileFetch);

describe.skipIf(!existsSync(measureJson("barnard", "D1")))("real measure.json", () => {
  it("Barnard D1: shows pm_dec with its error and the saturation warning", async () => {
    const m = (await loadReal("barnard", "D1"))!;
    const html = renderToStaticMarkup(<MeasureView m={m} />);
    const { pm_dec, err_dec } = m.motion!;
    expect(pm_dec).toBeGreaterThan(9); // A-07 acceptance range 9-11.5″/yr (Gaia DR3: 10.36)
    expect(pm_dec).toBeLessThan(11.5);
    expect(html).toContain(`+${pm_dec.toFixed(2)}`);
    expect(html).toContain(`± ${err_dec.toFixed(2)}`);
    expect(html).toContain("Saturated star");
    // One point and one error bar per visit in each motion chart.
    expect(html.match(/data-errbar/g)?.length).toBeGreaterThanOrEqual(2 * m.epochs.length - 2);
  });

  it("WISE 0855 D6: an unconfirmed motion is flagged, not presented as a result", async () => {
    const m = (await loadReal("wise0855", "D6"))!;
    const html = renderToStaticMarkup(<MeasureView m={m} />);
    if (m.motion && !motionConfirmed(m.motion)) {
      expect(html).toContain("Not a confirmed measurement");
    }
  });

  it("all five files load and render", async () => {
    for (const [o, b] of [
      ["barnard", "D1"],
      ["wise0855", "D6"],
      ["epsindb", "D2"],
      ["rwaur", "D1"],
      ["rdra", "D1"],
    ]) {
      if (!existsSync(measureJson(o, b))) continue;
      const m = (await loadReal(o, b))!;
      expect(m.epochs.length).toBeGreaterThan(0);
      expect(() => renderToStaticMarkup(<MeasureView m={m} />)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// An unconfirmed motion is not shown as a result (issue #75).
// ---------------------------------------------------------------------------------------------
describe("unconfirmed motion", () => {
  it("shows the reason and the fitted numbers inside the warning, not as the big result", () => {
    const m = fixture();
    m.motion = { ...m.motion!, pm_ra: 0.046, pm_dec: -0.101, err_ra: 0.113, err_dec: 0.395, status: "unverified", note: "Not a confirmed measurement: the source found is 8.3 arcsec away, probably another object." };
    const html = renderToStaticMarkup(<MeasureView m={m} />);
    expect(html).not.toMatch(/class="[^"]*bigNumbers/);
    expect(html).toContain("The source found is 8.3 arcsec away, probably another object.");
    expect(html).toContain("it is not reported as the motion of the target");
    expect(html).toContain("fit (not confirmed)");
  });
});

const wiseD2 = path.join(cubesDir, "wise0855", "D2", "measure.json");
describe.skipIf(!existsSync(wiseD2))("real measure.json: WISE 0855 D2 (A-08)", () => {
  it("does not present +0.05″/yr as the measured motion of WISE 0855", async () => {
    const m = (await loadMeasure(wiseD2, fileFetch))!;
    expect(m.motion?.status).toBe("unverified");
    const html = renderToStaticMarkup(<MeasureView m={m} catalogueMotion={{ pmRa: -7.97, pmDec: 0.81, source: "CatWISE2020" }} />);
    expect(html).not.toMatch(/class="[^"]*bigNumbers/);
    expect(html).toContain("Not a confirmed measurement");
    expect(html).toContain("not the motion of the target");
  });
});
