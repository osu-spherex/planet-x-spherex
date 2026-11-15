// /method: "How it works" for judges and curious visitors (role P, task P-08). Static, English,
// no team member names. Numbers are never typed into this file:
//   * search results come from search/results.json, which search/numbers.test.ts (and the opt-in
//     shuffle runs) recompute and compare, so a stale number fails the tests;
//   * measurements come from the shipped measure.json files (./measurements.ts), read at build time;
//   * thresholds come from the code itself (search/significance.ts).
// The longer write-up is docs/METHOD_SEARCH.md; "How AI was used" says what docs/SUBMISSION.md
// ("Use of AI") says.

import type { Metadata } from "next";
import Link from "next/link";
import { DEMO_OBJECTS } from "@/lib/objects";
import results from "@/search/results.json";
import { DETECT_SNR, MOTION_ALPHA } from "@/search/significance";
import { FRAME_DETECT_SNR } from "@/search/stack";
import { readMeasurements, type Measurement } from "./measurements";
import styles from "./method.module.css";

export const metadata: Metadata = {
  title: "How it works · Planet X & SPHEREx",
  description:
    "How the tool finds moving and changing objects in SPHEREx images, what it measured on the five challenge objects, the data it uses and how AI was used.",
};

// Read once at module scope, during the build (static page).
const MEASUREMENTS: Measurement[] = readMeasurements();

const MINUS = "−";
/** Signed, with a real minus sign: +0.20, −8.68. */
const signed = (v: number, digits = 2) => `${v < 0 ? MINUS : "+"}${Math.abs(v).toFixed(digits)}`;
/** As given, with a real minus sign. */
const plain = (v: number) => `${v < 0 ? MINUS : ""}${Math.abs(v)}`;
const snr = (v: number) => (v >= 100 ? v.toFixed(0) : v.toFixed(2));
const nameOf = (id: string) => DEMO_OBJECTS.find((o) => o.id === id)?.name ?? id;
const catalogueOf = (id: string) => DEMO_OBJECTS.find((o) => o.id === id)?.catalogueMotion;

const VERDICT = {
  detected: { label: "Motion detected", className: styles.detected },
  consistent: { label: "Consistent with motion, not established", className: styles.consistent },
  none: { label: "Nothing found", className: styles.none },
} as const;

type Verdict = keyof typeof VERDICT;

function VerdictBadge({ kind }: { kind: string }) {
  const v = VERDICT[kind as Verdict] ?? VERDICT.none;
  return <span className={`${styles.verdict} ${v.className}`}>{v.label}</span>;
}

function SearchCards() {
  const c = results.control;
  return (
    <div className={styles.cards}>
      {results.objects.map((r) => {
        const cat = catalogueOf(r.id);
        const s = r.shuffles;
        return (
          <article key={r.id} className={styles.card}>
            <h4>{nameOf(r.id)}</h4>
            <p className={styles.cardSub}>
              {r.band} · {r.frames} images over {r.years} yr · {r.motions} motions tried
            </p>
            <dl className={styles.facts}>
              <dt>Best motion</dt>
              <dd>
                ({signed(r.best.pmRa)}, {signed(r.best.pmDec)})″/yr
              </dd>
              {cat && (
                <>
                  <dt>Catalogue</dt>
                  <dd>
                    ({plain(cat.pmRa)}, {plain(cat.pmDec)})″/yr, {cat.source}
                  </dd>
                </>
              )}
              <dt>Off by</dt>
              <dd>
                {r.off.toFixed(2)}″/yr (grid step {r.step.toFixed(2)})
              </dd>
              <dt>Score</dt>
              <dd>
                {snr(r.snrBest)} best, {snr(r.snrZero)} with no motion
              </dd>
              <dt>Shuffles</dt>
              <dd>
                {s.nExceed} of {s.n} reach it (highest {snr(s.max)}), p = {s.p}
                {s.nExceed === 0 ? `, the smallest possible with ${s.n}` : ""}
              </dd>
            </dl>
            <VerdictBadge kind={r.verdict} />
          </article>
        );
      })}
      <article className={styles.card}>
        <h4>Control field</h4>
        <p className={styles.cardSub}>
          Empty sky near WISE 0855 · {c.band} · {c.frames} images
        </p>
        <dl className={styles.facts}>
          <dt>Score</dt>
          <dd>
            {snr(c.snrBest)} (below {results.detectSnr})
          </dd>
        </dl>
        <VerdictBadge kind={c.verdict} />
      </article>
    </div>
  );
}

