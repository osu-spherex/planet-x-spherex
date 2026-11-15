// "Did you mean one of the five objects?" for a typed position.
//
// Why: three of the five challenge objects move fast, and published coordinates are old.
// The WISE 0855 position in the challenge text (08h55m10.831s -07d14m42.53s) is from 2010; the
// object has moved about 2 arcminutes since and is no longer inside a 3 arcminute cutout centred
// there. The same happens with J2000 coordinates of Barnard's Star (4.5 arcminutes off) and of
// Epsilon Indi B (2 arcminutes off). A visitor who types such a position would wait two minutes
// for an empty field, so the page says where the object is now and offers the prepared view.
//
// Everything is computed from lib/objects.ts (centre at CENTRE_EPOCH_MJD and catalogue motion);
// no year or distance is written by hand. Parallax is ignored: 0.45″ for WISE 0855
// (Luhman & Esplin 2016, https://arxiv.org/abs/1605.06655), 0.55″ for Barnard's Star, both far
// below the tolerance used here.

import type { SkyPosition } from "./coords";
import { DEMO_OBJECTS, type DemoObject } from "./objects";

/** Epoch of the centres in lib/objects.ts (see the comment on DemoObject.ra there). */
export const CENTRE_EPOCH_MJD = 61100;

/** Half the width of a cube: 61 pixels of 3″ (data/cube.py GRID, PIXSCALE). */
export const FIELD_HALF_WIDTH_ARCSEC = (61 * 3) / 2;

/** How far from a demo object a typed position still gets the hint. Barnard's Star J2000 is 4.5′ off. */
export const NEARBY_RADIUS_ARCSEC = 6 * 60;

/** A track passing this close to the typed position counts as "the object was here" (one native pixel). */
export const TRACK_TOLERANCE_ARCSEC = 6.2;

const RAD = Math.PI / 180;

/** Decimal year of a Modified Julian Date (J2000.0 = MJD 51544.5, Julian years). */
export function mjdToYear(mjd: number): number {
  return 2000 + (mjd - 51544.5) / 365.25;
}

/** Offset of `to` from `from` on the sky, arcseconds: east and north (tangent plane, fine below a degree). */
export function offsetArcsec(from: SkyPosition, to: SkyPosition): { east: number; north: number } {
  let dra = to.ra - from.ra;
  if (dra > 180) dra -= 360;
  if (dra < -180) dra += 360;
  const meanDec = ((from.dec + to.dec) / 2) * RAD;
  return { east: dra * Math.cos(meanDec) * 3600, north: (to.dec - from.dec) * 3600 };
}

const COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"] as const;

/** Eight-point compass name of an offset (north up, east to the left on the sky). */
export function compass(east: number, north: number): string {
  const angle = (Math.atan2(east, north) / RAD + 360) % 360; // 0 = north, 90 = east
  return COMPASS[Math.round(angle / 45) % 8];
}

/** 12″ or 2.1′ */
export function formatSeparation(arcsec: number): string {
  return arcsec < 60 ? `${Math.round(arcsec)}″` : `${(arcsec / 60).toFixed(1)}′`;
}

export interface NearbyObject {
  object: DemoObject;
  /** Distance from the typed position to where the object is now, arcseconds. */
  separation: number;
  /** Direction from the typed position to the object. */
  direction: string;
  /** The object is outside a cube centred on the typed position. */
  outsideField: boolean;
  /**
   * same: the typed position is the object (within a few arcseconds).
   * was-here: the object's catalogue motion carried it through this position in `year`.
   * near: the object is simply close by.
   */
  kind: "same" | "was-here" | "near";
  /** For was-here: calendar year when the object was at the typed position. */
  year?: number;
  /** For was-here: catalogue speed, arcsec/yr. */
  speed?: number;
}

export interface NearbyOptions {
  objects?: DemoObject[];
  radiusArcsec?: number;
  halfWidthArcsec?: number;
}

