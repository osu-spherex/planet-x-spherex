# search/ (role P)

Pure TypeScript library, no UI: shift-and-stack and the velocity grid search.
Cube format: `docs/ARCHITECTURE.md`, section "Интерфейс". Tasks: `tasks/P.md`.
Tests sit next to the code as `*.test.ts` and run with `npm test`.

| File | What it does |
| --- | --- |
| `stack.ts` | `stack(cube, pmRa, pmDec, refMjd, mode)`: shift every frame by a motion and combine; noise and SNR maps. `frameBrightness` / `brightnessScale`: how bright the target is in each frame (A-13) |
| `grid.ts` | `velocityGrid(cube)`: stack every motion on a grid (±15″/yr), score each by the best SNR near the centre, fit the peak. `scoreGrid` is the same without the fit. Result field `normalised`: the frames were put on a common brightness first (bright targets, see below) |
| `significance.ts` | `falseAlarm(cube, n)`: how often shuffled frame times score as high as the real ones; `motionVerdict()` turns that into the wording below |
| `run.ts` | `runGrid` / `runFalseAlarm`: the same searches in a Web Worker, as promises with progress and cancel; `heatmapData()` shapes a result for drawing |
| `grid.worker.ts` | The worker itself (message handler); used through `run.ts` |
| `stackMulti.ts` | `stackMulti` / `velocityGridMulti`: the same over several detectors (D1–D6), frames weighted by 1/noise² |
| `results.json` | The real-cube results shown on the site's [/method](../app/method/page.tsx) page. `numbers.test.ts` recomputes every value and fails if the file is stale (shuffle counts: run with `P05_SHUFFLES=100`, and `P03_SHUFFLES=500` for WISE 0855 in `significance.test.ts`); the combined-detector numbers (`multi`) are recomputed by `stackMulti.test.ts` (shuffles: `P09_SHUFFLES=100`). If the method changes, rerun those and update the file |

## In the UI: run the search in a worker

A search takes ~1 s (61×61×45 cube) and a `falseAlarm` run n + 1 times that. On the page's main
thread nothing else happens meanwhile: no clicks, no scrolling, no progress bar. Measured on WISE
0855 in the browser (11/14): the main thread froze for 668 ms with `velocityGrid`, at most 12 ms
with `runGrid`, which returns exactly the same numbers.

```ts
import { heatmapData, runGrid } from "@/search/run";

const ac = new AbortController();               // ac.abort() stops the worker (e.g. new search centre)
const r = await runGrid(cube, { centerX, centerY }, (done, total) => setProgress(done / total), { signal: ac.signal });
const h = heatmapData(r, catalogue);             // catalogue optional: { pmRa, pmDec }
// h.values[row * h.nx + col], row 0 = most positive pmDec (north up), col 0 = most negative pmRa;
// h.lo / h.hi for the colour scale; h.markers.best / gridBest / zero / catalogue have (col, row) in
// cell units, cell centres at k + 0.5, the same convention as viewer/searchView.ts vectorToCell.
```

`runFalseAlarm(cube, n, options, onProgress, { signal })` works the same way; progress counts
searches (n + 1). Each call starts its own worker and stops it when done or aborted. Without
`Worker` (Node tests, server rendering) both run on the calling thread with the same result.

## How to report a search result

A search answers two different questions. Say only what the numbers support.

**1. Is anything there?** The best score is a maximum over ~120 motions × ~50 pixels, so blank sky
already reaches SNR 1.5–4.1 (blank regions of the WISE 0855 cube and of role A's control cube,
`numbers.test.ts`). Below `DETECT_SNR = 5`: say
"nothing found", whatever the heatmap looks like.

**2. Does it move?** A source that stands still also stacks well, and a slow mover stacks almost as
well with no shift at all. `falseAlarm` shuffles the frame times and searches again `n` times; `p` is
the chance that a random time order scores as high as the real one. The zero vector's score is
always returned with it (`zero`): it is the same for every order, so it is the baseline to beat.

| `motionVerdict().kind` | When | Say |
| --- | --- | --- |
| `none` | best score < 5 | "Nothing above the blank-sky level." |
| `consistent` | a source, but p ≥ 1% or the zero vector scores at least as high as the best motion | "A source is there. Its motion is **consistent with** (pmRA, pmDec), but these data do not establish it." Never "detected motion". |
| `detected` | a source, p < 1%, and the best motion beats the zero vector | "Motion detected: (pmRA, pmDec) ″/yr; a random time order scores this high in < p of shuffles." |