function MeasurementCards() {
  return (
    <div className={styles.cards}>
      {MEASUREMENTS.map((m) => (
        <article key={m.id} className={styles.card}>
          <h4>{m.name}</h4>
          <p className={styles.cardSub}>
            {m.band} · position found in {m.imagesUsed} of {m.images} images
            {m.saturated ? " · core saturated" : ""}
          </p>
          <dl className={styles.facts}>
            {m.motion && (
              <>
                <dt>Motion</dt>
                <dd>
                  ({signed(m.motion.pmRa)} ± {m.motion.errRa.toFixed(2)}, {signed(m.motion.pmDec)} ±{" "}
                  {m.motion.errDec.toFixed(2)})″/yr
                </dd>
              </>
            )}
            {m.catalogue && (
              <>
                <dt>Catalogue</dt>
                <dd>
                  ({plain(m.catalogue.pmRa)}, {plain(m.catalogue.pmDec)})″/yr
                </dd>
              </>
            )}
            <dt>Brightness</dt>
            <dd>
              {m.photometryMethod === "wing" ? "wing" : "aperture"} ({m.photometryUnit})
            </dd>
            {m.brightness && (
              <>
                <dt>Changes</dt>
                <dd>
                  {m.brightness.factor.toFixed(1)}× between faintest and brightest visit at{" "}
                  {m.brightness.lamMin.toFixed(2)}–{m.brightness.lamMax.toFixed(2)} µm
                </dd>
              </>
            )}
          </dl>
          {m.motion &&
            (m.motion.confirmed ? (
              <span className={`${styles.verdict} ${styles.detected}`}>Motion measured</span>
            ) : (
              <>
                <span className={`${styles.verdict} ${styles.consistent}`}>Motion not confirmed</span>
                <p className={styles.note}>{m.motion.note}</p>
              </>
            ))}
        </article>
      ))}
    </div>
  );
}

