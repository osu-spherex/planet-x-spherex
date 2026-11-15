// Overlay drawn on top of a cube canvas: centre mark, 30″ scale bar, north / east arrows.
// Coordinates are cube pixels: pixel (x, y) covers x..x+1, y..y+1. Row 0 is north, column 0 east.
// The canvas is always shown at the same screen width, so marks and labels are scaled with the
// cube width (k = 1 for the 61 px cubes) to keep one on-screen size for any field (B-07); the scale
// bar stays 30″ long on the sky.

import styles from "./Viewer.module.css";

const SCALE_BAR_ARCSEC = 30;
/** Width the marks were designed for (3′ cube at 3″). */
const BASE_W = 61;

export interface SkyOverlayProps {
  w: number;
  h: number;
  pixscaleArcsec: number;
  showCentre: boolean;
}

export function SkyOverlay({ w, h, pixscaleArcsec, showCentre }: SkyOverlayProps) {
  const k = w / BASE_W;
  const barPx = SCALE_BAR_ARCSEC / pixscaleArcsec;
  const cx = w / 2;
  const cy = h / 2;
  const pctX = (x: number) => `${(100 * x) / w}%`;
  const pctY = (y: number) => `${(100 * y) / h}%`;
  return (
    <>
      <svg className={styles.overlay} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
        {showCentre && (
          <g className={styles.centre}>
            <line x1={cx} y1={cy - 7 * k} x2={cx} y2={cy - 3.5 * k} />
            <line x1={cx} y1={cy + 3.5 * k} x2={cx} y2={cy + 7 * k} />
            <line x1={cx - 7 * k} y1={cy} x2={cx - 3.5 * k} y2={cy} />
            <line x1={cx + 3.5 * k} y1={cy} x2={cx + 7 * k} y2={cy} />
          </g>
        )}
        <g className={styles.annotation}>
          <line x1={2 * k} y1={h - 2.5 * k} x2={2 * k + barPx} y2={h - 2.5 * k} />
          <polyline
            points={`${w - 9.5 * k},${8 * k} ${w - 3.5 * k},${8 * k} ${w - 3.5 * k},${3.5 * k}`}
            fill="none"
          />
        </g>
      </svg>
      {/* B-15 (#92): labels in HTML at a fixed CSS size, so they stay readable in small panels. */}
      <span className={styles.skyLabel} aria-hidden="true" style={{ left: pctX(2 * k + barPx / 2), bottom: pctY(2.5 * k), transform: "translate(-50%, -2px)" }}>
        {SCALE_BAR_ARCSEC}″
      </span>
      <span className={styles.skyLabel} aria-hidden="true" style={{ left: pctX(w - 3.5 * k), top: pctY(3.5 * k), transform: "translate(-50%, -100%)" }}>
        N
      </span>
      <span className={styles.skyLabel} aria-hidden="true" style={{ right: pctX(10.3 * k), top: pctY(8 * k), transform: "translateY(-50%)" }}>
        E
      </span>
    </>
  );
}