`p` can never be below `1 / (n + 1)`, so "p < 1%" needs at least 100 shuffles. With the 20 that
fit in a UI wait, the best possible answer is p ≈ 5%, which is `consistent`.

A catalogue vector does not change the verdict: agreeing with a catalogue is a check of the
search, not evidence that this search measured the motion.

## WISE 0855 (real D6 cube, 45 frames, 11/14)

`falseAlarm(cube, 500)` with the defaults (seed 1, ±15″/yr, 11×11 vectors), 322 s in Node.
Reproduce: `P03_SHUFFLES=500 npx vitest run search/significance.test.ts -t "WISE 0855"`.

| | |
| --- | --- |
| Best moving cell, real order | SNR 20.96 at (−8.87, −2.96)″/yr (grid cell, 2.96″/yr step) |
| Zero vector | 18.74 |
| 500 shuffles | mean 18.91, max 20.46; none reaches 20.96 |
| p | 1/501 = 0.002, the smallest 500 shuffles can give |
| z | 5.24 (indicative only: shuffle scores are maxima, not Gaussian) |
| Verdict | `detected` |

What this says: the time order matters, so WISE 0855's motion is detected by SPHEREx alone. For
the vector itself quote `velocityGrid`'s fitted best, (−8.68, +0.20)″/yr, 0.94″/yr from the
catalogue (−7.97, +0.81) (`numbers.test.ts`); the grid cell above is coarse.

What it does not say:

- The margin is small: 20.96 against a best shuffle of 20.46 and a zero vector of 18.74. WISE 0855
  moves only ~2.7 px in the year, about one PSF width, so every order stacks it nearly as well;
  the shuffles just cluster tightly (σ ≈ 0.4).
- About 0.6 of the 2.2 gain over the zero vector could be interpolation smoothing (see
  `significance.ts`); the shuffles have the same smoothing, so p is not affected.
- With 20 shuffles (what fits in a UI wait) the same data give p = 1/21 ≈ 0.05: `consistent`.

## Blank-sky control

Role A's control cube (issue #21, PR #43): `data/cubes/wise0855_control/D6/`, 215″ from WISE 0855,
the same 45 exposures, no catalogued source as bright as WISE 0855 within 46″. A bright source
sits at its east edge, so the control is searched only in the clean central ~30″. Default
search, 11/14:

| | Best score (SNR) |
| --- | --- |
| Control cube, centre | 2.02 |
| Control cube, 9 centres 18″ apart in the central area | 1.45–3.51 |
| Interim control: 8 regions 45″ from the target on the WISE 0855 cube | 2.32–4.05 |
| WISE 0855 | 20.96 |

Blank sky stays below `DETECT_SNR = 5` on both controls. `falseAlarm(control, 100)` gives
p = 0.03; that is chance (p is uniform on noise), and the verdict is `none` anyway because the
score is below 5. This is why question 1 comes first: a motion p means nothing without a source.
The test in `significance.test.ts` checks the control cube whenever it is present.

## Bright targets whose brightness changes between images (A-13)

Each SPHEREx image sees the target at its own wavelength, so a target bright enough to show in
single images changes brightness from image to image. Until A-13 the search stacked the images as
they are and Epsilon Indi B failed the shuffle test (6 of 100, p = 0.07, `consistent`). Now the
search first puts such images on a common brightness, and eps Ind B is `detected`.

### What was measured first (`python experiments/search_diag.py frames | peak | amp`)

- **Eps Ind B (D2, 93 images):** peak / noise per image runs from 27 to 1254 (median 369); the
  noise itself differs 24× between images. At the catalogue motion the frame-noise clip keeps
  **4 of 93** samples on the brightest stack pixel: nearly all the starlight is thrown away, and
  which 4 survive depends on the order of the dates. That, not the data, made the shuffle test fail.
- **Barnard's Star (D1, 60):** peak / noise 2385–18700, and the core is saturated: only 3 of 60
  images have data on the brightest pixel. Its score comes from the wings of the star.
