// Display helpers for the Stack tab (role B, tasks B-03, B-07). The stacking itself is role P's
// search/stack.ts; this file only picks defaults and fixed display scales around it.
// Radii are in arcsec, so cubes of any size work (61, 121, 201 px at 3″: fov 3′, 6′, 10′).

import type { Cube, StretchLimits } from "./cube";
import { stretchLimits } from "./cube";
import { robustStats, stack, type StackMode, type StackResult } from "../search/stack";
import { regionPeak } from "../search/grid";

/** Peak SNR is searched within this radius of the search point: 12″, role P's velocity grid default
 *  (search/grid.ts: radius 4 px on the 3″ cubes). */
export const PEAK_RADIUS_ARCSEC = 12;
/** PEAK_RADIUS_ARCSEC in pixels of the 3″ static cubes. */
export const PEAK_RADIUS_PX = 4;

/** Half-size of the box that is stacked around the search point: 90″, i.e. the whole 3′ cube.
 *  Bigger cubes are stacked only inside it (201 x 201 x 150 clipped: 805 ms whole, 113 ms boxed). */
export const STACK_BOX_ARCSEC = 90;

/** Arcsec to pixels of this cube. */
export function arcsecToPx(cube: Pick<Cube, "meta">, arcsec: number): number {
  return arcsec / cube.meta.pixscale_arcsec;
}

/** A source whose typical single-frame peak SNR is above this counts as bright. */
export const BRIGHT_SNR = 50;

/** Radius around the centre searched for the single-frame peak: 24″ (8 px at 3″), room for a few
 *  years of motion of the fastest demo object (WISE 0855, 8″/yr). */
export const BRIGHT_RADIUS_ARCSEC = 24;

/** Mean MJD of all frames: stacks are aligned on the object's position at this time. */
export function meanMjd(cube: Cube): number {
  let s = 0;
  for (const f of cube.meta.frames) s += f.mjd;
  return s / cube.n;
}

/** Cube centre in pixel coordinates (the target position given when the cube was made). */
export function centrePx(cube: Cube): { x: number; y: number } {
  return { x: (cube.w - 1) / 2, y: (cube.h - 1) / 2 };
}

/**
 * Default combination for this cube.
 * - Bright source: "mean". Each frame sees a bright star at its own wavelength (LVF), so its pixel
 *   values differ between frames by far more than 5 noise sigmas and "clipped" throws its real flux
 *   away (Barnard D1, 11/14: clipped peak SNR 368 vs mean 2591). The median hides the smear of a
 *   moving star, because it picks the position where the star spent most frames.
 * - Faint source: "clipped". A single cosmic ray outshines the object in a plain mean (WISE 0855 D6:
 *   mean peak SNR ~700 at every vector, clipped 15-21 depending on the vector).
 * Brightness = median over frames of each frame's highest pixel within BRIGHT_RADIUS_ARCSEC of the
 * centre, in units of that frame's noise. Per frame, so a fast mover is not smeared away first;
 * median over frames, so one cosmic ray does not make a faint field look bright.
 */
export function defaultStackMode(cube: Cube, at: { x: number; y: number } = centrePx(cube)): StackMode {
  return typicalFramePeakSnr(cube, at) > BRIGHT_SNR ? "mean" : "clipped";
}

