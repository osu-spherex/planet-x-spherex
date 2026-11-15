"use client";

// "What am I looking at?" under the viewer: the story of one demo object (content/stories.ts)
// and where its images come from. The dates and the image count are read from the cube's own
// cube.json, so they always describe the cube that is on screen.

import { useEffect, useState } from "react";
import { DATA_SOURCE, findStory } from "@/content/stories";
import { BAND_RANGE_UM, isBand } from "@/lib/backend";
import { mjdToIsoDate } from "@/viewer/cube";
import styles from "./explorer.module.css";

interface CubeFacts {
  url: string;
  images: number;
  first: string;
  last: string;
  fromCache: boolean;
  downloaded: string | null;
}

interface CubeJson {
  frames?: { mjd: number }[];
  source?: { from_cache?: boolean; downloaded_utc?: string[] };
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
  "November", "December"];

/** "2025-08-27" -> "27 August 2025" */
export function longDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

export function ObjectStory({ objectId, band, cubeUrl }: { objectId: string; band: string; cubeUrl: string }) {
  const story = findStory(objectId);
  const [facts, setFacts] = useState<CubeFacts | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(cubeUrl)
      .then((res) => (res.ok ? (res.json() as Promise<CubeJson>) : null))
      .then((meta) => {
        const mjd = (meta?.frames ?? []).map((f) => f.mjd).filter((v) => Number.isFinite(v));
        if (cancelled || mjd.length === 0) return;
        setFacts({
          url: cubeUrl,
          images: mjd.length,
          first: mjdToIsoDate(Math.min(...mjd)),
          last: mjdToIsoDate(Math.max(...mjd)),
          fromCache: meta?.source?.from_cache === true,
          downloaded: meta?.source?.downloaded_utc?.[0]?.slice(0, 10) ?? null,
        });
      })
      .catch(() => undefined); // the viewer reports a cube that cannot be loaded
    return () => {
      cancelled = true;
    };
  }, [cubeUrl]);

  if (!story) return null;
  const current = facts?.url === cubeUrl ? facts : null;

  return (
    <section className={styles.story} aria-labelledby="story-title">
      <h3 id="story-title" className={styles.storyTitle}>
        What am I looking at?
      </h3>
      <dl className={styles.storyList}>
        <dt>What it is</dt>
        <dd>{story.what}</dd>
        <dt>What to look for</dt>
        <dd>{story.look}</dd>
        <dt>Try this</dt>
        <dd>{story.tryThis}</dd>
        <dt>What we measured</dt>
        <dd>{story.measured}</dd>
        <dt>Where the images come from</dt>
        <dd>
          {current ? (
            <>
              {current.images} images taken by SPHEREx between {longDate(current.first)} and {longDate(current.last)}
              , with detector {band}
              {isBand(band) ? ` (infrared light of ${BAND_RANGE_UM[band]} micrometres)` : ""}.{" "}
            </>
          ) : null}
          <a href={DATA_SOURCE.url} target="_blank" rel="noreferrer">
            {DATA_SOURCE.text}
          </a>
          {current?.fromCache ? (
            <>
              {" "}
              <span className={styles.cacheBadge}>from cache</span> These images were downloaded from the archive
              {current.downloaded ? ` on ${longDate(current.downloaded)}` : " in advance"} and are shown from our copy,
              so the page works even when the archive is slow. They are real observations; nothing is simulated.
            </>
          ) : null}
        </dd>
      </dl>
      <p className={styles.storySources}>
        Facts about the object:{" "}
        {story.sources.map((s, i) => (
          <span key={s.url}>
            {i > 0 ? "; " : ""}
            <a href={s.url} target="_blank" rel="noreferrer">
              {s.label}
            </a>
          </span>
        ))}
        .
      </p>
    </section>
  );
}

export default ObjectStory;