- **WISE 0855 (D6, 45):** median peak / noise 6; too faint to measure in one image. One image
  (frame 5) has a 2335σ spike on the target (the outlier of issue #42); the clip removes it.
- **Why P-07 moved WISE 0855 to (−10.57, +8.01):** one image did it. Frame 12 (visit 1, 4.70 µm)
  shows 0.52 MJy/sr = 13σ at the target, twice the 0.26 that frames 32 and 33 show at the same
  wavelength in visit 3. The frame-noise clip rejects that sample at every motion. The P-07 scale
  rejects it at the catalogue motion (pixel spread 0.073) but keeps it where the spread happens to
  be wider (0.095 at (−11.83, +8.87)), which lifts that cell from 20.4 to 22.5. It is not a
  neighbour: the nearest catalogue sources (`data/cubes/wise0855/catalog.json`) are 7.1″ and 8.2″
  from the centre and fainter (W2 = 17.7 and 15.2).
- **WISE 0855's motion is weakly pinned by the sampling itself:** visits 1 and 3 hold 39 of the 45
  images and lie 0.46 yr apart, over which it moves 3.7″, 1.2 cube pixels. Letting one image in or
  out moves the best motion by several ″/yr. The two bright movers have their light spread evenly
  over 4–5 visits (the 5 best images carry a quarter of the total squared SNR).

### The rule (one code path, one threshold, no object names)

1. **How bright is the target in each image?** Sum the image inside the search radius plus one
   native pixel (4 + 6.16/3 = 6.05 px, 113 pixels) around the search centre
   (`frameBrightness`). The sum uses neither the motion being tried nor the image's date, so it is
   the same number for every cell of the grid and for every shuffle: the shuffle test stays valid.
   Its noise is frame noise × √(pixels) × 6.16/3 (neighbouring 3″ pixels share a native pixel).
2. **Does a single image see the target?** Yes if that sum is at least 5× its noise: the same
   level as `DETECT_SNR` for the stack.
3. **If more than half of the images see it** (`brightnessScale`): divide every such image by its
   brightness (relative to the median, so the stack keeps MJy/sr), leave out the images that do
   not see it, clip at 5× the larger of the frame noise and the pixel's own spread, and average.
   On a common brightness the real light agrees between images and only cosmic rays stand out.
   Each image then has the same say in where the target is, however bright its wavelength.
4. **Otherwise** (a target too faint for single images, or blank sky): stack the images as they
   are, exactly as before. Dividing by a brightness that is mostly noise would only add noise.

How far the cubes are from the threshold ("more than half"): images that see the target are 60
of 60 (Barnard), 93 of 93 (eps Ind B), 55 of 55 (Teegarden's Star); 10 of 45 (WISE 0855), 0 of
45 (control field), 0–7 of 45 (8 blank regions of the WISE 0855 cube) [`numbers.test.ts`, "A-13"].

### Result (`P05_SHUFFLES=100 npx vitest run search/numbers.test.ts --silent=false`, ~25 min, 11/14)

| | Before (`normalise: "off"`) | Now (default) |
| --- | --- | --- |
| Eps Ind B, best motion off catalogue | 1.00″/yr | **0.26″/yr** |
| Eps Ind B, score best cell / zero | 78.4 / 69.2 | 267.5 / 229.2 |
| Eps Ind B, 100 shuffles | 6 reach it (max 84.4), p = 0.07, `consistent` | **0 reach it** (max 229.3), p = 1/101 < 1%, `detected` |
| Barnard, best motion off catalogue | 1.12″/yr | 1.66″/yr |
| Barnard, score best cell / zero | 838 / 361 | 2798 / 2686 |
| Barnard, 100 shuffles | 0 reach it (max 713), `detected` | 0 reach it (max 2678), p = 1/101 < 1%, `detected` |
| WISE 0855, control field, blank regions | | unchanged: not on a common brightness, identical scores |
| Search time, eps Ind B / Barnard | 3.1 s / 0.9 s | 4.2 s / 1.0 s |

**Check on an object that played no part in the design:** Teegarden's Star (D1, 55 images in 3
visits, cube `data/cubes/teegarden/D1`; Gaia DR3 35227046884571776, (+3.429, −3.806)″/yr). Best
motion (+4.66, −3.96), 1.24″/yr from Gaia (1.20 before); score 10260 against zero motion 8424;
0 of 100 shuffles reach it (max 8487), `detected`. It was `detected` before as well (1956, best
shuffle 1861), so this object shows that the rule carries over, not that it was needed there.

**Check on a real star that does not move:** RW Aurigae (D1, 56 images, all see it), with the
numpy copy of the search (`python experiments/search_diag.py modes 100 rwaur`, same seeded
shuffles). Now: the best cell is the zero vector (3217), fitted best (+0.28, +0.10)″/yr, 33 of 100
shuffles reach the best moving cell: `consistent`, as it should be. Before: best (+2.93, +2.93),
4.15″/yr from zero, 91 of 100 shuffles above the real order: also `consistent`, but with a wrong
motion. R Draconis (D1, 150 images, saturated): now the best cell is again the zero vector (706),
fitted best (+0.13, +0.93), 3 of 100 shuffles reach the best moving cell (670), `consistent`;
before, best (+8.68, −0.02) with 9 of 100.

What this does not fix, and what to keep in mind:

- **Barnard moved from 1.12 to 1.66″/yr off** (still under the 2″/yr requirement and half a grid
  step is 1.48). Its saturated core is missing from the images, so the summed brightness misses a
  varying part of the light, and the peak fit fails there (the reported motion is the grid cell).
- The margins on Barnard are small in score (2798 against a best shuffle near 2680): the star moves
  3.5 px in the year and the wings are wide. The verdict rests on 0 of 100 shuffles, not on the gap.
- The brightness is that of everything within 18″ of the search centre. A bright neighbour inside
  that circle would set the scale; none of the cubes here has one.
- `mean` and `median` are put on the common brightness too; `normalise: "off"` gives the search
  as it was, and every "before" number in this file is reproduced with it.

**For a target this bright the search is not the best tool for the motion itself.** In single
images the star's position can be measured directly, image by image, and a straight line fitted
through the positions: `measure.json` gives eps Ind B (+3.70 ± 0.27, −2.56 ± 0.26)″/yr, with an
error bar, which a stack does not give. Stacking is for targets no single image shows (WISE 0855),
where there is no position to measure until the images are added up.

### History: the stacking rules on the frames as they are (before A-13)

Shuffle test on eps Ind B with `normalise: "off"` (`numbers.test.ts`, opt-in with `P05_SHUFFLES`):

| Stack mode | Real order | Best shuffle | Shuffles reaching it | z |
| --- | --- | --- | --- | --- |
| `clipped`, n = 100 | 78.43 | 84.36 | 6 of 100, p = 0.07 → `consistent` | |
| `clipped`, n = 20 | 78.43 | 82.29 | 2 of 20 | 1.54 |
| `mean`, n = 20 | 273.06 | 234.22 | 0 of 20 | 15.78 |
| `median`, n = 20 | 302.10 | 279.53 | 0 of 20 | 6.41 |
| `clipped`, `clipScale: "pixel"` (P-07), n = 20 | 360.96 | 305.43 | 0 of 20 | 16.09 |

### P-07: clipping against each pixel's own spread (tried, not adopted)

(All numbers in this subsection are on the frames as they are, `normalise: "off"`.)

`clipScale: "pixel"` widens the clipping scale to the pixel's own spread across images
(1.4826 × MAD) when that is larger than the frame noise: real brightness changes widen the
spread, a single spike does not. Same rule for every object, threshold unchanged (5). Result,
best motion vs catalogue (`numbers.test.ts`, "P-07 experiment"):

| | Default (`frame`) | `clipScale: "pixel"` | `median` |
| --- | --- | --- | --- |
| WISE 0855 | 0.94″/yr | **7.65″/yr** | 2.44″/yr |
| Barnard's Star | 1.12″/yr | **2.38″/yr** | 0.48″/yr |
| Epsilon Indi B | 1.00″/yr | **0.14″/yr** | 0.63″/yr |
| Control field, best score | 2.02 | 2.02 | |

It fixes eps Ind B but breaks P-02 for WISE 0855 (must be within 2″/yr) and moves Barnard off too,
so the default stays `frame`. Why: WISE 0855 and Barnard also change brightness with wavelength.
The frame-noise rule clipped their brightest images as well, which happened to even out the
weights. Keeping those few bright images lets them decide the best motion, and for WISE 0855 it
lands at (−10.57, +8.01). The median, the other rule-free option, puts WISE 0855 2.44″/yr off. Not tried: weighting images by their brightness, which would mean fitting weights to the
data. The cosmic-ray rejection is the same with both scales (`stack.test.ts`, 50σ spike).

## Field of view: the answer does not depend on the cube size (P-10, issue #100)

The site opens 6′ live cubes (121 px); the static demo cubes are 3′ (61 px, `data/cube.py`: `fov * 20 + 1`).
On Barnard's Star the same 60 frames gave (0.00, +11.81)″/yr, 1.66″/yr off Gaia, on the 3′ cube and
(−2.08, +5.44), 5.09″/yr off, on a 6′ one (issue #100, A-15). The middle 61 px of the 6′ cube are the 3′ cube; the
difference was that real pixels shifted into the stacking box from outside the 3′ field, where the 3′ cube has none.

Now the search uses only the middle 3′ of the cube (`GridOptions.field`, default `STATIC_FIELD_ARCMIN` = 3;
`grid.ts` `fieldWindow`, `stack.ts` `StackOptions.window`): samples from outside count as missing, stack pixels outside
are not computed. Any search centre inside the middle 3′ of a larger cube gives exactly what the same search gives on
the static cube; on the static cubes the field is the whole cube, so none of their numbers changed. A centre outside the
middle 3′ (a click far out on a wide cube) gets a 3′ field around itself. `field: Infinity` is the search before P-10.

`search/field.test.ts` puts the real Barnard D1 and WISE 0855 D6 cubes in the middle of a 121 × 121 cube whose outer
part is made-up noise (20× the frame noise) with a bright fake star just outside the 3′ field, and runs the viewer's
search (12″ radius, 90″ box). The whole score map, best motion and score equal the 3′ ones, also for a centre 45″ off;
with `field: Infinity` they do not.

| 121 px cube, viewer options (`npx vitest run search/field.test.ts --silent=false`) | Best motion, SNR | Time |
| --- | --- | --- |
| Barnard D1, 3′ cube | (0.00, +11.81), 2798.02 | |
| Barnard D1, 6′, now | identical | 1145 ms |
| Barnard D1, 6′, whole cube (before) | (0.00, +11.81), 2715.48: other scores | 1543 ms |
| WISE 0855 D6, 3′ cube | (−8.68, +0.20), 20.45 | |
| WISE 0855 D6, 6′, now | identical | 1007 ms |
| WISE 0855 D6, 6′, whole cube (before) | (−7.79, +0.72), 20.39 | 1198 ms |

The 6′ search got a little faster (fewer pixels are sampled). The window does **not** cure the small margin on a saturated star: on
Barnard's Star the right motion beats "not moving" by 4 % (2798.02 vs 2685.81, `results.json`), and leaving out 3 of
60 frames keeps the answer within 2″/yr in only 13 of 20 trials (issue #100). So the Search panel says so when the
centre carries `OVERFLOW` in most frames (`viewer/overlayData.ts` `isSaturatedCore`) and points to the Measure tab.
Option (c) of the issue, a score that does not hang on one pixel next to a hole, was not done: it moves every number.

## Combining detectors (P-06)

`stackMulti(cubes, pmRa, pmDec, refMjd)` and `velocityGridMulti(cubes, options)` put the frames of
several detectors (same centre, same 3″ grid) into one stack:

- **Weights 1/noise²** per frame (inverse variance), from the noise only. Not from the object's
  expected spectrum, and never fitted to the data being searched: weights chosen from the same
  data chase the noise and inflate the SNR.
- **Clipping inside each detector** (frame-noise rule of `stack.ts`). Across detectors, a source
  bright in D6 and dark in D1 would look like an outlier and lose its real light (the P-07 lesson).
- Cubes must share the grid (size, pixel scale, centre within 0.1 px), otherwise it throws.

**More data can lower the SNR.** With signal s in detector A and none in detector B, at equal
noise and frame count, the combined SNR is (s·N) / √(2N) = SNR_A / √2. The empty detector adds only
noise. So combining helps only where the object is bright in every detector used; for WISE 0855,
a very cold brown dwarf seen only above 4 µm, that is D5 and D6 (measured below). Synthetic checks
(`stackMulti.test.ts`, mean of 6 noise realisations):

| Case | Theory | Test bound |
| --- | --- | --- |
| Equally bright in 2 detectors | × √2 = 1.41 | 1.25–1.6 |
| Bright in 1 detector, other empty | × 1/√2 = 0.71 (worse than alone) | 0.55–0.85, and below 1 for every realisation |
| Equally bright, second detector 3× noisier, weighted | × √(1 + 1/9) = 1.05 | 0.95–1.2 |
| Same, plain unweighted mean | × 2/√10 = 0.63 | below 0.8 |

**Weighting alone, one real detector** (`stackMulti.test.ts`, runs now; the unweighted side is
`velocityGrid(cube, { normalise: "off" })`, since `stackMulti` does not use the A-13 common
brightness). `stackMulti` also weights
frames within one detector, which `stack()` does not; frame noise varies up to 24× within a cube
(eps Ind B D2, 0.0155–0.3781). The weighted search scores higher, as inverse variance should, but its
best motion lands further from the catalogue: the low-noise frames get more say, and they need
not be spread evenly in time.

| Detector | Score, unweighted → weighted | Best motion off catalogue, unweighted → weighted |
| --- | --- | --- |
| WISE 0855 D6 | 20.96 → 24.21 | 0.94 → 1.56″/yr |
| Barnard's Star D1 | 838 → 1222 | 1.12 → 2.22″/yr |
| Epsilon Indi B D2 | 78.4 → 84.0 | 1.00 → 1.27″/yr |

So the single-detector search (`velocityGrid`, used by the site) stays unweighted. A combined
result is compared with the same detector run through `velocityGridMulti([cube])`, so both sides
use the same weighting.

### On the real six-detector cubes (P-09, 11/15)

`npx vitest run search/stackMulti.test.ts --silent=false` (~1 min), on role A's D1–D6 cubes
(A-08). The numbers are in `results.json` → `multi`, and the test fails if they change. "Alone" is
one detector through the same weighted stacking; "site" is the search the site runs
(`velocityGrid`, `results.json` → `objects`). Off = best motion's distance from the catalogue.

| WISE 0855 | Images | Score | Zero motion | Best motion ″/yr | Off ″/yr | Brightest pixel |
| --- | --- | --- | --- | --- | --- | --- |
| D6, site (unweighted) | 45 | 20.96 | 18.74 | (−8.68, +0.20) | 0.94 | |
| D6 alone | 45 | 24.21 | 20.99 | (−8.83, −0.49) | 1.56 | 3″ W |
| D5 alone | 48 | 23.25 | 19.47 | (−8.66, +1.06) | 0.73 | 3″ W |
| **D5+D6** | 93 | **28.62** | 24.17 | (−8.75, +1.58) | **1.10** | 3″ W |
| D1–D4 (without D5, D6) | 165 | 57.25 | 54.42 | (+0.31, −1.36) | 8.56 | 6″ W, 3″ N |
| **D1–D6** | 258 | **55.00** | 51.27 | (+0.12, −1.59) | **8.44** | 6″ W, 3″ N |

| Epsilon Indi B | Images | Score | Zero motion | Best motion ″/yr | Off ″/yr |
| --- | --- | --- | --- | --- | --- |
| D2, site (common brightness, A-13) | 93 | 267.49 | 229.16 | (+3.82, −2.33) | 0.26 |
| D2 alone | 93 | 83.97 | 72.83 | (+3.08, −3.44) | 1.27 |
| D5 alone | 84 | 335.88 | 184.70 | (+3.05, −4.67) | 2.32 |
| **D1–D6** | 457 | **114.35** | 78.25 | (+4.85, −2.36) | **0.90** |

**A higher score is not a more correct motion.**

- **WISE 0855, D5+D6: combining helps.** WISE 0855 is seen in D5 and D6 at about the same level
  (23.25 and 24.21), and together they score 28.62 (×1.18 over D6 alone; two equal, independent
  detectors would give at most ×√2). The best motion stays on the target, 1.10″/yr from CatWISE2020.
  The offsets (0.73, 1.10, 1.56, and the site's 0.94) are all well under one grid step (2.93) and
  differ by less than one, so they do not rank the searches by accuracy: the test only requires
  that D5+D6 is no further off than D6 alone.
- **WISE 0855, D1–D6: the score doubles and the answer is wrong.** The 55.00 is not WISE 0855.
  D1–D4 show a star 8.2″ away (7.9″ W, 2.2″ N; Gaia DR3 5756956644387831296, G = 16.3; role A's
  `spectrum.json` → `neighbour`, issue #75), which is inside the 12″ search radius, and WISE 0855
  is too cold to be seen below 4 µm. Checked three ways (`stackMulti.test.ts`): (1) the brightest
  pixel of the D1–D6 stack is 6″ W, 3″ N of the centre, 2.1″ from that star (under one 3″ pixel),
  while D5+D6 peaks 3″ W, on the target; (2) D1–D4 **without** D5 and D6 give the same pixel and
  nearly the same motion, with a slightly higher score (57.25); (3) the best motion, (+0.12, −1.59),
  is under one grid step from zero: a star that does not move. So the search did what it is built
  to do, find the best-stacking source within 12″; with six detectors that source is the neighbour.
  Adding D5 and D6 even lowers the neighbour's score (57.25 → 55.00): there it is fainter than the
  target (the D5+D6 stack peaks on the target). That is the "more data can lower the SNR" case
  above, on real data.
- **Epsilon Indi B, D1–D6: worse than the site's one-detector search**, in score (114.35 against
  267.49) and in motion (0.90 against 0.26″/yr), and below D5 alone in score (335.88, whose own
  best motion is 2.32″/yr off). `stackMulti` stacks the images as they are, with the frame-noise
  clip; for a target this bright that is the stacking A-13 replaced, because the clip removes the
  star's own light (4 of 93 samples kept in D2, see above). On D2 the common-brightness rule is
  the difference between 78.4 / 1.00″/yr and 267.5 / 0.26″/yr.

**Limits, not fixed here:** `stackMulti` has no common-brightness rule (A-13), so it is not for
targets bright enough to show in single images; and a combined search takes whatever stacks best
within 12″ in *any* detector, so a neighbour that is bright at other wavelengths wins. Adding the
rule to `stackMulti` was left out on purpose (too close to the code freeze).

### D5+D6 for WISE 0855: shuffle test and blank sky

Opt-in, ~5 min: `P09_SHUFFLES=100 npx vitest run search/stackMulti.test.ts -t "shuffle test" --silent=false`.
Each detector's images keep their own dates, handed out at random within that detector.

| | Best moving cell | Zero motion | 100 shuffles | Verdict |
| --- | --- | --- | --- | --- |
| D5+D6 | 28.62 | 24.17 | 0 reach it (max 26.36), p = 1/101 < 1% | `detected` |
| D6 alone (weighted) | 24.21 | 20.99 | 0 reach it (max 22.87), p = 1/101 < 1% | `detected` |

The margin over the best shuffle is 2.26 with D5+D6 and 1.34 with D6 alone (0.50 in the site's
D6 search: 20.96 against 20.46 in 500 shuffles).

Blank sky, D5+D6, the 8 regions 45″ from the target that `numbers.test.ts` uses for D6: 3.97, 3.01,
2.57, 2.91, **8.80**, 4.29, 3.71, 2.44. Seven stay below 5. The fifth is not blank in D5: its peak
is on a catalogued star (CatWISE2020 J085502.97−071341.9, W2 = 15.6, also in Gaia DR3; role A's
`catalog.json`), so that is a source found, not a false alarm; in the site's D6 search the same
region stays below 5. **There is no D5 cube of the
control field**, so D5+D6 could not be run on a field chosen to be empty; the control's D6 cube
through the weighted stacking scores 1.89 (`none`; 2.02 unweighted).

**In the site: "Combine D5 + D6" in the Search panel** (`viewer/Search.tsx`, 11/15). Added because
all three conditions set for it hold: D5+D6 beats D6 alone in score and is no further from the
catalogue, it is `detected` in 100 shuffles, and the control stays `none`. What it does and does not:

- Offered on a static D5 or D6 cube, and only where single images do not show the target (the
  A-13 test, `brightnessScale` returns null, for both detectors): `stackMulti` has no
  common-brightness rule, so it is not for bright targets. D1–D6 is not offered (see above).
- It calls `velocityGridMulti` on the page's own thread: `run.ts` and the worker take one cube.
  Measured in the browser on WISE 0855: one pause of 1.5 s, result as in the table (28.6, 1.1″/yr
  from the catalogue), the same from the D5 and the D6 view.
- The shuffle test is not run in the browser for the pair (100 more searches on the page's thread).
  The panel shows the run recorded in `results.json` → `multi.shuffles`, and only when the search
  on screen is the one that run tested (same object, default centre, same score); anywhere else it
  says to untick the box and test one detector.
- Not done: a worker for several cubes (`run.ts`, `grid.worker.ts`), which would remove the pause
  and allow the live shuffle test; a D5 cube of the control field (role A).

## Runtime

One search on a 61×61×45 cube is ~0.7–1.3 s. `falseAlarm(cube, n)` runs n + 1 searches, so run it
in a Web Worker (P-04) and keep n small in the UI, or show the precomputed numbers above.
