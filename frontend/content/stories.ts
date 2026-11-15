// "What am I looking at?" — a few plain sentences for each of the five challenge objects (D-03).
//
// Two kinds of facts are kept apart on purpose:
//   * what the object IS comes from outside sources, each linked in `sources` (checked 2026-11-14);
//   * what OUR TOOL MEASURED comes from the files next to the cubes (data/cubes/<id>/<band>/
//     cube.json and measure.json). Those numbers live in `numbers`, the sentences are built from
//     them, and content/stories.test.ts compares `numbers` with the files, so the text cannot
//     drift from the data.
// Tab and button names ("Compare visits", "Stack", "Measure", "Catalogue") are the viewer's own.

export interface StorySource {
  label: string;
  url: string;
}

export interface StoryNumbers {
  /** Images in the cube. */
  images: number;
  /** Visits (epochs) in the cube. */
  visits: number;
  /** Measured motion, arcsec/yr, rounded to one decimal; null if the story does not quote it. */
  pmRa: number | null;
  pmDec: number | null;
  errRa: number | null;
  errDec: number | null;
  /** measure.json motion.status. */
  status: "ok" | "unverified";
  /** Brightest / faintest visit in one wavelength bin, one decimal; null if not quoted. */
  brightnessFactor: number | null;
  /** The wavelength bin of `brightnessFactor`, micrometres (lam_min of the 0.02 um bin). */
  brightnessBin: number | null;
}

export interface Story {
  /** Same id as in lib/objects.ts. */
  id: string;
  numbers: StoryNumbers;
  /** What it is. */
  what: string;
  /** What should be visible in the images. */
  look: string;
  /** What to press. */
  tryThis: string;
  /** What the tool measured, with numbers. */
  measured: string;
  sources: StorySource[];
}

const ESO_BARNARD: StorySource = {
  label: "ESO press release eso1837 (2018)",
  url: "https://www.eso.org/public/news/eso1837/",
};
const JPL_WISE0855: StorySource = {
  label: "NASA/JPL: Spitzer, WISE find Sun's close, cold neighbor (2014)",
  url: "https://www.jpl.nasa.gov/news/nasas-spitzer-wise-find-suns-close-cold-neighbor/",
};
const ESO_EPSIND: StorySource = {
  label: "ESO press release eso0303 (2003)",
  url: "https://www.eso.org/public/news/eso0303/",
};
const ESO_EPSIND_PAIR: StorySource = {
  label: "ESO: Epsilon Indi, the nearest binary brown dwarf",
  url: "http://www.eso.org/sci/activities/vltsv/visirsv/sterzik.html",
};
const CHANDRA_RWAUR: StorySource = {
  label: "NASA Chandra: RW Aur A (2018)",
  url: "https://chandra.harvard.edu/photo/2018/rwaur/",
};
const GCVS: StorySource = {
  label: "General Catalogue of Variable Stars (VizieR B/gcvs)",
  url: "https://vizier.cfa.harvard.edu/viz-bin/VizieR?-source=B/gcvs",
};
const GAIA: StorySource = {
  label: "Gaia DR3, queried through NASA/IPAC IRSA",
  url: "https://irsa.ipac.caltech.edu/Missions/gaia.html",
};
const CATWISE: StorySource = {
  label: "CatWISE2020, queried through NASA/IPAC IRSA",
  url: "https://irsa.ipac.caltech.edu/Missions/wise.html",
};

const pm = (v: number) => `${v < 0 ? "−" : "+"}${Math.abs(v).toFixed(1)}`;

function barnard(): Story {
  const n: StoryNumbers = {
    images: 60, visits: 4, pmRa: -1.5, pmDec: 9.9, errRa: 1.4, errDec: 0.5,
    status: "ok", brightnessFactor: null, brightnessBin: null,
  };
  return {
    id: "barnard",
    numbers: n,
    what:
      "A red dwarf, a small cool star, only 6 light-years away: the closest single star to the Sun. " +
      "It crosses the sky faster than any other star.",
    look:
      "In one year it moves about 10 arcseconds, almost straight north. One SPHEREx pixel is 6 arcseconds wide, " +
      "so that is less than two pixels: in the film the star hardly seems to move, but compare the first visit " +
      "with the last and it has clearly stepped upward.",
    tryThis:
      "Open “Compare visits” and pick the first and the last visit: the star shows as a red and blue pair, " +
      "now and a year ago. Then open “Measure” to see the same step as a number.",
    measured:
      `From ${n.images} images in ${n.visits} visits we measure ${pm(n.pmDec!)} ± ${n.errDec} arcseconds per year ` +
      "northward; the Gaia catalogue says +10.4. East-west is much less certain " +
      `(${pm(n.pmRa!)} ± ${n.errRa}, catalogue −0.8): the star is so bright that the middle of its image is ` +
      "saturated, and the tool says so instead of hiding it.",
    sources: [ESO_BARNARD, GAIA],
  };
}

