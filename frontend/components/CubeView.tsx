"use client";

// The viewer for the current choice (task B-09): a prepared static cube when one exists, otherwise
// a cube built by the backend (LiveCube). Prepared cubes exist for the five objects at 3′, in their
// own detector, and in every detector once role A's six-detector cubes (A-08) are in data/cubes;
// whether one exists is found out with a HEAD request, so nothing has to be listed by hand.

import { useEffect, useState } from "react";
import { LiveCube } from "@/components/LiveCube";
import type { Band, Fov } from "@/lib/backend";
import type { SkyPosition } from "@/lib/coords";
import type { DemoObject } from "@/lib/objects";
import { Viewer } from "@/viewer/Viewer";
import { staticCubeUrl } from "./pageState";
import { staticCubeExists } from "./staticCubes";
import styles from "./explorer.module.css";

export interface CubeViewProps {
  object: DemoObject | null;
  position: SkyPosition;
  band: Band;
  fov: Fov;
  /** Open another detector (the "All six detectors" tiles in the Stack tab, B-12). */
  onBandChange?: (band: Band) => void;
}

type Check = { url: string; ok: boolean };

// One detector picker only (B-10): the page's, which also works while a live cube is being fetched.
// The viewer's own picker (band / bands / onBandChange) is therefore not passed here.
export function CubeView({ object, position, band, fov, onBandChange }: CubeViewProps) {
  // Static cubes are 3′ and only for the five objects.
  const candidate = object && fov === 3 ? staticCubeUrl(object.id, band) : null;
  const known = object !== null && candidate !== null && band === object.band;
  const [check, setCheck] = useState<Check | null>(null);

  useEffect(() => {
    if (!candidate || known) return;
    const ac = new AbortController();
    staticCubeExists(candidate, ac.signal).then((ok) => !ac.signal.aborted && setCheck({ url: candidate, ok }));
    return () => ac.abort();
  }, [candidate, known]);

  const checked = check && check.url === candidate ? check : null;
  if (candidate && !known && !checked) {
    return (
      <p className={styles.note} aria-busy="true">
        Looking for prepared images…
      </p>
    );
  }

  if (candidate && (known || checked?.ok)) {
    return (
      <Viewer
        // key: a fresh viewer per cube, so the frame index and the chosen visits reset.
        key={candidate}
        cubeUrl={candidate}
        catalogueMotion={object?.catalogueMotion}
        // No `bands`: the header picker stays off (B-10); this only lets the six-detector tiles switch.
        onBandChange={onBandChange ? (b) => onBandChange(b as Band) : undefined}
      />
    );
  }

  return (
    <LiveCube
      key={`${position.ra},${position.dec},${band},${fov}`}
      position={position}
      band={band}
      fov={fov}
      catalogueMotion={object?.catalogueMotion}
    />
  );
}

export default CubeView;
