// The five objects the challenge asks every tool to be tested on, with the detector whose static
// cube is shipped in data/cubes. Facts come from CLAUDE.md ("Заавал туршиж харуулах 5 объект" and
// the 11/10 checks); catalogue motions are the ones quoted in the merged PRs (#17, #24):
// Gaia DR3 for Barnard's Star and eps Ind A, CatWISE2020 for WISE 0855.
// The one-line object types (young star, pulsating giant, cold brown dwarf) are standard
// descriptions and still need a source link each: that check belongs to D-03, which also owns
// the longer explanations. Keep these to one sentence.

export interface DemoObject {
  /** Folder name under /cubes. */
  id: string;
  name: string;
  /** Detector of the static cube, "D1".."D6". */
  band: string;
  /**
   * Centre of the static cube, degrees: where the object is at MJD 61100 according to its
   * catalogue motion (data/cubes/<id>/<band>/cube.json, `center`). Used to ask the backend for
   * the same field in another detector.
   */
  ra: number;
  dec: number;
  kind: "moves" | "varies";
  /** One sentence for the button and the heading. */
  blurb: string;
  /** What to do in the viewer to see it. */
  hint: string;
  /** Catalogue proper motion, arcsec/yr (pmRa includes cos Dec). Only for moving objects. */
  catalogueMotion?: { pmRa: number; pmDec: number; source: string };
}

export const DEMO_OBJECTS: DemoObject[] = [
  {
    id: "barnard",
    name: "Barnard's Star",
    band: "D1",
    ra: 269.4462864,
    dec: 4.7680655,
    kind: "moves",
    blurb: "A nearby star that crosses the sky by about 10 arcseconds per year, mostly to the north.",
    hint: "Open “Compare visits”: the red and blue pair shows where the star is now and where it was a year earlier.",
    catalogueMotion: { pmRa: -0.8, pmDec: 10.36, source: "Gaia DR3" },
  },
  {
    id: "wise0855",
    name: "WISE 0855−0714",
    band: "D6",
    ra: 133.7603654,
    dec: -7.2418008,
    kind: "moves",
    blurb: "A very cold, faint brown dwarf moving by about 8 arcseconds per year.",
    hint: "It is close to the noise in a single image. Open “Stack” and press the catalogue button: 45 images add up to one spot.",
    catalogueMotion: { pmRa: -7.97, pmDec: 0.81, source: "CatWISE2020" },
  },
  {
    id: "epsindb",
    name: "Epsilon Indi B",
    band: "D2",
    ra: 331.0970851,
    dec: -56.8013402,
    kind: "moves",
    blurb: "A pair of brown dwarfs, seen as one source, moving together with the star Epsilon Indi A.",
    hint: "Open “Compare visits” and pick the first and the last visit.",
    catalogueMotion: { pmRa: 3.967, pmDec: -2.536, source: "Gaia DR3 (eps Ind A, common proper motion)" },
  },
  {
    id: "rwaur",
    name: "RW Aurigae",
    band: "D1",
    ra: 76.9560898,
    dec: 30.4011238,
    kind: "varies",
    blurb: "A young star whose brightness changes from visit to visit.",
    hint: "In “Compare visits” a star that only changed brightness shows a single colour instead of a red and blue pair.",
  },
  {
    id: "rdra",
    name: "R Draconis",
    band: "D1",
    ra: 248.1672298,
    dec: 66.7550269,
    kind: "varies",
    blurb: "A pulsating giant star, so bright that its core saturates the detector.",
    hint: "The grey patch in the middle is the saturated core. Its brightness is measured from the ring of light around it.",
  },
];

export function findDemoObject(id: string | null | undefined): DemoObject {
  return DEMO_OBJECTS.find((o) => o.id === id) ?? DEMO_OBJECTS[0];
}

export function cubeUrl(o: DemoObject): string {
  return `/cubes/${o.id}/${o.band}/cube.json`;
}
