"use client";

// Layers drawn over the frame canvas (role B, tasks B-07, B-10):
//   CatalogLayer  Gaia DR3 (circles) and CatWISE2020 (squares) sources, each moved to the frame's
//                 date with its catalogue proper motion; an arrow shows the direction of motion
//                 for sources faster than PM_ARROW_MIN. Marks are small (diameter under 5% of the
//                 image at any field width) and can be clicked or chosen with the keyboard.
//   FlagLayer     pixels flagged by the SPHEREx pipeline in this frame, semi-transparent.
// Data: viewer/overlayData.ts. Both layers exist only when their file exists.

import { useEffect, useRef } from "react";
import type { Cube } from "./cube";
import { PM_ARROW_MIN, renderFlags, sourceKey, sourceLabel, sourcePixel, totalPm, type CatalogSource } from "./overlayData";
import styles from "./Viewer.module.css";

/** Width the marks were designed for (3′ cube at 3″), as in SkyOverlay. */
const BASE_W = 61;
/** Mark radius in pixels of the 61 px grid: diameter 2.8 / 61 = 4.6% of the image (B-10: <= 5%). */
export const MARK_RADIUS = 1.4;

export interface CatalogLayerProps {
  sources: readonly CatalogSource[];
  cube: Cube;
  mjd: number;
  /** sourceKey of the selected source. */
  selected?: string | null;
  onSelect?: (s: CatalogSource) => void;
}

export function CatalogLayer({ sources, cube, mjd, selected = null, onSelect }: CatalogLayerProps) {
  const { w, h, meta } = cube;
  const k = w / BASE_W;
  const r = MARK_RADIUS * k;
  return (
    <svg className={styles.overlay} viewBox={`0 0 ${w} ${h}`} aria-label="Catalogue sources">
      {sources.map((s) => {
        const p = sourcePixel(s, mjd, meta, w, h);
        // Pixel centres are at x + 0.5 on the canvas.
        const x = p.x + 0.5;
        const y = p.y + 0.5;
        if (x < -r || y < -r || x > w + r || y > h + r) return null;
        const pm = totalPm(s);
        const gaia = s.cat === "gaia_dr3";
        const key = sourceKey(s);
        const isSel = key === selected;
        // Arrow along the motion: east = -x, north = -y.
        const ux = pm > 0 ? -(s.pm_ra ?? 0) / pm : 0;
        const uy = pm > 0 ? -(s.pm_dec ?? 0) / pm : 0;
        const label = sourceLabel(s);
        const cls = `${gaia ? styles.catGaia : styles.catWise}${isSel ? ` ${styles.catSelected}` : ""}`;
        return (
          <g
            key={key}
            className={cls}
            data-source={key}
            role={onSelect ? "button" : undefined}
            tabIndex={onSelect ? 0 : undefined}
            aria-label={onSelect ? `${label}. Show details` : undefined}
            aria-pressed={onSelect ? isSel : undefined}
            onClick={onSelect ? () => onSelect(s) : undefined}
            onKeyDown={
              onSelect
                ? (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelect(s);
                    }
                  }
                : undefined
            }
          >
            <title>{label}</title>
            {/* A larger invisible target makes the small mark easy to hit with a finger. */}
            <circle className={styles.catHit} cx={x} cy={y} r={r * 2.4} />
            {gaia ? (
              <circle cx={x} cy={y} r={r} />
            ) : (
              <rect x={x - r * 0.85} y={y - r * 0.85} width={r * 1.7} height={r * 1.7} />
            )}
            {pm >= PM_ARROW_MIN && (
              <>
                <line x1={x + ux * r * 1.3} y1={y + uy * r * 1.3} x2={x + ux * r * 4} y2={y + uy * r * 4} />
                <circle className={styles.catArrowHead} cx={x + ux * r * 4} cy={y + uy * r * 4} r={0.5 * k} />
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export function FlagLayer({ flags, cube, frame }: { flags: Uint8Array; cube: Cube; frame: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    const image = ctx.createImageData(cube.w, cube.h);
    renderFlags(flags, frame, cube.w, cube.h, image.data);
    ctx.putImageData(image, 0, 0);
  }, [flags, frame, cube]);
  return <canvas ref={ref} className={`${styles.canvas} ${styles.overlay}`} width={cube.w} height={cube.h} aria-hidden="true" />;
}
