"use client";

// Shown above the images of a typed position that is close to one of the five objects: says where
// the object is now and opens its prepared view. See lib/nearby.ts for the reason.
// B-13 (issue #85): when the visitor is looking at a detector in which the object is not seen, one
// more sentence says so, from the object's spectrum.json (bands[].detected, why_not; A-08).

import { useEffect, useState } from "react";
import type { SkyPosition } from "@/lib/coords";
import { describeNearby, detectorSentence, nearbyObject } from "@/lib/nearby";
import styles from "./explorer.module.css";

export interface NearbyHintProps {
  position: SkyPosition;
  onOpen: (objectId: string) => void;
  /** Half the width of the field shown, arcsec (fov * 30″); decides "in the images" vs "outside". */
  halfWidthArcsec?: number;
  /** Detector on screen. */
  band?: string;
}

type Bands = { band: string; detected: boolean; why_not?: string }[];

export function NearbyHint({ position, onOpen, halfWidthArcsec, band }: NearbyHintProps) {
  const near = nearbyObject(position, halfWidthArcsec === undefined ? {} : { halfWidthArcsec });
  const id = near?.object.id ?? null;
  const [bands, setBands] = useState<{ id: string; bands: Bands | null } | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    fetch(`/cubes/${id}/spectrum.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (s: { bands?: Bands } | null) => !cancelled && setBands({ id, bands: s?.bands ?? null }),
        () => !cancelled && setBands({ id, bands: null }),
      );
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (!near) return null;
  const extra = band && bands?.id === near.object.id ? detectorSentence(near.object.name, band, bands.bands) : "";
  return (
    <div className={styles.nearby} role="note">
      <p>
        {describeNearby(near)}
        {extra ? ` ${extra}` : ""}
      </p>
      <button type="button" className={styles.button} onClick={() => onOpen(near.object.id)}>
        {near.kind === "same" ? `Open the prepared view of ${near.object.name}` : `Show ${near.object.name} where it is now`}
      </button>
    </div>
  );
}

export default NearbyHint;
