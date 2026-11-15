// Talking to the FastAPI backend for positions that have no precomputed cube.
//
// GET <backend>/api/cube?ra=&dec=&band=    (and /api/measure, same protocol; backend/app.py)
//   202 { status: "queued" | "searching" | "downloading" | "building" | "measuring", progress, message }
//       -> the job is running; ask again in a few seconds
//   200 the finished cube.json / measurement
//   404 { status: "empty" }        SPHEREx has no image of this position in this detector
//   502 { status: "error" }, 503 { status: "unavailable" }   something failed on the way to IRSA
//   429 { status: "limited", retry_after }   too many requests from one address (backend/limits.py);
//       not a failure: wait retry_after seconds and ask again (Issue #50)
// A first request takes one to two minutes: the archive search is slow and about 60 images of
// 4 MB each are downloaded. The free server also sleeps when unused and needs up to a minute to
// wake, during which requests fail at the network level; those are retried.

import { toParam, type SkyPosition } from "./coords";

export const BANDS = ["D1", "D2", "D3", "D4", "D5", "D6"] as const;
export type Band = (typeof BANDS)[number];

export function isBand(v: string | null | undefined): v is Band {
  return (BANDS as readonly string[]).includes(v ?? "");
}

/**
 * Wavelength range each detector covers, micrometres. D1, D2, D3, D5, D6: lowest and highest
 * `lam_um` over all frames of our cubes of the five demo objects (data/cubes, docs/progress/A.md
 * 2026-11-14). D4 is not in our data: its range is the mission's own value for Band 4,
 * "λ= 2.42 - 3.82 µm; R=35", from the SPHEREx Archive User Guide, Data Products page, section
 * "Spectral Image Multi-Extension FITS Files (MEF)", HDU 1: IMAGE
 * (https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products, read 2026-11-14).
 */
export const BAND_RANGE_UM: Record<Band, string> = {
  D1: "0.74–1.11",
  D2: "1.09–1.64",
  D3: "1.61–2.42",
  D4: "2.42–3.82",
  D5: "3.81–4.40",
  D6: "4.41–5.00",
};

/** Base URL of the backend from the build-time setting, without a trailing slash; null if unset. */
export function backendBase(value: string | undefined = process.env.NEXT_PUBLIC_BACKEND_URL): string | null {
  const v = (value ?? "").trim().replace(/\/+$/, "");
  return v === "" ? null : v;
}

/** Field of view the backend can build, arcminutes (data/cube.py, task A-10). 3 is the default. */
export const FOVS = [3, 6, 10] as const;
export type Fov = (typeof FOVS)[number];

export function isFov(v: number | null | undefined): v is Fov {
  return (FOVS as readonly number[]).includes(v as number);
}

/** `fov` is left out of the URL when it is the default 3, so old links and cached answers stay valid. */
export function apiUrl(base: string, kind: "cube" | "measure", p: SkyPosition, band: Band, fov: Fov = 3): string {
  const size = fov === 3 ? "" : `&fov=${fov}`;
  return `${base}/api/${kind}?ra=${toParam(p.ra)}&dec=${toParam(p.dec)}&band=${band}${size}`;
}

export interface JobState {
  /** Backend job status, or "connecting" while the server does not answer yet. */
  status: string;
  /** 0..1, or null when unknown. */
  progress: number | null;
  message: string;
  /** "saved" when the image list came from our saved copy because the archive's search is down (C-13). */
  listing?: string | null;
  /** Date of that saved list, e.g. "2026-11-14". */
  listed?: string | null;
}

/** What the final answer said about where the image list came from. */
export interface JobResult {
  listing: string | null;
  listed: string | null;
  /** Images asked for and, of those, not delivered by the archive (C-12); null if the answer did not say. */
  frames?: number | null;
  failed?: number | null;
}

/** The job ended without a result; `message` is fit to show to a person. */
export class JobError extends Error {
  readonly status: string;
  constructor(status: string, message: string) {
    super(message);
    this.name = "JobError";
    this.status = status;
  }
}

/** A first look the backend built from a few images of every visit (`/api/cube?...&preview=1`). */
export interface PreviewInfo {
  /** cube.json of the preview, absolute; stays valid until the server restarts. */
  cubeUrl: string;
  /** Images in the preview. */
  frames: number;
  /** Images SPHEREx has of this position in this detector (the full cube may use fewer). */
  images: number | null;
  progress: number | null;
  listing?: string | null;
  listed?: string | null;
}

