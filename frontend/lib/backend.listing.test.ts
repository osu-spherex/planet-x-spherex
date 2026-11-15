// Task C-13: saved image list while NASA's search is down, and failure text without raw details.
import { describe, expect, it, vi } from "vitest";
import { savedListNote } from "@/components/LiveCube";
import { JobError, SEARCH_DOWN_TEXT, listedDate, previewUrl, waitForJob, type JobState, type PreviewInfo } from "./backend";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function script(answers: Response[]) {
  const fetchImpl = (async () => {
    const next = answers.shift();
    if (next === undefined) throw new Error("test script ran out of answers");
    return next;
  }) as unknown as typeof fetch;
  return { fetchImpl };
}

const noSleep = async () => {};
const URL0 = "https://api.example/api/cube?ra=133.79513&dec=-7.24515&band=D6";
const SAVED = { listing: "saved", listed: "2026-11-14", listing_object: "wise0855", listing_sep_arcmin: 0.01 };

describe("saved image list (archive search down)", () => {
  it("passes listing through progress, first look and the final answer", async () => {
    const { fetchImpl } = script([
      json(202, { status: "downloading", progress: 0.3, message: "downloading 9 cutouts", ...SAVED }),
      json(200, {
        status: "preview", complete: false, progress: 0.4, n_images: 9, shape: [6, 121, 121],
        data_url: "/api/cubes/D6_133.7951_-7.2451_f6.preview/cube.f32", ...SAVED,
      }),
      json(200, { status: "done", complete: true, shape: [9, 121, 121], data_url: "/api/cubes/x/cube.f32", ...SAVED }),
    ]);
    const states: JobState[] = [];
    const previews: PreviewInfo[] = [];
    const result = await waitForJob(previewUrl(URL0), {
      fetchImpl, sleep: noSleep, onUpdate: (s) => states.push(s), onPreview: (p) => previews.push(p),
    });
    expect(states[0]).toMatchObject({ status: "downloading", listing: "saved", listed: "2026-11-14" });
    expect(previews[0]).toMatchObject({ listing: "saved", listed: "2026-11-14" });
    expect(result).toEqual({ listing: "saved", listed: "2026-11-14", frames: null, failed: null });
  });

  it("reports no listing when the search works", async () => {
    const { fetchImpl } = script([json(200, { status: "done", complete: true, data_url: "/x/cube.f32" })]);
    const result = await waitForJob(previewUrl(URL0), { fetchImpl, sleep: noSleep, onPreview: () => {} });
    expect(result).toEqual({ listing: null, listed: null, frames: null, failed: null });
  });

  it("writes the note with a readable date", () => {
    expect(listedDate("2026-11-14")).toBe("14 Nov 2026");
    expect(listedDate("")).toBe("");
    expect(savedListNote("2026-11-14")).toBe(
      "The archive's search is not answering right now. The image list comes from our copy of 14 Nov 2026; " +
        "the images themselves were fetched from the archive just now.",
    );
    expect(savedListNote("")).not.toMatch(/ of ;/);
  });
});

describe("failure text has no raw details", () => {
  it("search down far from the five objects: the backend's plain sentence", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetchImpl } = script([json(502, { status: "error", reason: "search_down", message: SEARCH_DOWN_TEXT })]);
    const err = (await waitForJob(URL0, { fetchImpl, sleep: noSleep }).catch((e: unknown) => e)) as JobError;
    expect(err).toBeInstanceOf(JobError);
    expect(err.message).toBe(SEARCH_DOWN_TEXT);
    expect(err.message).toMatch(/five example objects above still work/);
    warn.mockRestore();
  });

  it("never shows status codes or URLs from the backend", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = "IRSA search failed: 502 Server Error: Proxy Error for url: https://irsa.ipac.caltech.edu/TAP/sync";
    for (const [status, http] of [["error", 502], ["unavailable", 503]] as const) {
      const { fetchImpl } = script([json(http, { status, message: raw })]);
      const err = (await waitForJob(URL0, { fetchImpl, sleep: noSleep }).catch((e: unknown) => e)) as JobError;
      expect(err.message).not.toMatch(/502|503|url|http|Proxy/i);
      expect(err.message).toMatch(/five example objects above still work/);
    }
    expect(warn).toHaveBeenCalled(); // the detail is kept for whoever opens the console
    warn.mockRestore();
  });
});

describe("missing images (C-12)", () => {
  it("says how many images are missing only when some are", async () => {
    const { missingImagesNote } = await import("./backend");
    expect(missingImagesNote(60, 8)).toBe(
      "52 of 60 images; 8 could not be downloaded from the archive. They are asked for again in a few minutes.",
    );
    expect(missingImagesNote(60, 0)).toBeNull();
    expect(missingImagesNote(null, null)).toBeNull();
    expect(missingImagesNote(undefined, 3)).toBeNull();
  });

  it("waitForJob hands back n_frames and n_failed of the final answer", async () => {
    const { fetchImpl } = script([json(200, { status: "done", complete: true, n_frames: 60, n_failed: 8, data_url: "/x/cube.f32" })]);
    const result = await waitForJob(previewUrl(URL0), { fetchImpl, sleep: noSleep, onPreview: () => {} });
    expect(result).toEqual({ listing: null, listed: null, frames: 60, failed: 8 });
  });
});