/** The demo object closest to `p` if it is within the radius, with what to tell the visitor. */
export function nearbyObject(p: SkyPosition, options: NearbyOptions = {}): NearbyObject | null {
  const objects = options.objects ?? DEMO_OBJECTS;
  const radius = options.radiusArcsec ?? NEARBY_RADIUS_ARCSEC;
  const halfWidth = options.halfWidthArcsec ?? FIELD_HALF_WIDTH_ARCSEC;

  let best: { object: DemoObject; east: number; north: number; separation: number } | null = null;
  for (const object of objects) {
    const { east, north } = offsetArcsec(p, object); // from the typed position to the object now
    const separation = Math.hypot(east, north);
    if (separation <= radius && (best === null || separation < best.separation)) {
      best = { object, east, north, separation };
    }
  }
  if (best === null) return null;

  const { object, east, north, separation } = best;
  const base = {
    object,
    separation,
    direction: compass(east, north),
    outsideField: Math.abs(east) > halfWidth || Math.abs(north) > halfWidth,
  };
  if (separation <= TRACK_TOLERANCE_ARCSEC) return { ...base, kind: "same" };

  const pm = object.catalogueMotion;
  if (pm) {
    // Object at time t (years from the centre epoch) sits at (east, north) + t * (pmRa, pmDec)
    // relative to the typed position. Closest approach of that straight track:
    const speed2 = pm.pmRa * pm.pmRa + pm.pmDec * pm.pmDec;
    const t = -(east * pm.pmRa + north * pm.pmDec) / speed2;
    const miss = Math.hypot(east + t * pm.pmRa, north + t * pm.pmDec);
    if (t < 0 && miss <= TRACK_TOLERANCE_ARCSEC) {
      return {
        ...base,
        kind: "was-here",
        // Calendar year that contains that moment (2010.6 is in 2010), hence floor and not round.
        year: Math.floor(mjdToYear(CENTRE_EPOCH_MJD) + t),
        speed: Math.sqrt(speed2),
      };
    }
  }
  return { ...base, kind: "near" };
}

/** One or two sentences for the visitor. */
export function describeNearby(n: NearbyObject): string {
  const name = n.object.name;
  const where = `${formatSeparation(n.separation)} to the ${n.direction}`;
  const outside = n.outsideField ? ", outside the images below" : "";
  if (n.kind === "same") return `This is ${name}. A prepared view of it opens at once.`;
  if (n.kind === "was-here") {
    return (
      `Looking for ${name}? It was at this position around ${n.year}. It moves about ` +
      `${n.speed!.toFixed(0)}″/yr (${n.object.catalogueMotion!.source}), so today it is ${where}${outside}.`
    );
  }
  return `${name} is ${where} of this position${outside}.`;
}

/**
 * Detector to open for a typed position (B-13, issue #85): the prepared detector of a demo object
 * near it (WISE 0855 → D6, where it can be seen), otherwise null (keep the visitor's choice).
 */
export function startBand(p: SkyPosition, options: NearbyOptions = {}): string | null {
  return nearbyObject(p, options)?.object.band ?? null;
}

/**
 * When the visitor picks a detector in which the nearby object is not seen, one sentence saying so,
 * from the object's spectrum.json bands[] (A-08): e.g. "WISE 0855−0714 is not seen in D1 (the light
 * in the aperture comes from another source, …); it shows in D5 and D6." Empty when it is seen there
 * or nothing is known.
 */
export function detectorSentence(
  name: string,
  band: string,
  bands: readonly { band: string; detected: boolean; why_not?: string }[] | null | undefined,
): string {
  if (!bands?.length) return "";
  const here = bands.find((b) => b.band === band);
  if (!here || here.detected) return "";
  const seen = bands.filter((b) => b.detected).map((b) => b.band);
  const list = seen.length > 1 ? `${seen.slice(0, -1).join(", ")} and ${seen.at(-1)}` : seen.join("");
  const why = here.why_not ? ` (${here.why_not.replace(/\.$/, "")})` : "";
  return `${name} is not seen in ${band}${why}${seen.length ? `; it shows in ${list}` : ""}.`;
}
