# viewer/ (role B)

Canvas viewer: cube loader, frame player, difference image, shift-and-stack view.
Cube format: `docs/ARCHITECTURE.md`, section "Интерфейс"; details in `data/cubes/README.md`. Tasks: `tasks/B.md`.
Tests sit next to the code as `*.test.ts(x)` and run with `npm test`.

## What is here (B-01)

| File | What |
| --- | --- |
| `cube.ts` | `loadCube(url)` → `{ meta, data: Float32Array, n, h, w }`; `getFrame`, `percentile`, `stretchLimits` (1–99.5 %), `stretchValue` (linear / asinh), `renderFrame` → RGBA, `mjdToIsoDate`. No DOM, usable from `search/` and `lib/` too |
| `Viewer.tsx` | Client component: canvas, frame slider, play / pause, brightness scale, speed, centre mark |
| `cube.test.ts` | Unit tests on a hand-written fixture, plus the real Barnard cube when `data/cubes/` is in the checkout |

## Compare visits (B-02)

| File | What |
| --- | --- |
| `epochs.ts` | `groupEpochs(frames)` (new epoch after a gap > 20 days, same rule as `data/cube.py`), `defaultEpochPair` (first and last epoch with ≥ 3 frames), `epochMedian` (role P's `stack()` in median mode with zero motion), `differenceImage` (B − A), `differenceLimit` (99.5 % of |B − A|, at least 5 σ), `renderDifference` (black → red / blue, NaN grey), `sharedLimits` for blink |
| `Difference.tsx` | Visit A / B pickers, "Difference B − A" and "Blink A ↔ B" views. `Viewer` shows it under the "Compare visits" tab |
| `SkyOverlay.tsx` | Centre mark, 30″ bar and N / E arrows, shared by both views |
| `epochs.test.ts` | Unit tests, plus the real Barnard D1 and eps Ind B D2 cubes: the red/blue pair must point along the Gaia DR3 proper motion (±1.5 px), and a fixed field star must cancel |

- **Red** = brighter in visit B (where a moving star is now), **blue** = brighter in visit A (where it was).
  Fixed stars cancel to black.
- Blink uses one brightness scale for both visits, otherwise a brightness change would be hidden by the stretch.
- Each epoch median mixes the wavelengths of its frames (LVF), so faint leftovers at fixed stars are expected.
  Brightness changes are measured in Python at matched wavelengths, not read off this image.

## Stack (B-03)

| File | What |
| --- | --- |
| `stackView.ts` | Around role P's `stack()`: `stackView` (stack + peak SNR within 4 px of the centre via P's `regionPeak`), `defaultStackMode` (mean for bright targets, clipped mean for faint ones), `stackScales` (display scales fixed from the zero-motion stack), `meanMjd`, `clampMotion` |
| `Stack.tsx` | East / north motion sliders and number inputs (±15″/yr), "(0, 0)" and "Catalogue" buttons, combine mode, stacked image and SNR map side by side |
| `stackView.test.ts` | Synthetic mover, plus real cubes: Barnard D1 at (0, 0) is smeared north-south by the amount the Gaia motion predicts; WISE 0855 D6 SNR is highest at the CatWISE vector |

- The catalogue vector comes from the page: `<Viewer cubeUrl=... catalogueMotion={{ pmRa, pmDec, source }} />`. Without it
  the button is hidden. No motion is hard-coded in `viewer/`.
- Both panels keep the scale of the unshifted stack, so the gain from the right vector is visible.
- The SNR map is per pixel of the 3″ display grid, not the SNR of a measurement.
- Suggested combine: mean for bright targets (their brightness changes with wavelength, so clipping cuts real light),
  clipped mean for faint ones (one cosmic ray outshines them in a plain mean). Bright = median single-frame peak > 50 σ.

## Measure (B-04)

| File | What |
| --- | --- |
| `measureData.ts` | `loadMeasure(url)` (null on 404 = no measurements yet), `measureUrlFor(cubeUrl)` (`measure.json` next to a static `cube.json`), `motionConfirmed`, `noteWithoutHeading`, `spectrumPoints`, `defaultLightCurve` (bin with the most visits), `lineThrough` (a slope through the weighted mean, for drawing) |
| `charts.tsx` | `Chart`: SVG points with 1σ error bars, straight lines, axes with units (`niceTicks`, `extent`). No chart library |
| `Measure.tsx` | `Measure` loads the file; `MeasureView` shows motion (± errors, catalogue comparison, per-visit north / east offset charts), light curve in one wavelength bin (selectable), spectrum coloured by visit |
| `measure.test.tsx` | Unit tests on a test-only fixture, plus the five real `measure.json` files from role A when present |

- Nothing is computed or filled in here: every number is from `measure.json` (role A, Python on raw cutouts).
  Missing parts say so ("not available yet") instead of drawing empty charts.
- `saturated: true` → warning; `motion.status` other than `"ok"` → "Not a confirmed measurement" with A's note.
- Light curves only compare images in one wavelength bin (LVF: every image sees the star at its own wavelength).

## Motion search (B-05; was "Planet X mode", renamed in P-10, issue #94)

| File | What |
| --- | --- |
| `Search.tsx` | In the Stack tab: **Search** runs role P's `velocityGrid` around the search centre, draws the score heatmap (pm_RA × pm_Dec, ″/yr, north up), marks best (ring), not moving (+), catalogue (diamond) and the current stack (dot). Clicking the heatmap sets that motion on the sliders. Clicking the stacked image moves the search centre (dashed circle) |
| `searchView.ts` | `gridVerdict`, `catalogueCheck`, `summarizeShuffles`, `shuffleSentence`, `zeroScore`, `expectedStacks`, `renderHeatmap` (viridis), `vectorToCell` / `cellToVector` |
| `searchView.test.ts` | Unit tests, plus real cubes: WISE 0855 and Barnard pass the catalogue check, blank regions and `wise0855_control` "nothing found" |

