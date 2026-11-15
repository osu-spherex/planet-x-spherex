# How the search works

SPHEREx images each patch of sky a few dozen times in a year. A faint mover can be lost in every
single image; the search tries every plausible motion and asks which one makes the images add up.
Code: `frontend/search/`, running in the browser. Each number names the test that produces it
(in `frontend/search/`); commands at the end.

**1. Shift and stack.** Shift each image back by where a guessed motion would have carried the
object, then average. With the right motion the object lands on one pixel in every image: its
signal adds up N times, random noise only √N times, so the signal-to-noise ratio (SNR) grows by
about √N. A wrong motion smears it out. Synthetic test with 16 images: right motion 0.75–1.25 × √16,
no motion under 2× [`stack.test.ts`]. Cosmic rays are dropped first (> 5σ from a pixel's median).

**2. Try every motion.** Up to ±15″/yr in RA and Dec, in steps of pixel / time span: two motions Δv
apart separate the object by Δv × T, so below one pixel (3″) the stacks look the same. WISE 0855:
1.01 yr, step 2.96″/yr, 121 motions, 0.7 s; Epsilon Indi B: 1.44 yr, step 2.08″/yr, 225 motions,
4.2 s [`numbers.test.ts`]. **Score** = highest SNR within 12″ of the search centre. **Best motion** =
top of a smooth surface fitted to the scores around the best cell.

**3. Is anything there?** 121 motions × ~50 pixels give ~6000 chances for noise to look like a
star (look-elsewhere effect), so empty sky scores well above "3σ": 2.32–4.05 in 8 regions 45″ from
WISE 0855, 1.45–3.51 on a control field 215″ away in the same 45 exposures [`numbers.test.ts`].
Below **5** we say "nothing found".

**4. Does it move?** A star that does not move stacks well too, and a slow mover almost as well
without any shift (WISE 0855: 18.74 with zero motion, 20.96 at best). Only the order of the dates
carries motion, so we shuffle which date belongs to which image and search again, n times.
**p** = share of shuffles scoring as high as the real order, (1 + k) / (n + 1). Zero motion scores
the same in every shuffle, so it is left out of that comparison and reported beside it. "Motion
detected" needs p < 1% **and** a best motion that beats zero motion; otherwise only "consistent
with". On pure noise p is uniform; a faint synthetic mover gets p = 1/101; a synthetic star that
does not move is never called moving [`significance.test.ts`].

**5. Results** [`numbers.test.ts`; WISE shuffles: `significance.test.ts`]

| Object (band, images, span) | Best motion ″/yr | Catalogue ″/yr | Off | SNR best cell / zero | Shuffles | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| WISE 0855 (D6, 45, 1.01 yr) | (−8.68, +0.20) | (−7.97, +0.81) CatWISE2020 | 0.94 | 20.96 / 18.74 | 0 of 500 reach it (max 20.46), p = 0.002 | detected |
| Barnard's Star (D1, 60, 1.02 yr) | (0.00, +11.81) | (−0.80, +10.36) Gaia DR3 | 1.66 | 2798 / 2686 | 0 of 100 reach it (max 2678), p = 1/101 < 1% | detected |
| Epsilon Indi B (D2, 93, 1.44 yr) | (+3.82, −2.33) | (+3.97, −2.54) Gaia DR3, eps Ind A | 0.26 | 267.5 / 229.2 | 0 of 100 reach it (max 229.3), p = 1/101 < 1% | detected |
| Teegarden's Star (D1, 55, 1.02 yr), a check | (+4.66, −3.96) | (+3.43, −3.81) Gaia DR3 | 1.24 | 10260 / 8424 | 0 of 100 reach it (max 8487), p = 1/101 < 1% | detected |
| Control field (D6, 45, 1.01 yr) | – | – | – | 2.02 | – | nothing found |

Motions are (RA·cos Dec, Dec). All movers land within 1.66″/yr of the catalogue, under one grid
step. **Bright targets are put on a common brightness first.** Each image sees the target at its
own wavelength, so a bright target changes brightness from image to image (Epsilon Indi B: peak
27σ to 1254σ). Stacked as they are, the cosmic-ray rule (drop samples > 5σ of frame noise from a
pixel's median) threw away its real light: 4 of 93 samples survived on the brightest pixel, and 6
of 100 shuffles then scored as high as the real order ("consistent"). So when more than half of
the images show the target by themselves (summed light around the search centre ≥ 5× its noise),
each image is divided by that sum before stacking. The sum uses neither the date nor the motion
tried, so the shuffle test is unchanged. One rule for every field, decided from the images alone:
Barnard, Epsilon Indi B and Teegarden's Star use it (every image shows them); WISE 0855 (10 of 45
images), the control field (0 of 45) and blank regions (0–7 of 45) are stacked exactly as before.
Teegarden's Star was added afterwards as a check and played no part in the design; two stars
that do not move (RW Aurigae, R Draconis) now score best at zero motion and stay "consistent". Barnard's
motion moved from 1.12 to 1.66″/yr off: its saturated core is missing, so the summed light is less
exact there. For a star this bright the direct measurement is the better number anyway (position
in every image, straight-line fit: Epsilon Indi B (+3.70 ± 0.27, −2.56 ± 0.26)″/yr, `measure.json`);
stacking is for targets no single image shows [`numbers.test.ts`, `search/README.md`].

**6. Limits**

- **One year, few visits**: motion is pinned to ~1″/yr; motions under one step (~3″/yr) are hard to
  tell from none.
- **6.16″ native pixels** (resampled to 3″): WISE 0855 moves ~8″ in the year, little more than one
  native pixel, hence the small margins (zero motion 18.74, best shuffle 20.46, real 20.96).
- **No parallax**: WISE 0855's is 0.449″ (Luhman & Esplin 2016, https://arxiv.org/abs/1605.06655),
  under a sixth of a pixel.
- **Interpolation** lowers the noise of shifted stacks ~3% (WISE 0855: 0.00802 unshifted, 0.00775
  at the catalogue motion [`numbers.test.ts`]). Shuffles share it, so p is unaffected.
- **Scope**: straight-line motions up to 15″/yr within 12″ of where you look, i.e. nearby faint
  movers such as brown dwarfs. A planet a few hundred AU away shifts by arcminutes over the year
  from Earth's orbit (206265″ / distance in AU, ~400″ at 500 AU), outside this grid and not in a
  straight line: a planet search needs a parallax-aware grid.
- A star that does not move but brightens or fades with the date can favour the real order; the
  "beats zero motion" rule guards against most of that.
- **One detector per search**: stacking several detectors at once (images weighted by 1/noise²)
  was run on the real cubes; the table above is one detector each, and the site offers only D5+D6,
  for faint targets. WISE 0855: D5+D6 score 28.62 against 24.21 for D6 alone (1.10 and 1.56″/yr
  off; 0 of 100 shuffles reach either), but D1–D6 score 55.00 at 8.44″/yr off, locked onto a star
  8.2″ away that D1–D4 show instead of the target; Epsilon Indi B: D1–D6 114.35 at 0.90″/yr off,
  worse than the one-detector 267.5 at 0.26 (combining has no common-brightness rule yet). A higher
  score is not a more correct motion [`stackMulti.test.ts`, `search/README.md`].

**Reproduce** (in `frontend/`): `npx vitest run search/numbers.test.ts` (table, ~30 s);
`P05_SHUFFLES=100 npx vitest run search/numbers.test.ts` (adds the Barnard, eps Ind B and Teegarden shuffle tests, ~25 min);
`P03_SHUFFLES=500 npx vitest run search/significance.test.ts -t "WISE 0855"` (WISE shuffles, ~6 min).
The same numbers are in `frontend/search/results.json`, which the site's "How it works" page (`/method`) shows and the
tests above check. Reporting rule and details: `frontend/search/README.md`.
