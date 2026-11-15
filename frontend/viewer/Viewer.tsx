"use client";

// Frame player for one cube (role B, task B-01): draws a frame on a canvas (NaN in its own
// colour, percentile stretch, optional asinh), with a frame slider and play / pause.
// The "Compare visits" tab compares two epochs: difference image or blink (task B-02).
// The "Stack" tab shifts and stacks all frames along a proper motion set by hand (task B-03).
// The "Measure" tab shows motion, light curve and spectrum from measure.json (task B-04).
// Any cube size works (fov 3′ / 6′ / 10′); catalogue and flag layers when their files exist (B-07).
// A detector picker in the header when the page passes onBandChange; full spectrum in Measure (B-08).
//
//   <Viewer cubeUrl="/cubes/barnard/D1/cube.json" catalogueMotion={{ pmRa: -0.8, pmDec: 10.36, source: "Gaia DR3" }} />
//
// Static cubes and the backend's /api/cube share one format, so the URL can point at either.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CubeNotReadyError,
  NAN_RGB,
  getFrame,
  loadCube,
  mjdToIsoDate,
  renderFrame,
  resolveDataUrl,
  stretchLimits,
  type Cube,
  type StretchMode,
} from "./cube";
import { Difference } from "./Difference";
import { SkyOverlay } from "./SkyOverlay";
import { Stack, type CatalogueMotion } from "./Stack";
import { Measure, type MeasureState } from "./Measure";
import { measureUrlFor } from "./measureData";
import { spectrumUrlFor } from "./spectrumData";
import { CatalogLayer, FlagLayer } from "./OverlayLayers";
import {
  ALL_SOURCES_MAX,
  MOVING_PM_MIN,
  catalogUrlFor,
  centerFlagDescriptions,
  flagSummary,
  releaseText,
  centerInfoFlagNames,
  loadCatalog,
  loadFlags,
  releaseLabel,
  selectSources,
  sourceKey,
  sourceLabel,
  sourcePixel,
  totalPm,
  type Catalog,
  type CatalogSource,
  type LayerMode,
} from "./overlayData";
import { meanMjd } from "./stackView";
import styles from "./Viewer.module.css";

export interface ViewerProps {
  /** URL of cube.json (static file or /api/cube?...). */
  cubeUrl: string;
  /** Known proper motion of the target, offered as a button in the Stack tab. */
  catalogueMotion?: CatalogueMotion;
  /** measure.json URL. Default: next to a static cube.json; none for other cube URLs. */
  measureUrl?: string | null;
  /** Why there is no measureUrl yet, for a cube built by the backend (B-14, issue #93). */
  measureState?: MeasureState;
  /** catalog.json URL. Default: /cubes/<obj>/catalog.json for a static cube; none otherwise. */
  catalogUrl?: string | null;
  /** spectrum.json URL (all detectors). Default: /cubes/<obj>/spectrum.json for a static cube. */
  spectrumUrl?: string | null;
  /** Detector shown and the detectors to offer. With onBandChange the header gets a small picker;
   *  the page owns the choice (URL parameter, which cube to load), the viewer only reports it. */
  band?: string;
  bands?: readonly string[];
  onBandChange?: (band: string) => void;
}

type LoadResult = { url: string; cube: Cube } | { url: string; error: string };
type Tab = "frames" | "compare" | "stack" | "measure";

/** One line under the tabs: what this view shows (task A-18). The longer explanations stay below the images. */
const TAB_HINT: Record<Tab, string> = {
  frames: "Every SPHEREx image of this spot, in time order. Press Play.",
  compare: "Later visit minus earlier. A blue and a red spot side by side = it moved.",
  stack: "All images added up along a motion. Faint objects appear.",
  measure: "The motion in arcseconds a year, the brightness over time, the spectrum.",
};

const SPEEDS_FPS = [2, 4, 8];
const NAN_CSS = `rgb(${NAN_RGB.join(" ")})`;

