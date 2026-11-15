// @vitest-environment jsdom
// The detector picker in the Viewer header (task B-08): shown only when the page passes
// onBandChange and more than one detector; choosing one reports it to the page.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Viewer } from "./Viewer";

// React's act() needs this flag outside a test renderer.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A 1-frame 3 x 3 test cube (test-only). */
const meta = {
  center: { ra: 0, dec: 0 },
  pixscale_arcsec: 3,
  shape: [1, 3, 3],
  band: "D2",
  frames: [{ id: "f0", band: "D2", mjd: 60000, lam_um: 1.2, noise: 1, nan_frac: 0 }],
  data_url: "cube.f32",
};

function stubFetch() {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("cube.json")) return new Response(JSON.stringify(meta));
    if (url.endsWith("cube.f32")) return new Response(new Float32Array(9).fill(1).buffer);
    return new Response("not found", { status: 404 });
  });
}

let container: HTMLDivElement | null = null;
afterEach(() => {
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
});

async function render(el: React.ReactElement) {
  vi.stubGlobal("fetch", stubFetch());
  // jsdom has no canvas; the viewer only needs getContext to return null.
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(el);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  return container;
}

describe("Viewer detector picker", () => {
  it("is shown with onBandChange and reports the chosen detector", async () => {
    const onBandChange = vi.fn();
    const c = await render(
      <Viewer cubeUrl="/cubes/x/D2/cube.json" band="D2" bands={["D1", "D2", "D6"]} onBandChange={onBandChange} />,
    );
    const select = c.querySelector<HTMLSelectElement>('select[aria-label="Detector"]');
    expect(select).not.toBeNull();
    expect(select!.value).toBe("D2");
    expect([...select!.options].map((o) => o.value)).toEqual(["D1", "D2", "D6"]);
    await act(async () => {
      select!.value = "D6";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onBandChange).toHaveBeenCalledWith("D6");
  });

  it("is not shown without onBandChange (the page owns the choice)", async () => {
    const c = await render(<Viewer cubeUrl="/cubes/x/D2/cube.json" bands={["D1", "D2"]} />);
    expect(c.querySelector('select[aria-label="Detector"]')).toBeNull();
    expect(c.textContent).toContain("SPHEREx D2");
  });
});
