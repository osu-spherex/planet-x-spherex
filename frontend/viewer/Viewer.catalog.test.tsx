// @vitest-environment jsdom
// Catalogue layer flow (task B-10): off at first; "moving sources" by default; clicking a mark
// shows the source; "Stack along this motion" opens the Stack tab with that source's catalogue
// motion and its position at the stack's reference time.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Viewer } from "./Viewer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Test-only cube: 2 frames of 21 x 21, one year apart, centre (10, 10), 3″ pixels.
const W = 21;
const meta = {
  center: { ra: 100, dec: 0 },
  pixscale_arcsec: 3,
  shape: [2, W, W],
  band: "D1",
  frames: [
    { id: "f0", band: "D1", mjd: 60000, lam_um: 1, noise: 1, nan_frac: 0 },
    { id: "f1", band: "D1", mjd: 60365.25, lam_um: 1, noise: 1, nan_frac: 0 },
  ],
  data_url: "cube.f32",
};
const yearOf = (mjd: number) => 2000 + (mjd - 51544.5) / 365.25;
// A mover 15″ west of the centre at the mean time, moving 6″/yr north; and two still stars.
const refYear = yearOf(60182.625);
const catalog = {
  center: { ra: 100, dec: 0 },
  radius_arcsec: 150,
  sources: [
    { cat: "gaia_dr3", id: "mover", ra: 100 - 15 / 3600, dec: 0, epoch: refYear, pm_ra: 0, pm_dec: 6, mag: 12, mag_band: "G" },
    { cat: "gaia_dr3", id: "still1", ra: 100 + 9 / 3600, dec: 9 / 3600, epoch: 2016, pm_ra: 0.01, pm_dec: 0, mag: 10, mag_band: "G" },
    { cat: "catwise2020", id: "still2", ra: 100, dec: -12 / 3600, epoch: 2015.4, pm_ra: null, pm_dec: null, mag: 9, mag_band: "W2" },
  ],
  source: { archive: "test" },
};

function stubFetch() {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("cube.json")) return new Response(JSON.stringify(meta));
    if (url.endsWith("cube.f32")) return new Response(new Float32Array(2 * W * W).fill(1).buffer);
    if (url.endsWith("catalog.json")) return new Response(JSON.stringify(catalog));
    return new Response("not found", { status: 404 });
  });
}

let container: HTMLDivElement | null = null;
afterEach(() => {
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
});

const tick = () => act(async () => void (await new Promise((r) => setTimeout(r, 20))));

async function render() {
  vi.stubGlobal("fetch", stubFetch());
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<Viewer cubeUrl="/cubes/test/D1/cube.json" />));
  await tick();
  await tick();
  return container;
}

const click = (el: Element) => act(async () => void el.dispatchEvent(new MouseEvent("click", { bubbles: true })));

describe("Viewer catalogue layer (B-10)", () => {
  it("is off at first, shows only moving sources when turned on, and stacks along a clicked source", async () => {
    const c = await render();
    const toggle = [...c.querySelectorAll("label")].find((l) => l.textContent?.includes("Catalogue"))!.querySelector("input")!;
    expect(toggle.checked).toBe(false);
    expect(c.querySelector("svg[aria-label='Catalogue sources']")).toBeNull();

    await click(toggle);
    const marks = c.querySelectorAll("[data-source]");
    expect([...marks].map((m) => m.getAttribute("data-source"))).toEqual(["gaia_dr3:mover"]);
    expect(c.textContent).toContain("1 of the 3 catalogue sources here moves");

    await click(marks[0]);
    expect(c.textContent).toContain("Gaia DR3 mover");
    const stackBtn = [...c.querySelectorAll("button")].find((b) => b.textContent === "Stack along this motion")!;
    await click(stackBtn);
    await tick();

    const selected = [...c.querySelectorAll("[role=tab]")].find((t) => t.getAttribute("aria-selected") === "true");
    expect(selected?.textContent).toBe("Stack");
    const [east, north] = [...c.querySelectorAll<HTMLInputElement>("input[type=number]")].map((i) => Number(i.value));
    expect([east, north]).toEqual([0, 6]);
    // Search point (dashed circle) on the mover at the mean time: 15″ west = 5 px right of 10.
    const region = c.querySelector("circle[class*=regionMark]")!;
    expect(Number(region.getAttribute("cx"))).toBeCloseTo(15.5, 6);
    expect(Number(region.getAttribute("cy"))).toBeCloseTo(10.5, 6);
  });

  it("all sources lists the brightest with a count", async () => {
    const c = await render();
    await click([...c.querySelectorAll("label")].find((l) => l.textContent?.includes("Catalogue"))!.querySelector("input")!);
    const sel = [...c.querySelectorAll("select")].find((s) => s.textContent?.includes("all sources"))!;
    await act(async () => {
      sel.value = "all";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(c.querySelectorAll("[data-source]").length).toBe(3);
    expect(c.textContent).toContain("Showing the 3 brightest of 3");
  });
});