/** The same job URL, asking the backend for a first look while the full cube downloads. */
export function previewUrl(url: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}preview=1`;
}

export interface WaitOptions {
  fetchImpl?: typeof fetch;
  /** Pause between polls, ms. */
  intervalMs?: number;
  /** Give up after this long, ms. */
  timeoutMs?: number;
  /** Network failures in a row before giving up (the server may be waking). */
  maxNetworkFailures?: number;
  signal?: AbortSignal;
  onUpdate?: (state: JobState) => void;
  /**
   * Called with each new first look (a 200 answer with `status: "preview", complete: false`, which
   * only comes when the URL has `preview=1`). Polling goes on until the full cube is there. Without
   * this option every 200 ends the wait, as before.
   */
  onPreview?: (preview: PreviewInfo) => void;
  /** For tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Longest and default wait after a 429, seconds (the backend asks for 15 to 60). */
const MAX_RETRY_AFTER_S = 60;
const DEFAULT_RETRY_AFTER_S = 15;

/** Sent by the backend when NASA's image search is down and no saved list covers the position (C-13). */
export const SEARCH_DOWN_TEXT =
  "NASA's archive search is not answering, so new positions cannot be looked up right now. The five example objects above still work.";
const STILL_WORK = " The five example objects above still work.";

/**
 * A sentence for a person. The backend's own message can carry status codes and URLs (for example
 * "502 Server Error: Proxy Error for url ..."), so it goes to the console, not onto the page (C-12/C-13).
 */
function describeFailure(status: string, http: number, message: string, reason = ""): string {
  if (message) console.warn(`backend: ${status || http}: ${message}`);
  if (reason === "search_down") return SEARCH_DOWN_TEXT;
  if (status === "empty" || http === 404) {
    return "SPHEREx has no images of this position in this detector. Try another detector.";
  }
  if (http === 422) return "The server did not accept this position.";
  if (status === "unavailable" || http === 503) return `The image service is not available right now.${STILL_WORK}`;
  return `The archive could not be reached. Try again in a minute.${STILL_WORK}`;
}

/** "52 of 60 images; 8 could not be downloaded from the archive." -- or null when nothing is missing (C-12). */
export function missingImagesNote(frames: number | null | undefined, failed: number | null | undefined): string | null {
  if (!frames || !failed || failed <= 0) return null;
  return `${frames - failed} of ${frames} images; ${failed} could not be downloaded from the archive. They are asked for again in a few minutes.`;
}

/** "2026-11-14" -> "14 Nov 2026" (UTC); anything else is returned as it is. */
export function listedDate(listed: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(listed ?? "");
  if (!m) return listed ?? "";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${Number(m[3])} ${months[Number(m[2]) - 1]} ${m[1]}`;
}

/**
 * Poll a job URL until the backend answers 200. Resolves with nothing: the caller then loads the
 * same URL, which the backend now answers from its cache. Rejects with JobError when the job
 * fails, and with the signal's reason when aborted.
 */
