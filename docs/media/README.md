# Media for the Project page and the slides

Made by `node tools/capture_media.mjs` (task B-17) from the live site in headless Chromium; the PNGs and GIFs are the
pages as served, not edited. The video shows the same kind of screenshots with an English caption bar laid over the
bottom, a title card and an end card, and has no sound. No names, faces or voices of people appear.

| File | Caption (English, for the Project page) | Taken from |
| --- | --- | --- |
| `01-barnard-home.png` | The first screen: pick one of five objects or type any sky position; here Barnard's Star in the first of its SPHEREx images. | https://osu-spherex.vercel.app/?object=barnard, as it opens; 2026-11-15 07:46 UTC (0.2 MB) |
| `02-barnard-compare-visits.png` | Compare visits: the last visit minus the first; Barnard's Star leaves a blue spot where it was and a red one where it is a year later. | https://osu-spherex.vercel.app/?object=barnard, tab "Compare visits" (first and last visit, the default); 2026-11-15 07:46 UTC (0.1 MB) |
| `03-wise0855-stack-catalogue.png` | WISE 0855, a cold brown dwarf barely visible in any single image, stands out when all its images are shifted along its catalogue motion and added up. | https://osu-spherex.vercel.app/?object=wise0855, tab "Stack", button "Catalogue: …"; 2026-11-15 07:46 UTC (0.2 MB) |
| `04-wise0855-search.png` | Motion search tries every motion up to 15″ a year, finds WISE 0855's motion by itself, and tests how often noise alone would score as high. | https://osu-spherex.vercel.app/?object=wise0855, tab "Stack", "Search", then "How sure is this?"; 2026-11-15 07:46 UTC (0.2 MB) |
| `05-wise0855-six-detectors.png` | The same stack in all six SPHEREx detectors: WISE 0855 shows only at the longest wavelengths, where a cold brown dwarf is brightest. | https://osu-spherex.vercel.app/?object=wise0855, tab "Stack", catalogue motion, "Stack all six detectors"; 2026-11-15 07:46 UTC (0.3 MB) |
| `06-epsindb-measure-motion.png` | Epsilon Indi B: its position in each visit follows the catalogue motion, and the yearly parallax swing gives its distance from SPHEREx images alone. | https://osu-spherex.vercel.app/?object=epsindb, tab "Measure"; 2026-11-15 07:46 UTC (0.2 MB) |
| `07-epsindb-spectrum.png` | A spectrum for free: every SPHEREx image sees the source at a different wavelength, and the images of all six detectors together give Epsilon Indi B's spectrum, with its deep absorption bands. | https://osu-spherex.vercel.app/?object=epsindb, tab "Measure", section "Spectrum"; 2026-11-15 07:46 UTC (0.2 MB) |
| `08-rdra-light-curve.png` | R Draconis, a pulsating giant: its brightness over time, compared only between images taken at the same wavelength. | https://osu-spherex.vercel.app/?object=rdra, tab "Measure", section "Brightness over time"; 2026-11-15 07:46 UTC (0.1 MB) |
| `09-rwaur-measure.png` | RW Aurigae, a star that changes brightness: compared at one wavelength over a year. | https://osu-spherex.vercel.app/?object=rwaur, tab "Measure", section "Brightness over time"; 2026-11-15 07:46 UTC (0.2 MB) |
| `10-method.png` | The method page: how the images are fetched, aligned, stacked and measured, and where every number comes from. | https://osu-spherex.vercel.app/method, top; 2026-11-15 07:46 UTC (0.3 MB) |
| `11a-phone-home.png` | On a phone: the same tool at 375 px, first screen. | https://osu-spherex.vercel.app/?object=barnard at 375 x 812; 2026-11-15 07:46 UTC (0.1 MB) |
| `11b-phone-stack.png` | On a phone: the Stack tab for Barnard's Star. | https://osu-spherex.vercel.app/?object=barnard at 375 x 812, tab "Stack"; 2026-11-15 07:46 UTC (0.2 MB) |
| `demo-30s.mp4` | A 30-second silent tour with captions: Barnard's Star moving, the difference image, WISE 0855 appearing in the stack and in the search, and Epsilon Indi B's distance. | screenshots of https://osu-spherex.vercel.app in the order of docs/PITCH.md, captions laid over them, 29.0 s; 2026-11-15 07:59 UTC (0.4 MB) |
| `gif-a-barnard-film.gif` | All 60 SPHEREx images of Barnard's Star in time order, with the date and wavelength of each. | https://osu-spherex.vercel.app/?object=barnard, tab "Images", "Next image" 59 times; 2026-11-15 07:46 UTC (1.0 MB) |
| `gif-b-wise0855-appears.gif` | WISE 0855: one SPHEREx image, where it is lost in the noise, and the stack of all 45 images along its motion, where it stands out, switching back and forth. | https://osu-spherex.vercel.app/?object=wise0855, tab "Images" (first image) and tab "Stack" with "Catalogue: …"; both panels scaled to 480 px; 2026-11-15 07:46 UTC (0.1 MB) |
