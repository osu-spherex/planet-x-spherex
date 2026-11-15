"use client";

// Home page: pick one of the five challenge objects, or type any sky position, choose a
// detector and a field width, and look at the SPHEREx images in the viewer. The whole choice lives
// in the URL so a view can be shared or embedded (components/pageState.ts):
//   ?object=barnard                      one of the five objects, its prepared 3′ cube
//   ?object=barnard&band=D2&fov=6        the same field in another detector / width
//   ?ra=133.79513&dec=-7.24515&band=D6   any position (fetched by the backend, 6′ by default)
//   …&embed=1                            only the viewer, for an <iframe>

import { Suspense, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CubeView } from "@/components/CubeView";
import { readyNote, useStaticBands } from "@/components/staticCubes";
import { NearbyHint } from "@/components/NearbyHint";
import { ObjectStory } from "@/components/ObjectStory";
import { PositionForm } from "@/components/PositionForm";
import { ShareBar } from "@/components/ShareBar";
import { SiteFooter } from "@/components/SiteFooter";
import explorer from "@/components/explorer.module.css";
import { readState, staticCubeUrl, stateQuery, type PageState } from "@/components/pageState";
import { BANDS, BAND_RANGE_UM, FOVS, isBand, isFov, type Band, type Fov } from "@/lib/backend";
import { formatDegrees, formatSexagesimal, type SkyPosition } from "@/lib/coords";
import { startBand } from "@/lib/nearby";
import { DEMO_OBJECTS, cubeUrl, findDemoObject, type DemoObject } from "@/lib/objects";
import styles from "./page.module.css";

/** Arcseconds per arcminute: half of a fov-arcminute field is fov * 30″. */
const HALF_FIELD_ARCSEC_PER_ARCMIN = 30;

/** Remembers that the visitor closed the three steps (A-18). */
const GUIDE_KEY = "osu.guide.closed";
type GuideStep = "play" | "compare" | "stack";
const GUIDE_ORDER: GuideStep[] = ["play", "compare", "stack"];

/**
 * Three things to try, as one line above the viewer (A-18, 3b). A step is ticked when the visitor
 * does it and the next one lights up. Not a tour: nothing covers the page and nothing has to be
 * dismissed; the × hides the line for good (remembered in this browser).
 */
function Guide({
  done,
  onClose,
  onWise,
}: {
  done: Record<GuideStep, boolean>;
  onClose: () => void;
  onWise: () => void;
}) {
  const next = GUIDE_ORDER.find((s) => !done[s]);
  const cls = (s: GuideStep) =>
    done[s] ? `${styles.guideStep} ${styles.guideDone}` : s === next ? `${styles.guideStep} ${styles.guideNext}` : styles.guideStep;
  const mark = (s: GuideStep, n: number) => (
    <span className={styles.guideN} aria-hidden="true">
      {done[s] ? "✓" : n}
    </span>
  );
  return (
    <div className={styles.guide} role="note" aria-label="Three things to try">
      <ol className={styles.guideSteps}>
        <li className={cls("play")}>
          {mark("play", 1)} Press Play{done.play && <span className={styles.srOnly}> (done)</span>}
        </li>
        <li className={cls("compare")}>
          {mark("compare", 2)} Open Compare visits{done.compare && <span className={styles.srOnly}> (done)</span>}
        </li>
        <li className={cls("stack")}>
          {mark("stack", 3)} Try Stack on{" "}
          <button type="button" className={styles.guideLink} onClick={onWise}>
            WISE 0855
          </button>
          {done.stack && <span className={styles.srOnly}> (done)</span>}
        </li>
      </ol>
      <button type="button" className={styles.guideClose} aria-label="Hide these three steps" onClick={onClose}>
        ×
      </button>
    </div>
  );
}

/** Lower and upper wavelength of a detector in micrometres, from the "0.74–1.11" strings of lib/backend.ts. */
function bandEdges(b: Band): [number, number] {
  const [lo, hi] = BAND_RANGE_UM[b].split("–").map(Number);
  return [lo, hi];
}

/**
 * The six SPHEREx detectors as one strip of infrared light from 0.75 to 5 µm (A-18): each part is as
 * wide as the detector's share of that range, the chosen one is lit, a click switches to it. It does
 * the same as the "Detector" list below the images, which stays.
 */
function BandStrip({ band, onPick }: { band: Band; onPick: (b: Band) => void }) {
  return (
    <div className={styles.bandsRow}>
      <div className={styles.bands} role="group" aria-label="SPHEREx detectors by wavelength">
        {BANDS.map((b) => {
          const [lo, hi] = bandEdges(b);
          return (
            <button
              key={b}
              type="button"
              className={b === band ? `${styles.band} ${styles.bandOn}` : styles.band}
              style={{ flexGrow: hi - lo }}
              aria-pressed={b === band}
              title={`Detector ${b}: ${BAND_RANGE_UM[b]} µm`}
              onClick={() => onPick(b)}
            >
              {b}
            </button>
          );
        })}
      </div>
      <p className={styles.bandNow}>
        infrared light, <span className={styles.num}>{BAND_RANGE_UM[band]} µm</span>
      </p>
    </div>
  );
}

