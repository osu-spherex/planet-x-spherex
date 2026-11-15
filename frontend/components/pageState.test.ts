import { describe, expect, it } from "vitest";
import { DEFAULT_FOV_OBJECT, DEFAULT_FOV_POSITION, embedCode, readState, staticCubeUrl, stateQuery } from "./pageState";

const params = (q: string) => new URLSearchParams(q);

describe("readState", () => {
  it("defaults: first object, its own detector, 3′, not embedded", () => {
    const s = readState(params(""));
    expect(s.object?.id).toBe("barnard");
    expect(s.band).toBe("D1");
    expect(s.fov).toBe(3);
    expect(s.embed).toBe(false);
  });

  it("a typed position defaults to 6′ and D1, and wins over object", () => {
    const s = readState(params("ra=133.79513&dec=-7.24515&object=barnard"));
    expect(s.custom).toEqual({ ra: 133.79513, dec: -7.24515 });
    expect(s.object).toBeNull();
    expect(s.fov).toBe(DEFAULT_FOV_POSITION);
    expect(DEFAULT_FOV_POSITION).toBe(6);
    expect(s.band).toBe("D1");
  });

  it("reads band, fov and embed, and ignores invalid values", () => {
    expect(readState(params("object=wise0855&band=D2&fov=10&embed=1"))).toMatchObject({ band: "D2", fov: 10, embed: true });
    expect(readState(params("object=wise0855&band=D9&fov=7"))).toMatchObject({ band: "D6", fov: DEFAULT_FOV_OBJECT });
  });
});

describe("stateQuery", () => {
  it("round-trips and leaves defaults out", () => {
    for (const q of [
      "object=barnard",
      "object=barnard&band=D2&fov=6",
      "ra=133.79513&dec=-7.24515&band=D6",
      "ra=133.79513&dec=-7.24515&band=D6&fov=3&embed=1",
    ]) {
      expect(stateQuery(readState(params(q)))).toBe(q);
    }
  });

  it("writes the challenge's WISE 0855 position with its detector", () => {
    const s = readState(params("ra=133.79513&dec=-7.24515&band=D6"));
    expect(stateQuery({ ...s, band: "D5" })).toBe("ra=133.79513&dec=-7.24515&band=D5");
  });
});

describe("staticCubeUrl and embedCode", () => {
  it("static cube path per detector", () => {
    expect(staticCubeUrl("epsindb", "D3")).toBe("/cubes/epsindb/D3/cube.json");
  });

  it("embed code is an iframe on the same view with embed=1, attributes escaped", () => {
    const code = embedCode("https://osu-spherex.onrender.com/?object=barnard&band=D2");
    expect(code).toBe(
      '<iframe src="https://osu-spherex.onrender.com/?object=barnard&amp;band=D2&amp;embed=1" width="560" height="900" style="border:0" title="SPHEREx images (Planet X &amp; SPHEREx)" loading="lazy"></iframe>',
    );
  });
});