export async function waitForJob(url: string, options: WaitOptions = {}): Promise<JobResult | undefined> {
  const {
    fetchImpl = fetch,
    intervalMs = 3000,
    timeoutMs = 6 * 60 * 1000,
    maxNetworkFailures = 20,
    signal,
    onUpdate,
    onPreview,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
  } = options;
  let started = now();
  let failures = 0;
  // Every job answer says when the server process started (backend/app.py). If that changes while
  // we poll, the server restarted (usually a deploy): our job was lost and the next poll began it
  // again from the start. Say so, and give the new run the full time budget.
  let serverStarted: string | null = null;
  let lastPreview = "";
  const restarted = (body: { server_started_utc?: unknown }): boolean => {
    const s = typeof body.server_started_utc === "string" ? body.server_started_utc : null;
    if (s === null) return false;
    if (serverStarted === null) serverStarted = s;
    if (s === serverStarted) return false;
    serverStarted = s;
    started = now();
    onUpdate?.({
      status: "restarted",
      progress: null,
      message: "The server restarted; starting again.",
    });
    return true;
  };

  for (;;) {
    signal?.throwIfAborted();
    let res: Response | null = null;
    try {
      res = await fetchImpl(url, { signal });
    } catch (err) {
      signal?.throwIfAborted();
      failures += 1;
      if (failures > maxNetworkFailures) {
        throw new JobError("unreachable", "The server did not answer. Check your connection and try again.");
      }
      onUpdate?.({ status: "connecting", progress: null, message: err instanceof Error ? err.message : String(err) });
    }

    if (res) {
      failures = 0;
      if (res.status === 200 && !onPreview) return;
      let body: {
        status?: unknown; progress?: unknown; message?: unknown; detail?: unknown; retry_after?: unknown;
        server_started_utc?: unknown; complete?: unknown; data_url?: unknown; shape?: unknown; n_images?: unknown;
        listing?: unknown; listed?: unknown; reason?: unknown; n_frames?: unknown; n_failed?: unknown;
      } = {};
      try {
        body = (await res.json()) as typeof body;
      } catch {
        // not JSON: handled below by the HTTP status alone
      }
      const status = typeof body.status === "string" ? body.status : "";
      const message = typeof body.message === "string" ? body.message : "";
      const progress = typeof body.progress === "number" ? body.progress : null;
      const listing = typeof body.listing === "string" ? body.listing : null;
      const listed = typeof body.listed === "string" ? body.listed : null;
      // only when the saved list was used, so answers from a working search look exactly as before
      const listingInfo = listing ? { listing, listed } : {};
      const wasRestart = restarted(body);
      if (res.status === 200) {
        if (status !== "preview" || body.complete !== false) {
          // the full cube
          return {
            listing,
            listed,
            frames: typeof body.n_frames === "number" ? body.n_frames : null,
            failed: typeof body.n_failed === "number" ? body.n_failed : null,
          };
        }
        const dataUrl = typeof body.data_url === "string" ? body.data_url : "";
        const shape = Array.isArray(body.shape) ? body.shape : [];
        if (dataUrl && onPreview) {
          const cubeUrl = new URL(dataUrl.replace(/[^/]*$/, "cube.json"), url).toString();
          if (cubeUrl !== lastPreview) {
            lastPreview = cubeUrl;
            onPreview({
              cubeUrl,
              frames: typeof shape[0] === "number" ? shape[0] : 0,
              images: typeof body.n_images === "number" ? body.n_images : null,
              progress,
              ...listingInfo,
            });
          }
        }
        if (!wasRestart) onUpdate?.({ status: "preview", progress, message });
        if (now() - started > timeoutMs) {
          throw new JobError("timeout", "This is taking longer than it should. The archive may be busy; try again later.");
        }
        await sleep(intervalMs);
        continue;
      }
      if (res.status === 429) {
        // Over the per-address limit: the backend says when to come back. Wait and ask again
        // instead of showing an error; the overall time limit below still applies.
        const header = Number(res.headers.get("retry-after"));
        const asked = typeof body.retry_after === "number" ? body.retry_after : header;
        const waitS = Number.isFinite(asked) && asked > 0 ? Math.min(asked, MAX_RETRY_AFTER_S) : DEFAULT_RETRY_AFTER_S;
        onUpdate?.({ status: "limited", progress: null, message });
        if (now() - started > timeoutMs) {
          throw new JobError("limited", "Too many requests are coming from your network right now. Try again in a minute.");
        }
        await sleep(waitS * 1000);
        continue;
      }
      if (res.status !== 202) {
        const reason = typeof body.reason === "string" ? body.reason : "";
        throw new JobError(status || `http-${res.status}`, describeFailure(status, res.status, message, reason));
      }
      if (!wasRestart) onUpdate?.({ status: status || "queued", progress, message, ...listingInfo });
    }

    if (now() - started > timeoutMs) {
      throw new JobError("timeout", "This is taking longer than it should. The archive may be busy; try again later.");
    }
    await sleep(intervalMs);
  }
}

/** One line for the person watching the progress bar. */
export function describeJob(state: JobState | null): string {
  switch (state?.status) {
    case undefined:
    case "connecting":
      return "Waking up the server. It sleeps when nobody uses it; this can take a minute.";
    case "queued":
      return "Waiting for a free slot.";
    case "restarted":
      return "The server restarted (an update was installed), so this position is being prepared again from the start.";
    case "preview":
      return "First look ready. The rest of the images are still downloading.";
    case "limited":
      return "Many requests are coming from your network at the moment. This one starts by itself in a moment; the five example objects open without waiting.";
    case "searching":
      return "Searching NASA’s archive for SPHEREx images of this position.";
    case "downloading": {
      // the backend says e.g. "downloaded 43/45 cutouts": keep the count, drop the jargon
      const count = /(\d+)\s*(?:\/|of)\s*(\d+)/.exec(state.message);
      return count ? `Downloading the images: ${count[1]} of ${count[2]}.` : "Downloading the images.";
    }
    case "building":
      return "Lining the images up with each other.";
    case "measuring":
      return "Measuring the source in every image.";
    default:
      return state?.message || "Working.";
  }
}