/** Median over frames of the brightest pixel within BRIGHT_RADIUS_ARCSEC of `at` (default: the centre), in noise units. */
export function typicalFramePeakSnr(cube: Cube, at: { x: number; y: number } = centrePx(cube)): number {
  const { w, h, n, data } = cube;
  const c = at;
  const r = arcsecToPx(cube, BRIGHT_RADIUS_ARCSEC);
  const r2 = r * r;
  const peaks: number[] = [];
  const x0 = Math.max(0, Math.floor(c.x - r));
  const x1 = Math.min(w - 1, Math.ceil(c.x + r));
  const y0 = Math.max(0, Math.floor(c.y - r));
  const y1 = Math.min(h - 1, Math.ceil(c.y + r));
  for (let k = 0; k < n; k++) {
    const off = k * w * h;
    const given = cube.meta.frames[k].noise;
    const noise = given > 0 ? given : robustStats(data.subarray(off, off + w * h)).sigma;
    if (!(noise > 0)) continue;
    let best = -Infinity;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if ((x - c.x) ** 2 + (y - c.y) ** 2 > r2) continue;
        const v = data[off + y * w + x];
        if (v > best) best = v;
      }
    }
    if (Number.isFinite(best)) peaks.push(best / noise);
  }
  return robustStats(peaks).median;
}

export interface StackView {
  result: StackResult;
  /** Highest SNR within PEAK_RADIUS_ARCSEC of the search point, and where it is. */
  peak: { snr: number; x: number; y: number };
  /** The search point (pixels). */
  at: { x: number; y: number };
  /** Pixel scale of the cube, arcsec. */
  pix: number;
}

/**
 * Box stacked around `at`: undefined (whole cube) when the cube fits in the box, as the 3′ cubes
 * do, so their results are exactly as before.
 */
export function stackBox(cube: Cube, at: { x: number; y: number }) {
  const half = arcsecToPx(cube, STACK_BOX_ARCSEC);
  if (cube.w <= 2 * half + 1 && cube.h <= 2 * half + 1) return undefined;
  return {
    x0: Math.max(0, Math.floor(at.x - half)),
    y0: Math.max(0, Math.floor(at.y - half)),
    x1: Math.min(cube.w, Math.ceil(at.x + half) + 1),
    y1: Math.min(cube.h, Math.ceil(at.y + half) + 1),
  };
}

export function stackView(
  cube: Cube,
  pmRa: number,
  pmDec: number,
  mode: StackMode,
  refMjd = meanMjd(cube),
  at: { x: number; y: number } = centrePx(cube),
): StackView {
  const result = stack(cube, pmRa, pmDec, refMjd, mode, { region: stackBox(cube, at) });
  return { result, peak: regionPeak(result, at.x, at.y, arcsecToPx(cube, PEAK_RADIUS_ARCSEC)), at, pix: cube.meta.pixscale_arcsec };
}

/** Lowest SNR shown (black). */
export const SNR_LO = -3;
/** The SNR scale reaches at least this far, so pure noise never fills the whole grey range. */
export const SNR_MIN_HI = 10;

export interface StackScales {
  image: StretchLimits;
  snr: StretchLimits;
}

/**
 * Display scales, fixed per cube and mode from the stack at zero motion: a vector that gathers the
 * object's light then shows up as a brighter, tighter spot instead of being re-stretched away.
 * Image: 1st percentile up to the brightest pixel within BRIGHT_RADIUS_ARCSEC of the search point, so the
 * target itself is not saturated and its shape (compact or smeared) stays visible; falls back to
 * the 99.5th percentile when there is no usable pixel there.
 * SNR: SNR_LO up to the zero-motion peak, at least SNR_MIN_HI.
 */
export function stackScales(zero: StackView): StackScales {
  const { image, w, h } = zero.result;
  const base = stretchLimits(image);
  const cx = zero.at.x;
  const cy = zero.at.y;
  const r = BRIGHT_RADIUS_ARCSEC / zero.pix;
  const r2 = r * r;
  let top = -Infinity;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = image[y * w + x];
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r2 && v > top) top = v;
    }
  }
  return {
    image: { lo: base.lo, hi: Number.isFinite(top) && top > base.lo ? top : base.hi },
    snr: { lo: SNR_LO, hi: Math.max(SNR_MIN_HI, zero.peak.snr) },
  };
}

/** Clamp and round a motion entered by the user (arcsec/yr). Non-numbers become 0. */
export function clampMotion(v: number, max: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.round(Math.min(max, Math.max(-max, v)) * 100) / 100;
}