/** One line under the name on an example card (A-18): how fast it moves, from the catalogue motion in lib/objects.ts. */
function cardLine(o: DemoObject): React.ReactNode {
  if (o.kind !== "moves") return "changes brightness";
  if (!o.catalogueMotion) return "moves";
  const speed = Math.round(Math.hypot(o.catalogueMotion.pmRa, o.catalogueMotion.pmDec));
  return (
    <>
      moves <span className={styles.num}>{speed}″</span> a year
    </>
  );
}

function Explorer() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const state = readState(params);
  const { custom, object, band, fov, embed } = state;
  const position: SkyPosition = custom ?? { ra: object!.ra, dec: object!.dec };
  const prepared = object !== null && band === object.band && fov === 3;
  // Detectors with a prepared 3′ cube (all six since A-08), for the "(ready)" marks and the note.
  const readyBands = useStaticBands(object?.id ?? null);
  const shareQuery = stateQuery({ ...state, embed: false });

  // The three steps: null until this browser's memory has been read, so nothing flashes for a
  // visitor who closed them. Reading and writing can fail (private mode): then they simply show.
  const [guideClosed, setGuideClosed] = useState<boolean | null>(null);
  const [guideDone, setGuideDone] = useState<Record<GuideStep, boolean>>({ play: false, compare: false, stack: false });
  useEffect(() => {
    let closed = false;
    try {
      closed = window.localStorage.getItem(GUIDE_KEY) === "1";
    } catch {
      closed = false;
    }
    setGuideClosed(closed);
  }, []);
  const closeGuide = () => {
    setGuideClosed(true);
    try {
      window.localStorage.setItem(GUIDE_KEY, "1");
    } catch {
      // not remembered; it is hidden for this visit
    }
  };
  // What the visitor pressed inside the viewer, read from the click itself: the viewer is not changed for this.
  const noteViewerClick = (e: React.MouseEvent) => {
    const button = (e.target as HTMLElement).closest("button");
    if (!button) return;
    const name = (button.textContent ?? "").trim();
    const tab = button.getAttribute("role") === "tab";
    const step: GuideStep | null =
      !tab && name === "Play"
        ? "play"
        : tab && name === "Compare visits"
          ? "compare"
          : tab && name === "Stack" && object?.id === "wise0855"
            ? "stack"
            : null;
    if (step && !guideDone[step]) setGuideDone({ ...guideDone, [step]: true });
  };

  const go = (next: Partial<PageState>) => {
    const merged = { ...state, ...next };
    // Picking an object resets detector and width to its prepared view; a new typed position keeps
    // the detector and starts at 6′.
    if (next.object && !next.band) merged.band = (isBand(next.object.band) ? next.object.band : "D1") as Band;
    if (next.object && next.fov === undefined) merged.fov = 3;
    if (next.custom && next.fov === undefined && !state.custom) merged.fov = 6;
    if (next.object) merged.custom = null;
    router.replace(`${pathname}?${stateQuery(merged)}`, { scroll: false });
  };

  const cubeView = (
    <CubeView object={object} position={position} band={band} fov={fov} onBandChange={(b) => go({ band: b })} />
  );

  if (embed) {
    return (
      <>
        {cubeView}
        <p className={explorer.embedLink}>
          <a href={`${pathname}?${shareQuery}`} target="_blank" rel="noopener">
            Open on the full site ↗
          </a>
        </p>
      </>
    );
  }

  return (
    <>
      <BandStrip band={band} onPick={(b) => go({ band: b })} />

      <div className={styles.startRow}>
        <p className={styles.startLabel}>Start with an example</p>
        <a className={styles.startOther} href="#position">
          or type any sky position ↓
        </a>
      </div>
      <nav className={styles.objects} aria-label="Objects">
        {DEMO_OBJECTS.map((o) => (
          <button
            key={o.id}
            type="button"
            className={o.id === object?.id ? `${styles.object} ${styles.active}` : styles.object}
            aria-pressed={o.id === object?.id}
            onClick={() => go({ object: findDemoObject(o.id) })}
          >
            <span className={styles.objectName}>{o.name}</span>
            <span className={styles.objectKind}>{cardLine(o)}</span>
          </button>
        ))}
      </nav>

      {/* B-13 (#84): the images come first; explanations and choices follow below them. */}
      {custom && (
        <div className={styles.positionLine}>
          <p className={explorer.coords}>
            Your position: {formatSexagesimal(position)} · {formatDegrees(position)}
          </p>
          <NearbyHint
            position={position}
            halfWidthArcsec={fov * HALF_FIELD_ARCSEC_PER_ARCMIN}
            band={band}
            onOpen={(id) => go({ object: findDemoObject(id) })}
          />
        </div>
      )}

      {guideClosed === false && (
        <Guide done={guideDone} onClose={closeGuide} onWise={() => go({ object: findDemoObject("wise0855") })} />
      )}
      {guideClosed === null && <div className={styles.guideSpace} aria-hidden="true" />}

      {/* four thin corner marks around the viewer, like the frame of a photographic plate */}
      <div className={styles.viewerSlot} onClickCapture={noteViewerClick}>
        <span className={`${styles.tick} ${styles.tickTL}`} aria-hidden="true" />
        <span className={`${styles.tick} ${styles.tickTR}`} aria-hidden="true" />
        <span className={`${styles.tick} ${styles.tickBL}`} aria-hidden="true" />
        <span className={`${styles.tick} ${styles.tickBR}`} aria-hidden="true" />
        {cubeView}
      </div>

      <section className={styles.panel} id="position" aria-live="polite">
        {/* key: the field is refilled when another position arrives through the URL */}
        <PositionForm
          key={custom ? `${custom.ra},${custom.dec}` : "none"}
          current={custom}
          onSubmit={(p) => {
            // B-13 (#85): near one of the five objects, open the detector where it is seen (WISE 0855 → D6)
            // instead of carrying over the previous one; elsewhere keep the visitor's detector.
            const nextFov = state.custom ? fov : 6;
            const b = startBand(p, { halfWidthArcsec: nextFov * HALF_FIELD_ARCSEC_PER_ARCMIN });
            go({ custom: p, object: null, ...(b && isBand(b) ? { band: b } : {}) });
          }}
        />

        {object ? (
          <>
            <h2 className={styles.heading}>{object.name}</h2>
            <p className={styles.blurb}>{object.blurb}</p>
            {prepared && <p className={styles.hint}>{object.hint}</p>}
          </>
        ) : (
          <p className={styles.hint}>
            Every SPHEREx image of this spot, in time order. Anything that moves or changes brightness between
            visits shows up in “Compare visits”.
          </p>
        )}

        <div className={explorer.choices}>
          <div className={explorer.detector}>
            <label htmlFor="detector">Detector</label>
            <select
              id="detector"
              className={explorer.select}
              value={band}
              onChange={(e) => isBand(e.target.value) && go({ band: e.target.value })}
            >
              {BANDS.map((b) => (
                <option key={b} value={b}>
                  {b} · {BAND_RANGE_UM[b]} µm{object && fov === 3 && readyBands?.includes(b) ? " (ready)" : ""}
                </option>
              ))}
            </select>
          </div>
          <div className={explorer.detector}>
            <label htmlFor="fov">Field</label>
            <select
              id="fov"
              className={explorer.select}
              value={fov}
              onChange={(e) => {
                const f = Number(e.target.value);
                if (isFov(f)) go({ fov: f as Fov });
              }}
            >
              {FOVS.map((f) => (
                <option key={f} value={f}>
                  {f}′ × {f}′{object && f === 3 ? " (ready)" : ""}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p className={explorer.detectorNote}>
          SPHEREx has six detectors, each for a different range of infrared light. A wider field shows more of the
          surroundings but takes longer to fetch.
          {object ? readyNote(object.name, readyBands, band, fov) : ""}
        </p>

        <ShareBar query={shareQuery} />

        {/* The story quotes numbers of the prepared cube, so it is shown only with that cube. */}
        {prepared && <ObjectStory objectId={object.id} band={band} cubeUrl={cubeUrl(object)} />}
      </section>

      <SiteFooter staticCubeUrl={object && fov === 3 ? staticCubeUrl(object.id, band) : null} />
    </>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const params = useSearchParams();
  if (params.get("embed") === "1") return <main className={styles.embed}>{children}</main>;
  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>
          <span className={styles.pair} aria-hidden="true" />
          Planet X &amp; SPHEREx
        </p>
        <h1 className={styles.title}>Watch the sky change.</h1>
        <p className={styles.lead}>
          NASA&apos;s SPHEREx telescope photographs the same spot of sky again and again. Put the images in order and
          anything that <strong>moved</strong> or <strong>changed brightness</strong> shows itself.
        </p>
      </header>
      {children}
    </main>
  );
}

export default function Home() {
  return (
    <Suspense fallback={<p className={styles.hint}>Loading…</p>}>
      <Shell>
        <Explorer />
      </Shell>
    </Suspense>
  );
}
