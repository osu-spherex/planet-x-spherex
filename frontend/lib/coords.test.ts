import { describe, expect, it } from "vitest";
import {
  formatDegrees,
  formatSexagesimal,
  numberParam,
  parseCoordinates,
  positionFromParams,
  toParam,
} from "./coords";

function parsed(text: string) {
  const r = parseCoordinates(text);
  if (!r.ok) throw new Error(`expected "${text}" to parse, got: ${r.error}`);
  return r;
}

describe("parseCoordinates", () => {
  // The challenge page gives WISE 0855 as RA 08h55m10.831s, Dec -07d14m42.53s (CLAUDE.md).
  // By hand: (8 + 55/60 + 10.831/3600) * 15 = 133.795129 deg; -(7 + 14/60 + 42.53/3600) = -7.245147 deg.
  it("reads the WISE 0855 position of the challenge in sexagesimal form", () => {
    const r = parsed("08h55m10.831s -07d14m42.53s");
    expect(r.ra).toBeCloseTo(133.7951, 4);
    expect(r.dec).toBeCloseTo(-7.2451, 4);
    expect(r.ra).toBeCloseTo(133.795129, 6);
    expect(r.dec).toBeCloseTo(-7.245147, 6);
  });

  it("gives the same answer for the usual ways of writing it", () => {
    for (const text of [
      "08:55:10.831 -07:14:42.53",
      "08 55 10.831 -07 14 42.53",
      "8h 55m 10.831s, -7d 14m 42.53s",
      "08h55m10.831s −07°14′42.53″", // typographic minus, degree, prime, double prime
      "  08H55M10.831S   -07D14M42.53S  ",
    ]) {
      const r = parsed(text);
      expect(r.ra, text).toBeCloseTo(133.795129, 6);
      expect(r.dec, text).toBeCloseTo(-7.245147, 6);
    }
  });

  it("reads decimal degrees", () => {
    expect(parsed("133.7951 -7.2451")).toMatchObject({ ra: 133.7951, dec: -7.2451 });
    expect(parsed("133.7951, -7.2451")).toMatchObject({ ra: 133.7951, dec: -7.2451 });
    expect(parsed("133.7951° −7.2451°")).toMatchObject({ ra: 133.7951, dec: -7.2451 });
    expect(parsed("269.4463 +4.7681")).toMatchObject({ ra: 269.4463, dec: 4.7681 });
    expect(parsed("0 0")).toMatchObject({ ra: 0, dec: 0 });
  });

  it("takes a decimal right ascension marked h as hours", () => {
    expect(parsed("8.91968h -7.2451").ra).toBeCloseTo(133.7952, 4);
  });

  it("takes a sexagesimal right ascension marked with degrees as degrees", () => {
    const r = parsed("133d47m42.46s -07d14m42.53s");
    expect(r.ra).toBeCloseTo(133.795128, 5);
  });

  it("keeps the sign of a declination between 0 and -1 degree", () => {
    expect(parsed("12:00:00 -00:30:00").dec).toBeCloseTo(-0.5, 9);
    expect(parsed("12:00:00 +00:30:00").dec).toBeCloseTo(0.5, 9);
    expect(parsed("12:00:00 00:30:00").dec).toBeCloseTo(0.5, 9);
  });

  it("refuses what it cannot read, with a message for the person", () => {
    for (const text of ["", "   ", "barnard", "133.7951", "1 2 3", "1 2 3 4 5", "12:00:00 -91:00:00", "25:00:00 +10:00:00",
      "400 10", "-5 10", "10 95", "12:61:00 +10:00:00", "12:00:00 +10:00:75", "12:-5:00 +10:00:00", "1e5 2"]) {
      const r = parseCoordinates(text);
      expect(r.ok, `"${text}" should not parse`).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(10);
    }
  });

  it("accepts the edges of the sky", () => {
    expect(parsed("359.99999 90").dec).toBe(90);
    expect(parsed("23:59:59.9 -90:00:00").dec).toBe(-90);
    expect(parseCoordinates("360 0").ok).toBe(false);
  });
});

describe("URL parameters", () => {
  it("reads plain numbers only", () => {
    expect(numberParam("133.7951")).toBe(133.7951);
    expect(numberParam("-7.2451")).toBe(-7.2451);
    for (const bad of [null, undefined, "", "abc", "1e3", "12:30", "NaN", "Infinity"]) expect(numberParam(bad)).toBeNull();
  });

  it("builds a position only from a valid pair", () => {
    expect(positionFromParams("133.7951", "-7.2451")).toEqual({ ra: 133.7951, dec: -7.2451 });
    expect(positionFromParams("133.7951", null)).toBeNull();
    expect(positionFromParams("361", "0")).toBeNull();
    expect(positionFromParams("10", "-91")).toBeNull();
  });

  it("writes five decimals without trailing zeros", () => {
    expect(toParam(133.795129)).toBe("133.79513");
    expect(toParam(-7.2451)).toBe("-7.2451");
    expect(toParam(269)).toBe("269");
  });

  it("survives a round trip through the URL", () => {
    const r = parsed("08h55m10.831s -07d14m42.53s");
    const back = positionFromParams(toParam(r.ra), toParam(r.dec));
    expect(back?.ra).toBeCloseTo(r.ra, 5);
    expect(back?.dec).toBeCloseTo(r.dec, 5);
  });
});

describe("formatting", () => {
  const wise = { ra: 133.795129, dec: -7.245147 };

  it("prints decimal degrees with a real minus sign", () => {
    expect(formatDegrees(wise)).toBe("RA 133.79513°, Dec −7.24515°");
    expect(formatDegrees({ ra: 269.4463, dec: 4.7681 })).toBe("RA 269.44630°, Dec +4.76810°");
  });

  it("prints sexagesimal that parses back to the same place", () => {
    const text = formatSexagesimal(wise);
    expect(text).toBe("08h55m10.83s −07°14′42.5″");
    const back = parsed(text);
    expect(back.ra).toBeCloseTo(wise.ra, 4);
    expect(back.dec).toBeCloseTo(wise.dec, 4);
  });

  it("never prints 60 seconds", () => {
    // 1h 00m 59.99999s rounds up to 1h 01m 00.00s; -1d 00' 59.99" rounds up to -1d 01' 00.0"
    expect(formatSexagesimal({ ra: 15 * (1 + 59.99999 / 3600), dec: -(1 + 59.99 / 3600) })).toBe(
      "01h01m00.00s −01°01′00.0″",
    );
  });
});
