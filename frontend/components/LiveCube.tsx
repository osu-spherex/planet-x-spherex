"use client";

// A cube for any position, built by the backend on request. The backend needs one to two
// minutes the first time (archive search plus ~60 downloads), so this component waits, shows what
// is happening, and hands the finished cube to the viewer. It asks for a first look (preview=1,
// backend task C-09): a cube of two images from every visit, shown as soon as it exists and swapped
// for the full cube when that is ready. The measurement (motion, light curve)
// is a second job that starts once the images are there; the viewer gets it when it is ready.

import { useEffect, useState } from "react";
import { Viewer } from "@/viewer/Viewer";
import {
  JobError,
  apiUrl,
  backendBase,
  describeJob,
  listedDate,
  missingImagesNote,
  previewUrl,
  waitForJob,
  type Band,
  type Fov,
  type JobState,
  type PreviewInfo,
} from "@/lib/backend";
import type { SkyPosition } from "@/lib/coords";
import styles from "./explorer.module.css";

type Phase =
  | { url: string; step: "waiting"; job: JobState | null }
  | { url: string; step: "preview"; preview: PreviewInfo; job: JobState | null }
  | { url: string; step: "ready"; measureReady: boolean; measureFailed?: boolean; savedList: string | null; missing: string | null }
  | { url: string; step: "failed"; message: string };

export interface LiveCubeProps {
  position: SkyPosition;
  band: Band;
  /** Field of view, arcminutes; 3 when omitted. */
  fov?: Fov;
  catalogueMotion?: { pmRa: number; pmDec: number; source: string };
}

export function LiveCube({ position, band, fov = 3, catalogueMotion }: LiveCubeProps) {
  const base = backendBase();
  const cubeUrl = base ? apiUrl(base, "cube", position, band, fov) : "";
  const measureUrl = base ? apiUrl(base, "measure", position, band, fov) : "";
  const [phase, setPhase] = useState<Phase | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!cubeUrl) return;
    const controller = new AbortController();
    const { signal } = controller;
    const alive = () => !signal.aborted;

    waitForJob(previewUrl(cubeUrl), {
      signal,
      // 2 s instead of the default 3: the first look should appear as soon as it exists (C-10)
      intervalMs: 2000,
      // keep a first look on screen while later progress arrives
      onUpdate: (job) =>
        alive() &&
        setPhase((prev) =>
          prev?.url === cubeUrl && prev.step === "preview" ? { ...prev, job } : { url: cubeUrl, step: "waiting", job },
        ),
      onPreview: (preview) => alive() && setPhase({ url: cubeUrl, step: "preview", preview, job: null }),
    })
      .then((result) => {
        if (!alive()) return;
        // the date of our saved image list when the archive's search was down (C-13), else null
        const savedList = result?.listing === "saved" ? (result.listed ?? "") : null;
        const missing = missingImagesNote(result?.frames, result?.failed);
        setPhase({ url: cubeUrl, step: "ready", measureReady: false, savedList, missing });
        // The images are on the server now, so the measurement only has to read them.
        return waitForJob(measureUrl, { signal }).then(
          () => alive() && setPhase({ url: cubeUrl, step: "ready", measureReady: true, savedList, missing }),
          () => alive() && setPhase({ url: cubeUrl, step: "ready", measureReady: false, measureFailed: true, savedList, missing }), // B-14 (#93)
        );
      })
      .catch((err: unknown) => {
        if (!alive()) return;
        const message = err instanceof JobError ? err.message : "Something went wrong while fetching the images.";
        setPhase({ url: cubeUrl, step: "failed", message });
      });
    return () => controller.abort();
  }, [cubeUrl, measureUrl, attempt]);

  if (!base) {
    return (
      <p className={styles.problem} role="alert">
        Images for other positions come from a server that is not set up for this copy of the site. The five
        example objects above work without it.
      </p>
    );
  }

  // A phase left over from another position is stale: show "waiting" until this one reports.
  const current: Phase = phase?.url === cubeUrl ? phase : { url: cubeUrl, step: "waiting", job: null };

  if (current.step === "failed") {
    return (
      <div className={styles.problem} role="alert">
        <p>{current.message}</p>
        <button type="button" className={styles.button} onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </button>
      </div>
    );
  }

  if (current.step === "waiting") {
    const progress = current.job?.progress ?? null;
    return (
      <div className={styles.waiting} role="status" aria-live="polite">
        <p className={styles.waitingText}>{describeJob(current.job)}</p>
        {progress === null ? (
          <progress className={styles.progress} aria-label="Fetching images" />
        ) : (
          <progress className={styles.progress} value={progress} max={1} aria-label="Fetching images" />
        )}
        <p className={styles.note}>
          The first look at a new position takes one to two minutes: every SPHEREx image of this spot is found in
          NASA&apos;s archive and downloaded. After that it opens at once.
        </p>
      </div>
    );
  }

  // First look and full cube render the same tree (banner slot + viewer with the same key), so React
  // keeps the viewer mounted: its tab and settings stay, only its cube is replaced (the viewer
  // reloads when cubeUrl changes).
  const preview = current.step === "preview" ? current : null;
  const progress = preview ? (preview.job?.progress ?? preview.preview.progress) : null;
  const of = preview?.preview.images ? ` of ${preview.preview.images}` : "";
  const missing = current.step === "ready" ? current.missing : null;
  const savedList =
    current.step === "ready"
      ? current.savedList
      : preview?.preview.listing === "saved"
        ? (preview.preview.listed ?? "")
        : null;
  return (
    <>
      {preview && (
        <div className={styles.waiting} role="status" aria-live="polite">
          <p className={styles.waitingText}>
            {preview.job?.status === "restarted"
              ? describeJob(preview.job)
              : `First look: ${preview.preview.frames}${of} images. The rest is still downloading.`}
          </p>
          {progress === null ? (
            <progress className={styles.progress} aria-label="Fetching the remaining images" />
          ) : (
            <progress className={styles.progress} value={progress} max={1} aria-label="Fetching the remaining images" />
          )}
        </div>
      )}
      {(savedList !== null || missing !== null) && (
        // CLAUDE.md rule 5: say plainly where the list came from and what is missing
        <p className={styles.note} role="note">
          {[savedList !== null ? savedListNote(savedList) : null, missing].filter(Boolean).join(" ")}
        </p>
      )}
      <Viewer
        key={cubeUrl}
        cubeUrl={preview ? preview.preview.cubeUrl : cubeUrl}
        catalogueMotion={catalogueMotion}
        measureUrl={current.step === "ready" && current.measureReady ? measureUrl : null}
        measureState={current.step !== "ready" ? "pending" : current.measureFailed ? "failed" : current.measureReady ? undefined : "measuring"}
      />
    </>
  );
}

/** The line shown above the viewer when the image list came from our saved copy (task C-13). */
export function savedListNote(listed: string): string {
  const when = listedDate(listed);
  return (
    "The archive's search is not answering right now. The image list comes from our copy" +
    (when ? ` of ${when}` : "") +
    "; the images themselves were fetched from the archive just now."
  );
}

export default LiveCube;
