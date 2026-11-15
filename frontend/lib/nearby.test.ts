import { describe, expect, it } from "vitest";
import { parseCoordinates } from "./coords";
import { compass, describeNearby, formatSeparation, mjdToYear, nearbyObject, offsetArcsec } from "./nearby";
import { DEMO_OBJECTS } from "./objects";

function pos(text: string) {
  const p = parseCoordinates(text);
  if (!p.ok) throw new Error(p.error);
  return { ra: p.ra, dec: p.dec };
}

describe("offsets and names", () => {
  it("MJD 51544.5 is J2000.0", () => {
    expect(mjdToYear(51544.5)).toBe(2000);
    expect(mjdToYear(61100)).toBeCloseTo(2026.16, 2);
  });

  it("one arcminute north and east", () => {
    const o = offsetArcsec({ ra: 10, dec: 0 }, { ra: 10 + 1 / 60, dec: 1 / 60 });
    expect(o.east).toBeCloseTo(60, 1);
    expect(o.north).toBeCloseTo(60, 6);
  });

  it("right ascension shrinks with cos(dec) and wraps at 0h", () => {
    expect(offsetArcsec({ ra: 359.999, dec: 60 }, { ra: 0.001, dec: 60 }).east).toBeCloseTo(0.002 * 3600 * 0.5, 3);
  });

  it("compass", () => {
    expect(compass(0, 1)).toBe("north");
    expect(compass(1, 0)).toBe("east");
    expect(compass(-1, 0)).toBe("west");
    expect(compass(-1, -1)).toBe("south-west");
  });

  it("separation text", () => {
    expect(formatSeparation(12.4)).toBe("12″");
    expect(formatSeparation(124.7)).toBe("2.1′");
  });
});

describe("nearbyObject", () => {
  it("the WISE 0855 position of the challenge text is where the object was in 2010", () => {
    // https://www.spaceappschallenge.org/2026/challenges/planet-x-and-spherex/
    const n = nearbyObject(pos("08h55m10.831s -07d14m42.53s"));
    expect(n?.object.id).toBe("wise0855");
    expect(n?.kind).toBe("was-here");
    expect(n?.year).toBe(2010); // WISE observed it in 2010 (Luhman 2014, https://arxiv.org/abs/1404.6501)
    expect(n!.separation / 60).toBeCloseTo(2.1, 1);
    expect(n?.direction).toBe("west");
    expect(n?.outsideField).toBe(true);
    expect(describeNearby(n!)).toBe(
      "Looking for WISE 0855−0714? It was at this position around 2010. It moves about 8″/yr " +
        "(CatWISE2020), so today it is 2.1′ to the west, outside the images below.",
    );
  });

  it("J2000 coordinates of Barnard's Star (SIMBAD, ICRS epoch 2000) are where it was in 2000", () => {
    // https://simbad.cds.unistra.fr/simbad/sim-id?Ident=Barnard%27s+Star : 17 57 48.498 +04 41 36.11
    const n = nearbyObject(pos("17 57 48.498 +04 41 36.11"));
    expect(n?.object.id).toBe("barnard");
    expect(n?.kind).toBe("was-here");
    expect(n?.year).toBe(2000);
    expect(n?.direction).toBe("north");
    expect(n?.outsideField).toBe(true);
  });

  it("the centre of every demo object is that object", () => {
    for (const o of DEMO_OBJECTS) {
      const n = nearbyObject({ ra: o.ra, dec: o.dec });
      expect(n?.object.id).toBe(o.id);
      expect(n?.kind).toBe("same");
      expect(n?.outsideField).toBe(false);
    }
  });

  it("a position beside a star that does not move is just near it", () => {
    const rw = DEMO_OBJECTS.find((o) => o.id === "rwaur")!;
    const n = nearbyObject({ ra: rw.ra, dec: rw.dec - 30 / 3600 });
    expect(n?.kind).toBe("near");
    expect(n?.direction).toBe("north");
    expect(n?.outsideField).toBe(false);
    expect(describeNearby(n!)).toBe("RW Aurigae is 30″ to the north of this position.");
  });

  it("a position beside a moving object but off its track is near, not was-here", () => {
    const b = DEMO_OBJECTS.find((o) => o.id === "barnard")!;
    const n = nearbyObject({ ra: b.ra + 60 / 3600, dec: b.dec }); // 1′ east: the star moves north
    expect(n?.kind).toBe("near");
  });

  it("a position ahead of the object on its track is near: the object has not been there yet", () => {
    const b = DEMO_OBJECTS.find((o) => o.id === "barnard")!;
    const n = nearbyObject({ ra: b.ra - (0.8 * 5) / 3600 / Math.cos((b.dec * Math.PI) / 180), dec: b.dec + (10.36 * 5) / 3600 });
    expect(n?.kind).toBe("near");
  });

  it("nothing near the Andromeda galaxy", () => {
    expect(nearbyObject({ ra: 10.6847, dec: 41.2687 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// B-13, issue #85: the challenge's WISE 0855 coordinates open the detector where it is seen.
// ---------------------------------------------------------------------------------------------
import { detectorSentence, startBand } from "./nearby";

describe("startBand (B-13)", () => {
  it("the challenge's WISE 0855 position (08h55m10.831s −07d14m42.53s) opens D6, at 3′ and at 6′", () => {
    const p = { ra: 133.79513, dec: -7.24515 };
    expect(startBand(p)).toBe("D6");
    expect(startBand(p, { halfWidthArcsec: 6 * 30 })).toBe("D6");
  });

  it("a position near no demo object keeps the visitor's choice (null)", () => {
    expect(startBand({ ra: 10.6847, dec: 41.2687 })).toBeNull();
  });
});

describe("detectorSentence (B-13)", () => {
  const bands = [
    { band: "D1", detected: false, why_not: "the light in the aperture comes from another source, 8.3 arcsec from the position." },
    { band: "D4", detected: false, why_not: "" },
    { band: "D5", detected: true },
    { band: "D6", detected: true },
  ];
  it("says where the object shows when the chosen detector does not see it", () => {
    expect(detectorSentence("WISE 0855−0714", "D1", bands)).toBe(
      "WISE 0855−0714 is not seen in D1 (the light in the aperture comes from another source, 8.3 arcsec from the position); it shows in D5 and D6.",
    );
    expect(detectorSentence("WISE 0855−0714", "D4", bands)).toBe("WISE 0855−0714 is not seen in D4; it shows in D5 and D6.");
  });
  it("is empty when the object is seen there or nothing is known", () => {
    expect(detectorSentence("WISE 0855−0714", "D6", bands)).toBe("");
    expect(detectorSentence("X", "D1", null)).toBe("");
  });
});
