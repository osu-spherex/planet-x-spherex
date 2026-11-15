// Sky coordinates typed by a person: parse and print.
//
// Accepted, in one text field, right ascension first and declination second:
//   decimal degrees      133.7951 -7.2451      133.7951, -7.2451      133.7951° −7.2451°
//   sexagesimal          08h55m10.8s -07d14m42s     08:55:10.8 -07:14:42     08 55 10.8 -07 14 42
// In sexagesimal form the right ascension is in HOURS (1 h = 15 degrees), the usual convention,
// unless it is written with a degree mark (133d47m42s). A decimal right ascension is in degrees
// unless it ends in "h" (8.91968h).

export interface SkyPosition {
  /** Right ascension, degrees, 0 <= ra < 360. */
  ra: number;
  /** Declination, degrees, -90..90. */
  dec: number;
}

export type ParseResult = ({ ok: true } & SkyPosition) | { ok: false; error: string };

const EXAMPLE = "133.7951 -7.2451  or  08h55m10.8s -07d14m42s";

function fail(error: string): ParseResult {
  return { ok: false, error };
}

/** Parse "RA Dec" in decimal degrees or sexagesimal. Never throws. */
export function parseCoordinates(text: string): ParseResult {
  const cleaned = text
    .trim()
    .replace(/[−–—]/g, "-") // typographic minus and dashes
    .replace(/[′’]/g, "'") // prime, curly apostrophe
    .replace(/[″”]/g, '"') // double prime, curly quote
    .toLowerCase();
  if (cleaned === "") return fail(`Type a position, for example ${EXAMPLE}.`);

  // Unit marks are remembered, then treated as separators.
  const raInHours = /^[+-]?[\d.]+\s*h/.test(cleaned);
  const raInDegrees = /^[+-]?[\d.]+\s*(d|°|deg)/.test(cleaned);
  const body = cleaned.replace(/deg|[hmsd°'":,;]/g, " ");
  if (/[^\d\s.+-]/.test(body)) return fail(`Could not read "${text.trim()}". Try ${EXAMPLE}.`);
  const tokens = body.split(/\s+/).filter((t) => t !== "");
  if (!tokens.every((t) => /^[+-]?(\d+\.?\d*|\.\d+)$/.test(t))) {
    return fail(`Could not read "${text.trim()}". Try ${EXAMPLE}.`);
  }
  const num = tokens.map(Number);

  let ra: number;
  let dec: number;
  if (tokens.length === 2) {
    ra = raInHours ? num[0] * 15 : num[0];
    dec = num[1];
  } else if (tokens.length === 6) {
    if (tokens.slice(1, 3).concat(tokens.slice(4)).some((t) => /^[+-]/.test(t))) {
      return fail("A sign belongs only in front of the declination, for example 08h55m10.8s -07d14m42s.");
    }
    const [h, hm, hs, d, dm, ds] = num.map(Math.abs);
    if (hm >= 60 || hs >= 60 || dm >= 60 || ds >= 60) return fail("Minutes and seconds must be below 60.");
    if (tokens[0].startsWith("-")) return fail("Right ascension cannot be negative.");
    const raValue = h + hm / 60 + hs / 3600;
    ra = raInDegrees ? raValue : raValue * 15;
    // "-00 14 42" is negative although its first number is zero: look at the text, not the value
    dec = (tokens[3].startsWith("-") ? -1 : 1) * (d + dm / 60 + ds / 3600);
  } else {
    return fail(`Expected two numbers (degrees) or six (hours minutes seconds, degrees minutes seconds). Try ${EXAMPLE}.`);
  }

  if (!Number.isFinite(ra) || !Number.isFinite(dec)) return fail(`Could not read "${text.trim()}".`);
  if (ra < 0 || ra >= 360) {
    return fail(
      tokens.length === 6 && !raInDegrees
        ? "Right ascension must be between 0h and 24h."
        : "Right ascension must be between 0 and 360 degrees.",
    );
  }
  if (dec < -90 || dec > 90) return fail("Declination must be between -90 and +90 degrees.");
  return { ok: true, ra, dec };
}

/** Number from a URL parameter; null unless it is a plain finite number. */
export function numberParam(value: string | null | undefined): number | null {
  if (value === null || value === undefined || !/^[+-]?(\d+\.?\d*|\.\d+)$/.test(value.trim())) return null;
  const v = Number(value);
  return Number.isFinite(v) ? v : null;
}

/** A position from URL parameters ?ra=&dec= (decimal degrees); null if missing or out of range. */
export function positionFromParams(ra: string | null, dec: string | null): SkyPosition | null {
  const r = numberParam(ra);
  const d = numberParam(dec);
  if (r === null || d === null || r < 0 || r >= 360 || d < -90 || d > 90) return null;
  return { ra: r, dec: d };
}

/** Decimal degrees for a URL or an API call: 5 decimals = 0.036 arcsec, far below a 6 arcsec pixel. */
export function toParam(v: number): string {
  return String(Number(v.toFixed(5)));
}

/** "RA 133.79513°, Dec −7.24515°" */
export function formatDegrees(p: SkyPosition): string {
  const dec = `${p.dec < 0 ? "−" : "+"}${Math.abs(p.dec).toFixed(5)}`;
  return `RA ${p.ra.toFixed(5)}°, Dec ${dec}°`;
}

function sexagesimal(value: number, secondsDecimals: number): [number, number, string] {
  const scale = 10 ** secondsDecimals;
  const total = Math.round(Math.abs(value) * 3600 * scale); // integer units: no 59.999 -> 60 carry bugs
  const whole = Math.floor(total / (3600 * scale));
  const minutes = Math.floor((total - whole * 3600 * scale) / (60 * scale));
  const seconds = (total - whole * 3600 * scale - minutes * 60 * scale) / scale;
  return [whole, minutes, seconds.toFixed(secondsDecimals).padStart(secondsDecimals + 3, "0")];
}

/** "08h55m10.83s −07°14′42.5″" */
export function formatSexagesimal(p: SkyPosition): string {
  const [h, hm, hs] = sexagesimal(p.ra / 15, 2);
  const [d, dm, ds] = sexagesimal(p.dec, 1);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(h)}h${two(hm)}m${hs}s ${p.dec < 0 ? "−" : "+"}${two(d)}°${two(dm)}′${ds}″`;
}