function wise0855(): Story {
  const n: StoryNumbers = {
    images: 45, visits: 4, pmRa: null, pmDec: null, errRa: null, errDec: null,
    status: "unverified", brightnessFactor: null, brightnessBin: null,
  };
  return {
    id: "wise0855",
    numbers: n,
    what:
      "A brown dwarf: a body too small to shine like a star, here only a few times heavier than Jupiter and as cold " +
      "as the North Pole. It is 7.2 light-years away, the fourth-closest system to the Sun, and was only found in 2014, " +
      "because of how fast it moves.",
    look:
      "At first, almost nothing: in a single image it is barely brighter than the noise. It moves about 8 arcseconds " +
      "per year, to the west.",
    tryThis:
      `Open “Stack” and press “Catalogue”. The ${n.images} images are shifted to follow the object and ` +
      "added together: the noise averages away and a spot appears in the middle. This is the idea behind searches " +
      "for faint, slowly moving bodies. “Search” below the images tries every motion for you.",
    measured:
      "Single images are too faint for a trustworthy motion, so the tool marks its own number for this object as " +
      "“not confirmed”. What can be shown is the stacked spot at the motion the CatWISE catalogue gives.",
    sources: [JPL_WISE0855, CATWISE],
  };
}

function epsindb(): Story {
  const n: StoryNumbers = {
    images: 93, visits: 5, pmRa: 3.9, pmDec: -2.5, errRa: 0.1, errDec: 0.1,
    status: "ok", brightnessFactor: null, brightnessBin: null,
  };
  return {
    id: "epsindb",
    numbers: n,
    what:
      "Two brown dwarfs circling each other, less than 12 light-years away. They are too close together for SPHEREx " +
      "to tell apart, so they appear as one dot. The pair travels through space together with the bright star " +
      "Epsilon Indi A.",
    look: "The dot moves about 4.7 arcseconds per year towards the lower left (east and south).",
    tryThis:
      "Open “Compare visits” and pick the first and the last visit, a year and a half apart: red is where it is " +
      "now, blue is where it was.",
    measured:
      `From ${n.images} images in ${n.visits} visits: ${pm(n.pmRa!)} ± ${n.errRa} arcseconds per year east and ` +
      `${pm(n.pmDec!)} ± ${n.errDec} north. Gaia gives +4.0 and −2.5 for Epsilon Indi A, which the pair follows.`,
    sources: [ESO_EPSIND, ESO_EPSIND_PAIR, GAIA],
  };
}

function rwaur(): Story {
  const n: StoryNumbers = {
    images: 56, visits: 3, pmRa: null, pmDec: null, errRa: null, errDec: null,
    status: "unverified", brightnessFactor: 2.5, brightnessBin: 0.74,
  };
  return {
    id: "rwaur",
    numbers: n,
    what:
      "A young star, only a few million years old, about 450 light-years away. From time to time dense gas and dust " +
      "around it block part of its light, so its brightness goes up and down.",
    look:
      `It stays in place but gets brighter: between September 2025 and September 2026 it became about ${n.brightnessFactor} ` +
      "times brighter in the same colour of infrared light.",
    tryThis:
      "Open “Measure” and look at “Brightness over time”. In “Compare visits” a source that only changed " +
      "brightness shows a single colour, not a red and blue pair.",
    measured:
      `${n.images} images in ${n.visits} visits. Brightness is only compared between images taken at the same ` +
      "wavelength, because SPHEREx sees every source in a different colour in every image. The star is in fact a close " +
      "pair (1.5 arcseconds apart in the Gaia catalogue); as one of them brightens, their shared centre of light " +
      "shifts a little, and the tool marks that small shift as “not confirmed” motion.",
    sources: [CHANDRA_RWAUR, GAIA],
  };
}

function rdra(): Story {
  const n: StoryNumbers = {
    images: 150, visits: 4, pmRa: null, pmDec: null, errRa: null, errDec: null,
    status: "unverified", brightnessFactor: 3.9, brightnessBin: 0.94,
  };
  return {
    id: "rdra",
    numbers: n,
    what:
      "A giant star that swells and shrinks, and brightens and fades with it, once every 245.6 days. " +
      "Astronomers call this a Mira variable.",
    look:
      "It is so bright that the middle of its image is saturated: the grey patch is where the detector could not " +
      "record a value. Watch the glow around the patch grow and shrink from visit to visit.",
    tryThis:
      "Open “Measure” and look at “Brightness over time”: the curve falls and climbs back, the way a " +
      "pulsating star should.",
    measured:
      `From ${n.images} images: at one wavelength the star was ${n.brightnessFactor} times brighter at its brightest ` +
      "than at its faintest. Because the core is saturated, the brightness is taken from the ring of light around it; " +
      "the position of such a star cannot be trusted, and the tool marks its motion as “not confirmed”.",
    sources: [GCVS],
  };
}

export const STORIES: Story[] = [barnard(), wise0855(), epsindb(), rwaur(), rdra()];

export function findStory(id: string | null | undefined): Story | null {
  return STORIES.find((s) => s.id === id) ?? null;
}

/** Where every image on the site comes from. */
export const DATA_SOURCE = {
  text: "NASA SPHEREx Level 2 spectral images, from the NASA/IPAC Infrared Science Archive (IRSA).",
  url: "https://irsa.ipac.caltech.edu/Missions/spherex.html",
};