function describeError(err: unknown): string {
  if (err instanceof CubeNotReadyError) {
    const pct = err.progress === null ? "" : `, ${Math.round(err.progress * 100)} %`;
    return `The images for this position are still being prepared (${err.status}${pct}). Try again in a moment.`;
  }
  return err instanceof Error ? err.message : String(err);
}

export function Viewer({
  cubeUrl,
  measureState,
  catalogueMotion,
  measureUrl,
  catalogUrl,
  spectrumUrl,
  band,
  bands,
  onBandChange,
}: ViewerProps) {
  const [result, setResult] = useState<LoadResult | null>(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [mode, setMode] = useState<StretchMode>("linear");
  const [fps, setFps] = useState(4);
  const [showCentre, setShowCentre] = useState(true);
  const [tab, setTab] = useState<Tab>("frames");
  // Off until asked for: a 3 arcmin field holds 30 to 580 catalogue sources (Barnard's Star: 582),
  // and with all of them drawn the image underneath cannot be seen (planner hotfix 11/14 17:25, B-10).
  const [showCatalog, setShowCatalog] = useState(false);
  const [showFlags, setShowFlags] = useState(false);
  // Catalogue layer (B-10): moving sources first; a clicked source can be stacked along its motion.
  const [layerMode, setLayerMode] = useState<LayerMode>("moving");
  const [picked, setPicked] = useState<CatalogSource | null>(null);
  const [stackRequest, setStackRequest] = useState<{ id: number; pmRa: number; pmDec: number; x: number; y: number } | null>(
    null,
  );
  const [catalog, setCatalog] = useState<{ url: string; data: Catalog | null } | null>(null);
  const [flags, setFlags] = useState<{ url: string; data: Uint8Array | null } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const catUrl = catalogUrl === undefined ? catalogUrlFor(cubeUrl) : catalogUrl;

  useEffect(() => {
    let cancelled = false;
    loadCube(cubeUrl).then(
      (cube) => {
        if (!cancelled) setResult({ url: cubeUrl, cube });
      },
      (err: unknown) => {
        if (!cancelled) setResult({ url: cubeUrl, error: describeError(err) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [cubeUrl]);

  // A result for another URL is stale: show "loading" until the new cube arrives.
  const current = result?.url === cubeUrl ? result : null;
  const cube = current && "cube" in current ? current.cube : null;
  const error = current && "error" in current ? current.error : null;
  const frameIndex = cube ? Math.min(index, cube.n - 1) : 0;
  const flagsUrl = cube?.meta.flags_url ? resolveDataUrl(cube.meta.flags_url, cubeUrl) : null;

  // Optional layers. A missing file (404) or a broken one just means no layer: the toggle stays hidden.
  useEffect(() => {
    if (!catUrl) return;
    let cancelled = false;
    loadCatalog(catUrl).then(
      (data) => !cancelled && setCatalog({ url: catUrl, data }),
      () => !cancelled && setCatalog({ url: catUrl, data: null }),
    );
    return () => {
      cancelled = true;
    };
  }, [catUrl]);

  useEffect(() => {
    if (!flagsUrl || !cube) return;
    let cancelled = false;
    loadFlags(flagsUrl, cube).then(
      (data) => !cancelled && setFlags({ url: flagsUrl, data }),
      () => !cancelled && setFlags({ url: flagsUrl, data: null }),
    );
    return () => {
      cancelled = true;
    };
  }, [flagsUrl, cube]);

  const catalogData = catalog && catalog.url === catUrl ? catalog.data : null;
  const selection = useMemo(() => (catalogData ? selectSources(catalogData, layerMode) : null), [catalogData, layerMode]);
  const flagData = flags && flags.url === flagsUrl ? flags.data : null;

  // Display limits of every frame, once per cube (60 frames of 61 x 61 take a few ms).
  const limits = useMemo(
    () => (cube ? Array.from({ length: cube.n }, (_, i) => stretchLimits(getFrame(cube, i))) : []),
    [cube],
  );

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx || !cube || tab !== "frames") return;
    const image = ctx.createImageData(cube.w, cube.h);
    renderFrame(getFrame(cube, frameIndex), limits[frameIndex], mode, image.data);
    ctx.putImageData(image, 0, 0);
  }, [cube, frameIndex, limits, mode, tab]);

  useEffect(() => {
    if (!playing || !cube || tab !== "frames") return;
    const n = cube.n;
    const timer = setInterval(() => setIndex((i) => (Math.min(i, n - 1) + 1) % n), 1000 / fps);
    return () => clearInterval(timer);
  }, [playing, cube, fps, tab]);

  if (error) {
    return (
      <div className={styles.viewer}>
        <p className={styles.error} role="alert">
          Could not show the images. {error}
        </p>
      </div>
    );
  }
  if (!cube) {
    return (
      <div className={styles.viewer}>
        <div className={`${styles.stage} ${styles.placeholder}`} aria-busy="true">
          Loading images…
        </div>
      </div>
    );
  }

  const { meta, n, w, h } = cube;
  const frame = meta.frames[frameIndex];
  const epochCount = meta.epochs?.length;
  const fovArcmin = (w * meta.pixscale_arcsec) / 60;
  const cached = meta.source?.from_cache === true;
  const downloaded = meta.source?.downloaded_utc?.[0]?.slice(0, 10);
  const step = (delta: number) => {
    setPlaying(false);
    setIndex((frameIndex + delta + n) % n);
  };

  return (
    <div className={styles.viewer}>
      <div className={styles.header}>
        <span className={styles.bandPicker}>
          SPHEREx{" "}
          {onBandChange && bands && bands.length > 1 ? (
            <select
              value={band ?? meta.band ?? frame.band}
              onChange={(e) => onBandChange(e.target.value)}
              aria-label="Detector"
            >
              {bands.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          ) : (
            (meta.band ?? frame.band)
          )}{" "}
          · {fovArcmin.toFixed(1)}′ field
          {releaseLabel(meta) ? ` · ${releaseLabel(meta)}` : ""}
        </span>
        {cached && (
          <span className={styles.badge} title={meta.source?.archive}>
            from cache{downloaded ? ` · downloaded ${downloaded}` : ""}
          </span>
        )}
      </div>

      <div className={styles.tabs} role="tablist" aria-label="View">
        <button type="button" role="tab" aria-selected={tab === "frames"} onClick={() => setTab("frames")}>
          Images
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "compare"}
          onClick={() => {
            setPlaying(false);
            setTab("compare");
          }}
        >
          Compare visits
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "stack"}
          onClick={() => {
            setPlaying(false);
            setTab("stack");
          }}
        >
          Stack
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "measure"}
          onClick={() => {
            setPlaying(false);
            setTab("measure");
          }}
        >
          Measure
        </button>
      </div>
      <p className={styles.tabHint}>{TAB_HINT[tab]}</p>

      {tab === "compare" ? (
        <Difference cube={cube} mode={mode} showCentre={showCentre} />
      ) : tab === "measure" ? (
        <Measure
          measureUrl={measureUrl === undefined ? measureUrlFor(cubeUrl) : measureUrl}
          measureState={measureState}
          catalogueMotion={catalogueMotion}
          spectrumUrl={spectrumUrl === undefined ? spectrumUrlFor(cubeUrl) : spectrumUrl}
        />
      ) : tab === "stack" ? (
        <Stack
          cubeUrl={cubeUrl}
          onPickBand={onBandChange}
          // key: a new "Stack along this motion" request starts a fresh stack at that source.
          key={stackRequest?.id ?? "start"}
          cube={cube}
          catalogueMotion={catalogueMotion}
          mode={mode}
          showCentre={showCentre}
          initial={stackRequest ?? undefined}
        />
      ) : (
        <>
          <div className={styles.stage} style={{ aspectRatio: `${w} / ${h}` }}>
            <canvas
              ref={canvasRef}
              className={styles.canvas}
              width={w}
              height={h}
              role="img"
              aria-label={`SPHEREx image ${frameIndex + 1} of ${n}, taken ${mjdToIsoDate(frame.mjd)} at ${frame.lam_um.toFixed(3)} micrometres. North is up, east is left.`}
            />
            {flagData && showFlags && <FlagLayer flags={flagData} cube={cube} frame={frameIndex} />}
            <SkyOverlay w={w} h={h} pixscaleArcsec={meta.pixscale_arcsec} showCentre={showCentre} />
            {selection && showCatalog && (
              <CatalogLayer
                sources={selection.sources}
                cube={cube}
                mjd={frame.mjd}
                selected={picked ? sourceKey(picked) : null}
                onSelect={(src) => setPicked(src)}
              />
            )}
          </div>

          <div className={styles.controls}>
            <button type="button" onClick={() => step(-1)} aria-label="Previous image">
              ‹
            </button>
            <button
              type="button"
              className={styles.play}
              onClick={() => setPlaying(!playing)}
              aria-pressed={playing}
            >
              {playing ? "Pause" : "Play"}
            </button>
            <button type="button" onClick={() => step(1)} aria-label="Next image">
              ›
            </button>
            <input
              className={styles.slider}
              type="range"
              min={0}
              max={n - 1}
              step={1}
              value={frameIndex}
              onChange={(e) => {
                setPlaying(false);
                setIndex(Number(e.target.value));
              }}
              aria-label="Image number"
              aria-valuetext={`Image ${frameIndex + 1} of ${n}, ${mjdToIsoDate(frame.mjd)}`}
            />
            <span className={styles.count}>
              {frameIndex + 1} / {n}
            </span>
          </div>

          <p className={styles.info}>
            <strong>{mjdToIsoDate(frame.mjd)}</strong>
            <span>{frame.lam_um.toFixed(3)} µm</span>
            {frame.epoch !== undefined && epochCount !== undefined && (
              <span>
                visit {frame.epoch + 1} of {epochCount}
              </span>
            )}
            {frame.flags && <span>{flagSummary(meta, frameIndex)}</span>}
          </p>
          {/* B-15 (#90): pipeline names behind a toggle that also opens by touch. */}
          <details className={styles.infoDetails}>
            <summary>Details</summary>
            <ul>
              <li>
                MJD {frame.mjd.toFixed(3)}: the time of this image as a Modified Julian Date (days counted from
                1858-11-17), the usual clock of astronomers.
              </li>
              {releaseText(meta) && <li>{releaseText(meta)}</li>}
              {centerFlagDescriptions(meta, frameIndex).map((d) => (
                <li key={d}>Flag near the centre, {d.replace(/\.$/, "")}.</li>
              ))}
              {centerFlagDescriptions(meta, frameIndex).some((d) => / SUR\b/.test(d)) && (
                <li>SUR: the detector&apos;s on-board readout of each exposure.</li>
              )}
              {centerInfoFlagNames(meta, frameIndex).map((n) => (
                <li key={n}>{n}: information from the pipeline, not damage.</li>
              ))}
            </ul>
          </details>

          {selection && showCatalog && (
            <div className={styles.catPanel}>
              <label className={styles.options}>
                Show{" "}
                <select value={layerMode} onChange={(e) => setLayerMode(e.target.value as LayerMode)}>
                  <option value="moving">moving sources (pm ≥ {MOVING_PM_MIN}″/yr)</option>
                  <option value="all">all sources ({ALL_SOURCES_MAX} brightest)</option>
                </select>
              </label>
              <p className={styles.legend}>
                {layerMode === "moving"
                  ? selection.moving > 0
                    ? `${selection.moving} of the ${selection.total} catalogue sources here move${selection.moving === 1 ? "s" : ""} by at least ${MOVING_PM_MIN}″/yr. The arrow shows the direction. Click a mark for details.`
                    : `None of the ${selection.total} catalogue sources here moves by ${MOVING_PM_MIN}″/yr or more.`
                  : `Showing the ${Math.min(ALL_SOURCES_MAX, selection.total)} brightest of ${selection.total} (Gaia by G, CatWISE by W2, in turn)${selection.moving ? ", plus every moving one" : ""}. Faint catalogue stars may not show in a single SPHEREx image, and near a very bright star a catalogue can also list false entries from its glare. Click a mark for details.`}
              </p>
              {picked && (
                <div className={styles.picked} role="region" aria-label="Selected catalogue source">
                  <p>
                    <strong>{sourceLabel(picked)}</strong>
                    {totalPm(picked) === 0 && picked.pm_ra === null ? " · no motion in the catalogue" : ""}
                  </p>
                  <div className={`${styles.controls} ${styles.wrap}`}>
                    <button
                      type="button"
                      className={styles.play}
                      onClick={() => {
                        const at = sourcePixel(picked, meanMjd(cube), meta, w, h);
                        setStackRequest({
                          id: Date.now(),
                          pmRa: picked.pm_ra ?? 0,
                          pmDec: picked.pm_dec ?? 0,
                          x: Math.min(w - 1, Math.max(0, Math.round(at.x))),
                          y: Math.min(h - 1, Math.max(0, Math.round(at.y))),
                        });
                        setPlaying(false);
                        setTab("stack");
                      }}
                    >
                      {totalPm(picked) > 0 ? "Stack along this motion" : "Stack at this position"}
                    </button>
                    <button type="button" onClick={() => setPicked(null)}>
                      Close
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {tab !== "measure" && (
      <div className={styles.options}>
        <label>
          Brightness scale{" "}
          <select value={mode} onChange={(e) => setMode(e.target.value as StretchMode)}>
            <option value="linear">linear</option>
            <option value="asinh">asinh (shows faint detail)</option>
          </select>
        </label>
        {tab === "frames" && (
          <label>
            Speed{" "}
            <select value={fps} onChange={(e) => setFps(Number(e.target.value))}>
              {SPEEDS_FPS.map((s) => (
                <option key={s} value={s}>
                  {s} images/s
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          <input type="checkbox" checked={showCentre} onChange={(e) => setShowCentre(e.target.checked)} /> Centre mark
        </label>
        {tab === "frames" && catalogData && (
          <label title={catalogData.source?.archive}>
            <input type="checkbox" checked={showCatalog} onChange={(e) => setShowCatalog(e.target.checked)} /> Catalogue
            (<span className={styles.keyGaia} /> Gaia DR3, <span className={styles.keyWise} /> CatWISE2020)
          </label>
        )}
        {tab === "frames" && flagData && (
          <label>
            <input type="checkbox" checked={showFlags} onChange={(e) => setShowFlags(e.target.checked)} /> Flags
          </label>
        )}
      </div>
      )}

      {tab === "frames" && (
        <p className={styles.legend}>
          <span className={styles.swatch} style={{ background: NAN_CSS }} /> no data (outside the image, or flagged by
          SPHEREx, such as the saturated core of a bright star). Each image is taken at a different wavelength and
          scaled on its own from the 1st to the 99.5th percentile, so brightness is not comparable between images.
          {meta.skipped && meta.skipped.length > 0
            ? ` ${meta.skipped.length} image${meta.skipped.length === 1 ? " was" : "s were"} left out of this cube: ${[
                ...new Set(meta.skipped.map((s) => s.why.replace(/\.$/, ""))),
              ].join("; ")}.`
            : ""}
        </p>
      )}
    </div>
  );
}

export default Viewer;
