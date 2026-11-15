"use client";

// Which prepared (static) cubes exist for an object (B-11 (4)): since A-08 every detector of the five
// objects is prepared at 3′, so the page must not say "only D2 is prepared". Found out with HEAD
// requests, so nothing is listed by hand and an older deployment with fewer cubes still reads right.

import { useEffect, useState } from "react";
import { BANDS, type Band, type Fov } from "@/lib/backend";
import { staticCubeUrl } from "./pageState";

/** Does this static file exist? HEAD first; some static hosts answer 405 to HEAD, then GET. */
export async function staticCubeExists(url: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const head = await fetch(url, { method: "HEAD", signal });
    if (head.ok) return true;
    if (head.status !== 405) return false;
    const get = await fetch(url, { signal });
    return get.ok;
  } catch {
    return false;
  }
}

/** Detectors with a prepared 3′ cube for this object; null while checking or without an object. */
export function useStaticBands(objectId: string | null): Band[] | null {
  const [state, setState] = useState<{ id: string; bands: Band[] } | null>(null);
  useEffect(() => {
    if (!objectId) return;
    const ac = new AbortController();
    Promise.all(BANDS.map((b) => staticCubeExists(staticCubeUrl(objectId, b), ac.signal))).then((ok) => {
      if (!ac.signal.aborted) setState({ id: objectId, bands: BANDS.filter((_, i) => ok[i]) });
    });
    return () => ac.abort();
  }, [objectId]);
  return objectId && state?.id === objectId ? state.bands : null;
}

/**
 * The sentence under the detector and field choices for a prepared object, e.g.
 * " All six detectors are prepared for WISE 0855−0714 at 3′." Empty while checking.
 */
export function readyNote(name: string, ready: readonly Band[] | null, band: Band, fov: Fov): string {
  if (ready === null) return "";
  const wide = fov !== 3 ? ` Fields wider than 3′ are fetched from NASA’s archive when you open them.` : "";
  if (ready.length === BANDS.length) return ` All six detectors are prepared for ${name} at 3′.${wide}`;
  if (ready.length === 0) return ` Images for ${name} are fetched from NASA’s archive.`;
  const list = ready.join(", ");
  const here = fov === 3 && !ready.includes(band) ? ` ${band} is fetched from NASA’s archive.` : "";
  return ` Prepared for ${name} at 3′: ${list}.${here}${wide}`;
}