## Search in a worker, "How sure is this?" (B-06)

- `Search.tsx` runs role P's `runGrid` (`search/run.ts`) in a Web Worker: the page stays usable, the progress bar counts
  real stacks, **Cancel** and a new search centre stop the running worker (`AbortSignal`).
- After a search that finds a source, **How sure is this?** runs `runFalseAlarm(cube, 100)`: the same search 100 more
  times with the image dates shuffled (`SHUFFLES` = 100, the fewest that can reach p < 0.01), with progress and Cancel.
- Wording follows `search/README.md` ("How to report a search result"):
  - the search alone (`gridVerdict`): "Nothing found" below SNR 5 (blank sky reaches 2.1–4.1), otherwise "A source is
    there", never "it moves";
  - the shuffle test (`summarizeShuffles` → P's `motionVerdict`): `detected` / `consistent` / `none`, with
    `shuffleSentence` ("None of the 100 random time orders scored this high (p < 0.01).") and the zero-vector score;
  - agreeing with a catalogue is only a "search check", not evidence of motion.
- WISE 0855 D6 (browser, 11/14): detected; best moving 21.0, not moving 18.7, highest of 100 shuffles 20.4.
  `wise0855_control`: nothing found (SNR 2.0). The 100-shuffle test is opt-in: `B06_SLOW=1 npx vitest run viewer/searchView.test.ts`.

## Use

```tsx
import { Viewer } from "@/viewer/Viewer";

<Viewer cubeUrl="/cubes/barnard/D1/cube.json" />
```

`cubeUrl` is any URL that returns `cube.json`: a static cube or the backend's `/api/cube?...`. `data_url` is
resolved against it. While the backend is still building a cube, `loadCube` throws `CubeNotReadyError`
(`status`, `progress`); polling is the caller's job and is not part of B-01.

## Display rules

- Row 0 of a frame is north, column 0 is east: frames are drawn top-down, so north is up and east is left.
- NaN pixels (outside the cutout, or flagged by SPHEREx such as a saturated star core) get their own
  blue-grey colour (`NAN_RGB`), never a grey level of the image.
- Each frame is scaled on its own between its 1st and 99.5th percentile, because each frame is taken at a
  different wavelength. Brightness is therefore not comparable between frames.
- The centre mark stays at `center.ra / center.dec`. It is the fixed reference that makes a small motion
  visible: Barnard's Star moves about 10″ (3 cube pixels of 3″) per year.

## Checking against the real cube

`cube.test.ts` reads `data/cubes/barnard/D1` from the repository, or from `OSU_CUBES_DIR` if set, and skips
that test when the folder is missing.

## Overlays and any cube size (B-07)

| File | What |
| --- | --- |
| `overlayData.ts` | `catalog.json` loader (404 = no layer), `catalogUrlFor`, `sourcePixel` (catalogue position moved to a frame's date with its own proper motion), `sourceLabel`, `loadFlags` / `renderFlags` (`flags.u8`), `centerFlagNames`, `releaseLabel` (`source.releases`) |
| `OverlayLayers.tsx` | `CatalogLayer`: Gaia DR3 circles, CatWISE2020 squares, an arrow along the motion for pm ≥ 0.5″/yr, hover text with name, magnitude, motion. `FlagLayer`: flagged pixels of the frame in semi-transparent magenta |
| `overlayData.test.tsx` | Positions, signs, RA wrap, loaders, flag layer, 30″ scale bar on 61/121/201 px; Barnard Gaia-mark test that runs once `data/cubes/barnard/catalog.json` (A-11) exists |

- Toggles **Catalogue** and **Flags** (Images tab) appear only when `catalog.json` / `flags_url` exist. The frame line
  names the flag bits near the centre (`frames[].flags`, `flag_names`); the header shows the releases (e.g. "DR1 + QR3").
- Any H × W works: radii are in arcsec (peak and search 12″, brightness 24″), marks scale with the cube width, the
  scale bar stays 30″. Cubes wider than 3′ are stacked in a 3′ box around the search point (201 × 201 × 150 clipped:
  805 ms whole, 113 ms boxed); the velocity search uses the same 90″ noise box, so 3′ results are unchanged
  (checked: a 121 px copy of the Barnard cube gives the same search numbers as the 61 px one).

## Full spectrum and detector picker (B-08)

| File | What |
| --- | --- |
| `spectrumData.ts` | `spectrum.json` loader (404 = none), `spectrumUrlFor`, `bandSummaries` (per detector: images, measured, range, reasons), `seams` (midpoint between neighbouring detectors), `undetectedLines` |
| `Spectrum.tsx` | `FullSpectrum` in the Measure tab when `/cubes/<obj>/spectrum.json` exists: one marker shape per detector, "Colour by visit", flagged points faint with the reason on hover, dashed lines at detector seams, the file's `note`; detectors with no measured point are named ("D1: not detected in 60 images …") instead of left empty |
| `charts.tsx` | Now also: marker shapes (`BAND_SHAPES`), faded points with hover text, vertical lines, `hideKey` |
| `spectrum.test.tsx`, `Viewer.band.test.tsx` | Fixture tests; eps Ind B dip and WISE 0855 "not detected" tests run once A-08's files exist; jsdom test of the picker |

- Detector picker: `<Viewer band="D2" bands={["D1", …, "D6"]} onBandChange={(b) => …} />` shows a small select in the header.
  The page owns the choice (URL `band`, static or live cube); without `onBandChange` the header shows the band as text.
