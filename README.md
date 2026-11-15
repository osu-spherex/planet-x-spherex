# Watch the Sky Change

Team OSU's project for the [NASA Space Apps Challenge 2026](https://www.spaceappschallenge.org/2026/challenges/planet-x-and-spherex/),
challenge "Planet X and SPHEREx" (Ulaanbaatar local event).

**Try it:** https://osu-spherex.vercel.app (mirror: https://osu-spherex.onrender.com).
How it works, results and limits: https://osu-spherex.vercel.app/method

## What it does

NASA's SPHEREx telescope photographs the whole sky again and again. Anything that moves, or changes brightness,
leaves a trace in its images. This web tool lets anyone look for those traces in a browser:

- Type a sky position (RA, Dec) or pick one of the five challenge objects. The tool collects every SPHEREx image of
  that spot, lines them up on one grid and plays them in time order.
- **Compare visits** subtracts one visit from another, so a small shift becomes a dark-and-bright pair. A SPHEREx
  pixel is 6.16 arcseconds and the fastest star in the sky, Barnard's Star, moves about 10.4 arcseconds per year, so
  a film alone barely shows it.
- **Stack** adds the images along a chosen motion (shift-and-stack), so an object too faint for any single image can
  appear. **Search** tries a grid of motions and tests the best one against the same images with shuffled dates.
- **Measure** gives the motion in arcseconds per year and the brightness over time. Every SPHEREx image sees a source
  at a different wavelength, so brightness is compared only between images at matching wavelength; the same points
  plotted against wavelength give a spectrum.

The five challenge objects (Barnard's Star, WISE 0855−0714, Epsilon Indi B, RW Aurigae, R Draconis) are prepared in
advance and marked "from cache" on the site. Any other position is fetched from the archive when you ask.

## What is in this repository

| Folder | What |
| --- | --- |
| `data/` | Python pipeline: archive query, cutouts, alignment (`cube.py`), motion (`motion.py`), brightness (`photometry.py`), catalogues |
| `data/cubes/` | Ready-made image cubes and measurements of the example objects (real SPHEREx data) |
| `backend/` | FastAPI service: builds a cube for any position from IRSA, with retries and a disk cache |
| `frontend/` | Next.js site. `viewer/`: canvas viewer; `search/`: shift-and-stack and the motion search |
| `tests/`, `backend/tests/` | Python tests; the frontend tests sit next to the code (`*.test.ts`) |
| `experiments/` | Short scripts written before the event to check that the data were usable |
| `docs/` | Architecture and data format, comparison of data releases, method of the motion search |

Most of `docs/` and some comments are in Mongolian, the team's working language. Comments mention internal planning
files (`CLAUDE.md`, `tasks/`, `docs/DECISIONS.md`) that are not part of this public copy.

## Run it

Python 3.12 or newer and Node.js 22 or newer.

```bash
python -m venv .venv
.venv/Scripts/activate            # Windows; on macOS/Linux: source .venv/bin/activate
pip install -r backend/requirements.txt
python -m pytest backend/tests -q
python -m uvicorn backend.app:app --port 8000     # http://127.0.0.1:8000/health
```

```bash
cd frontend
cp .env.example .env.local        # points the site at the local backend
npm ci
npm test
npm run dev                       # http://localhost:3000
```

`npm run build` makes the production build. The five examples work without the backend: their cubes are copied from
`data/cubes/` into the site before every build.

`python -m pytest tests -q -m "not network"` runs the tests of the data pipeline without contacting the archive
(leave the `-m` option out to include the two tests that query IRSA). Tests that need the original SPHEREx cutouts
(about 3 GB, not in this repository) are skipped unless the cutouts have been downloaded with
`python experiments/prefetch_cache.py`. `docs/UPDATING.md` explains how to rebuild the cubes when the archive
publishes new data.

## Data and credits

- **NASA SPHEREx** Level 2 spectral images, from the
  [NASA/IPAC Infrared Science Archive (IRSA)](https://irsa.ipac.caltech.edu/Missions/spherex.html): the only images
  the tool uses, found with IRSA's TAP service and downloaded with its cutout service. No data are simulated;
  synthetic images appear only inside automated tests. `data/listings/` holds the list of images IRSA gave for the
  five examples on 14 November 2026; the site uses it, and says so, when IRSA's search does not answer.

  This publication makes use of data products from the Spectro-Photometer for the History of the Universe, Epoch of
  Reionization and Ices Explorer (SPHEREx), which is a joint project of the Jet Propulsion Laboratory and the
  California Institute of Technology, and is funded by the National Aeronautics and Space Administration.
- **ESA Gaia DR3** (https://www.cosmos.esa.int/web/gaia/dr3) and **CatWISE2020** (Marocco et al. 2021,
  https://arxiv.org/abs/2012.13084), both queried through IRSA: reference positions and proper motions used to check
  the results and to mark known moving objects. The Gaia parallaxes in `data/cubes/*/catalog.json` were taken from the
  ESA Gaia Archive (https://gea.esac.esa.int/archive/) on 15 November 2026, when IRSA's search was down.
- Spitzer astrometry of WISE 0855−0714, used to choose between duplicate CatWISE2020 entries: Kirkpatrick et al. 2021
  (https://arxiv.org/abs/2011.11616) and Luhman & Esplin 2016 (https://arxiv.org/abs/1605.06655). The 2MASS Point
  Source Catalog, through IRSA, for the 1999 position of Epsilon Indi B in `experiments/`.
- Software, all open source: [Astropy](https://www.astropy.org), [reproject](https://reproject.readthedocs.io),
  astroquery, PyVO, NumPy, SciPy, Matplotlib, FastAPI; Next.js, React, TypeScript and Vitest for the site, which
  loads the fonts Unbounded, IBM Plex Sans and IBM Plex Mono (SIL Open Font License).
- The task and the five test objects: NASA Space Apps Challenge 2026, "Planet X and SPHEREx".

## How AI was used

We used **Claude**, the AI model made by Anthropic, throughout the project: the Claude Code programming assistant on
each developer's computer, and a Claude project for planning.

- **What the AI did.** Most of the source code, the automated tests and the technical documentation in this
  repository, this README included, were written by Claude under the direction of team members. Claude also ran the
  first checks of the data, proposed the architecture, split the work into tasks and reviewed changes.
- **What people did.** Team members chose the challenge, set the priorities and made the design decisions. Every
  finished task had a human check: a team member looked at the result and had to be able to explain it. Tests whose
  answers are known from outside sources, such as the catalogue motion of Barnard's Star, were fixed before the code
  was written and may only be changed by a person.
- **How it is marked.** In the team's development repository, changes made with Claude carry a
  "Co-Authored-By: Claude" line. This public copy has no commit history, so the statement is made here instead: treat
  every source file in this repository as AI-assisted.
- **What AI was not used for.** No images, video, audio or voices were generated by AI. All astronomical data are
  real SPHEREx observations.

## About this copy

This is a snapshot of the team's private development repository at commit `c4773ef` (2026-11-15), published without
its commit history. Internal planning notes and progress logs, which name team members, are left out.

## License

The code is released under the [MIT License](LICENSE), copyright Team OSU. The files in `data/cubes/` are derived
from SPHEREx data served by IRSA; for their use, follow the terms and acknowledgements of the archive.