export default function MethodPage() {
  const wise = results.objects.find((o) => o.id === "wise0855")!;
  const eps = results.objects.find((o) => o.id === "epsindb")!;
  const barnard = results.objects.find((o) => o.id === "barnard")!;
  // e: the search as it was before task A-13 (why Epsilon Indi B used to be only "consistent").
  const e = results.epsIndB;
  const before = e.before;
  const seen = results.framesSeen;
  const check = results.check;
  // Several detectors in one stack (task P-09): results.json "multi", recomputed by search/stackMulti.test.ts.
  const multiRow = (id: string, bands: string) => results.multi.rows.find((m) => m.id === id && m.bands.join("+") === bands)!;
  const wise6 = multiRow("wise0855", "D6");
  const wise56 = multiRow("wise0855", "D5+D6");
  const wiseAll = multiRow("wise0855", "D1+D2+D3+D4+D5+D6");
  const epsAll = multiRow("epsindb", "D1+D2+D3+D4+D5+D6");
  const neighbour = results.multi.neighbour.at;
  const motions = results.objects.map((o) => o.motions);
  const interpolationPct = ((1 - results.interpolation.catalogueMotion / results.interpolation.zeroMotion) * 100).toFixed(0);
  const aperture = MEASUREMENTS.find((m) => m.photometryMethod === "aperture");
  const wing = MEASUREMENTS.find((m) => m.photometryMethod === "wing");
  const binWidth = MEASUREMENTS.find((m) => m.binWidthUm !== null)?.binWidthUm;
  const positionMethods = [...new Set(MEASUREMENTS.map((m) => m.method))];
  const releases: Record<string, number> = {};
  for (const m of MEASUREMENTS) for (const [k, n] of Object.entries(m.releases)) releases[k] = (releases[k] ?? 0) + n;
  const totalImages = MEASUREMENTS.reduce((a, m) => a + m.images, 0);
  const earlier = Object.entries(releases)
    .filter(([k]) => k !== "dr1")
    .reduce((a, [, n]) => a + n, 0);

  return (
    <main className={styles.main}>
      <Link href="/" className={styles.back}>
        ← Back to the tool
      </Link>
      <header>
        <h1 className={styles.title}>How it works</h1>
        <p className={styles.lead}>
          What the tool does with SPHEREx images, what it found on the five challenge objects, where the data come
          from, and how AI was used. The numbers on this page are read, when the site is built, from the same result
          files the tool uses; automated tests recompute the search results and fail if a file is out of date.
        </p>
        <ul className={styles.toc} aria-label="On this page">
          <li>
            <a href="#search">1. Finding faint movers</a>
          </li>
          <li>
            <a href="#measure">2. Position and brightness</a>
          </li>
          <li>
            <a href="#data">3. Data and credits</a>
          </li>
          <li>
            <a href="#ai">4. How AI was used</a>
          </li>
        </ul>
      </header>

      <section id="search" className={styles.section} aria-labelledby="search-h">
        <h2 id="search-h">1. Finding faint objects that move</h2>
        <h3>Shift and stack</h3>
        <p>
          SPHEREx photographs each patch of sky a few dozen times a year. A faint object can be lost in the noise of
          every single image. If we knew how it moves, we could shift each image back by the distance it travelled
          and average the images: the object then lands on the same pixel every time, so its light adds up N times
          while random noise grows only like √N. The signal-to-noise ratio (SNR) grows by about √N. A wrong motion
          smears the object out instead.
        </p>
        <h3>Try every motion</h3>
        <p>
          We do not know the motion, so the tool tries a grid of motions up to ±{results.pmMax}″/yr east-west and
          north-south ({Math.min(...motions)}–{Math.max(...motions)} motions here). The step is one pixel divided by
          the time span: two motions closer than that move the object by less than a pixel and give the same stack.
          Each stack gets a score: its highest SNR close to the position you asked for. It runs in your browser.
        </p>
        <h3>Is anything there?</h3>
        <p>
          With that many motions and pixels, noise alone gets thousands of chances to look like a star (the
          look-elsewhere effect). So empty sky scores well above the usual “3σ”: {results.blank.nearWise.min.toFixed(2)}–
          {results.blank.nearWise.max.toFixed(2)} in {results.blank.nearWise.regions} empty regions next to WISE 0855,{" "}
          {results.blank.control.min.toFixed(2)}–{results.blank.control.max.toFixed(2)} on a control field of empty sky.
          A score below {DETECT_SNR} means “nothing found”.
        </p>
        <h3>Does it move? The shuffle test</h3>
        <p>
          A star that does not move stacks well too, and a slow mover stacks almost as well with no shift at all. Only
          the dates carry the motion. So the tool shuffles which date belongs to which image and runs the whole search
          again, many times. If the real dates beat almost every shuffle, the motion is unlikely to be luck:
          <span className={styles.formula}>p = (1 + shuffles scoring as high) / (shuffles + 1)</span>
          We say “motion
          detected” only when p &lt; {MOTION_ALPHA} <em>and</em> the best motion beats no motion; otherwise “consistent
          with motion”.
        </p>
        <h3>Results on the challenge objects</h3>
        <p className={styles.muted}>Motions are (east, north) in arcseconds per year; east includes cos(Dec).</p>
        <SearchCards />
        <h3>Bright objects whose brightness changes between images</h3>
        <p>
          Each SPHEREx image sees an object at its own wavelength, so a bright object changes brightness from image
          to image: Epsilon Indi B stands {e.peakOverNoise.min}σ above the noise in one image and{" "}
          {e.peakOverNoise.max}σ in another. With the images stacked as they were, the rule that removes cosmic rays (drop values far
          from a pixel&apos;s median) removed the star itself: on its brightest pixel {e.clipKeeps.kept} of{" "}
          {e.clipKeeps.of} images were kept. We measured that before changing anything.
        </p>
        <p>
          So when more than half of the images show the target by themselves (its summed light around the position
          you asked for is at least {FRAME_DETECT_SNR} times the noise of that sum), each image is first divided by
          the target&apos;s brightness in it. Otherwise the images are stacked exactly as before: that is the case for
          WISE 0855 ({seen.wise0855.seen} of {seen.wise0855.of} images show it) and the empty control field (
          {seen.control.seen} of {seen.control.of}). The brightness uses neither the dates nor the motion tried, so
          the shuffle test stays fair, and it is one rule for every object.
        </p>
        <ul>
          <li>
            <strong>Epsilon Indi B.</strong> Before: best motion {before.off.toFixed(2)}″/yr from the catalogue,{" "}
            {before.shuffles.nExceed} of {before.shuffles.n} shuffles reached its score, “consistent with motion”.
            Now: {eps.off.toFixed(2)}″/yr, {eps.shuffles.nExceed} of {eps.shuffles.n} shuffles reach it (
            {snr(eps.snrBest)} against {snr(eps.shuffles.max)} for the best shuffle), “motion detected”.
          </li>
          <li>
            <strong>Barnard&apos;s Star.</strong> Detected before and now, but its best motion went from{" "}
            {results.barnard.before.off.toFixed(2)} to {barnard.off.toFixed(2)}″/yr from the catalogue (grid step{" "}
            {barnard.step.toFixed(2)}). Its saturated core is missing from the images, so its summed brightness is
            less exact.
          </li>
          <li>
            <strong>A check.</strong> Teegarden&apos;s Star ({check.band}, {check.frames} images) played no part in
            designing the rule. Best motion ({signed(check.best.pmRa)}, {signed(check.best.pmDec)})″/yr against Gaia
            DR3 ({signed(check.catalogue.pmRa)}, {signed(check.catalogue.pmDec)}): {check.off.toFixed(2)}″/yr off,{" "}
            {check.shuffles.nExceed} of {check.shuffles.n} shuffles reach its score.
          </li>
        </ul>
        <p>
          For objects this bright the direct measurement in section 2 is the more precise number; stacking is for
          objects that no single image shows.
        </p>
        <h3>Limits</h3>
        <ul>
          <li>
            <strong>Straight lines up to ±{results.pmMax}″/yr</strong>, close to where you look: nearby faint movers
            such as brown dwarfs. A distant planet traces a yearly loop on the sky as Earth goes around the Sun
            (parallax), far larger than this grid: <strong>a planet needs a parallax-aware search</strong>.
          </li>
          <li>
            <strong>About one year of data and large pixels.</strong> WISE 0855 moves little more than one SPHEREx
            pixel in that time, so its margins are small: {snr(wise.snrZero)} with no motion, {snr(wise.shuffles.max)}{" "}
            for the best shuffle, {snr(wise.snrBest)} for the real dates.
          </li>
          <li>
            <strong>No parallax correction</strong> in the motion grid.
          </li>
          <li>
            <strong>Interpolation</strong> lowers the noise of shifted stacks by about {interpolationPct}% (WISE 0855).
            The shuffles are shifted too, so p is not affected.
          </li>
          <li>
            <strong>One detector per search.</strong> SPHEREx has six detectors (D1–D6), each for its own
            wavelengths. Stacking several at once, each image weighted by its noise, was run on the real images; in
            the tool only {wise56.bands.join(" + ")} can be combined, and only for targets too faint for single
            images. WISE 0855: {wise56.bands.join(" + ")} score {snr(wise56.snrBest)} against{" "}
            {snr(wise6.snrBest)} for {wise6.bands[0]} alone, with best motions {wise56.off.toFixed(2)} and{" "}
            {wise6.off.toFixed(2)}″/yr from the catalogue (both under one grid step; the site&apos;s own{" "}
            {wise.band} search, unweighted: {snr(wise.snrBest)}, {wise.off.toFixed(2)}″/yr). All six score{" "}
            {snr(wiseAll.snrBest)}, but {wiseAll.off.toFixed(2)}″/yr from the catalogue: {neighbour.bands[0]}–
            {neighbour.bands[neighbour.bands.length - 1]} show a neighbouring star {neighbour.sep.toFixed(1)}″ away
            instead of WISE 0855, and the stack locks onto that star, which does not move.{" "}
            <strong>A higher score is not a more correct motion.</strong> Epsilon Indi B: all six score{" "}
            {snr(epsAll.snrBest)}, {epsAll.off.toFixed(2)}″/yr off, against {snr(eps.snrBest)} and{" "}
            {eps.off.toFixed(2)}″/yr for the one-detector search above: combining does not yet put the images on a
            common brightness.
          </li>
        </ul>
      </section>

      <section id="measure" className={styles.section} aria-labelledby="measure-h">
        <h2 id="measure-h">2. Measuring position and brightness</h2>
        <p>
          Measurements are made on the original SPHEREx cutouts, not on the resampled pictures you see, because
          resampling smooths the pixels and would bias a position.
        </p>
        <h3>Position</h3>
        <p>
          Method: {positionMethods.join("; ")}. A model of the star&apos;s image is fitted to the valid pixels of each
          image, and that image&apos;s own sky coordinates turn the fit into a position on the sky. Positions are
          combined per visit with a median; the motion is the straight line through the visits. A fit is used rather
          than a simple centroid because the cores of bright stars are often masked. Where the data cannot support a
          motion, the tool says “not confirmed” and why.
        </p>
        <h3>Brightness</h3>
        <ul>
          {aperture && (
            <li>
              <strong>Aperture</strong>, for ordinary stars: {aperture.photometryNote} ({aperture.photometryUnit}).
            </li>
          )}
          {wing && (
            <li>
              <strong>Wing</strong>, for saturated stars whose core pixels are missing: {wing.photometryNote} (
              {wing.photometryUnit}).
            </li>
          )}
        </ul>
        <p>One method per object, so all points of its light curve are comparable.</p>
        <h3>Matching the wavelength</h3>
        <p>
          SPHEREx&apos;s filter changes wavelength across the detector, so each image sees an object at its own
          wavelength. A difference between two images is a change in time only if the wavelengths agree; otherwise it
          is the object&apos;s spectrum. Light curves therefore compare images only within wavelength bins{" "}
          {binWidth} µm wide. The same measurements plotted against wavelength give a spectrum for free.
        </p>
        <MeasurementCards />
      </section>

      <section id="data" className={styles.section} aria-labelledby="data-h">
        <h2 id="data-h">3. Data and credits</h2>
        <ul>
          <li>
            <strong>NASA SPHEREx</strong> Level 2 spectral images, from the{" "}
            <a href="https://irsa.ipac.caltech.edu/Missions/spherex.html">NASA/IPAC Infrared Science Archive (IRSA)</a>
            . The only images the tool uses. The five examples use {totalImages} images downloaded in advance (
            {releases.dr1 ?? 0} from Data Release 1, {earlier} from earlier quick releases) and are marked “from
            cache”; any other position is fetched from IRSA when you ask. No data are simulated; synthetic images
            appear only inside the automated tests that check the code.
            {/* Wording required by IRSA for work using SPHEREx data, quoted as given on
                https://irsa.ipac.caltech.edu/Missions/spherex.html (checked 2026-11-15, issue #116). */}
            <span className={styles.acknowledgement}>
              This publication makes use of data products from the Spectro-Photometer for the History of the
              Universe, Epoch of Reionization and Ices Explorer (SPHEREx), which is a joint project of the Jet
              Propulsion Laboratory and the California Institute of Technology, and is funded by the National
              Aeronautics and Space Administration. Mission paper:{" "}
              <a href="https://ui.adsabs.harvard.edu/abs/2026ApJ...999..139B/abstract">Bock et al. (2026)</a>.
            </span>
          </li>
          <li>
            <strong>Reference motions</strong> to check our results: ESA{" "}
            <a href="https://www.cosmos.esa.int/web/gaia/dr3">Gaia DR3</a> (Barnard&apos;s Star; Epsilon Indi A, whose
            motion Epsilon Indi B shares) and <a href="https://arxiv.org/abs/2012.13084">CatWISE2020</a> (Marocco et
            al. 2021, WISE 0855).
          </li>
          <li>
            <strong>Software</strong>, all open source: <a href="https://www.astropy.org">Astropy</a>,{" "}
            <a href="https://reproject.readthedocs.io">reproject</a>, astroquery, PyVO, NumPy, SciPy, FastAPI; Next.js
            and React for this site.
          </li>
          <li>
            The task and the five test objects: NASA Space Apps Challenge 2026,{" "}
            <a href="https://www.spaceappschallenge.org/2026/challenges/planet-x-and-spherex/">Planet X and SPHEREx</a>.
          </li>
        </ul>
      </section>

      <section id="ai" className={styles.section} aria-labelledby="ai-h">
        <h2 id="ai-h">4. How AI was used</h2>
        <p>
          We used <strong>Claude</strong>, the AI model made by Anthropic, throughout the project: the Claude Code
          programming assistant on each developer&apos;s computer, and a Claude project for planning.
        </p>
        <ul>
          <li>
            <strong>What the AI did.</strong> Most of the source code, the automated tests and the technical
            documentation, this page included, were written by Claude under the direction of team members. Claude also
            ran the first checks of the data, proposed the architecture, split the work into tasks and reviewed changes.
          </li>
          <li>
            <strong>What people did.</strong> Team members chose the challenge, set the priorities and made the design
            decisions, which are recorded with their reasons in the project. Every finished task has a human check: a
            team member looks at the result and must be able to explain it. Tests whose answers are known from outside
            sources, such as the catalogue motion of Barnard&apos;s Star, were fixed before the code was written and
            may only be changed by a person.
          </li>
          <li>
            <strong>How it is marked.</strong> Changes made with Claude carry a “Co-Authored-By: Claude” line in the
            project history, and the progress logs record which work an AI session did.
          </li>
          <li>
            <strong>What AI was not used for.</strong> No images, video, audio or voices were generated by AI. All
            astronomical data are real SPHEREx observations.
          </li>
        </ul>
      </section>

      <footer className={styles.footer}>
        Images: NASA SPHEREx Level 2 spectral images from the NASA/IPAC Infrared Science Archive (IRSA). Built by
        Team OSU for the NASA Space Apps Challenge 2026.
      </footer>
    </main>
  );
}
