// First look (preview=1, backend task C-09) and server restarts while polling (issue #50), task C-10.
import { describe, expect, it } from "vitest";
import { BAND_RANGE_UM, describeJob, previewUrl, waitForJob, type JobState, type PreviewInfo } from "./backend";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function script(answers: Response[]) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    const next = answers.shift();
    if (next === undefined) throw new Error("test script ran out of answers");
    return next;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const noSleep = async () => {};
const BASE = "https://api.example/api/cube?ra=269.4464&dec=4.7666&band=D2";
const S1 = "2026-11-14T08:00:00Z";
const S2 = "2026-11-14T08:05:00Z";
const running = (progress: number, server = S1) =>
  json(202, { status: "downloading", progress, message: "downloaded 3/60 cutouts", server_started_utc: server });
const preview = (progress: number) =>
  json(200, {
    status: "preview",
    complete: false,
    progress,
    message: "first look ready (8 images); downloading the rest",
    n_images: 61,
    shape: [8, 61, 61],
    data_url: "/api/cubes/D2_269.4464_+4.7666.preview/cube.f32",
    server_started_utc: S1,
  });
const done = () => json(200, { status: "done", complete: true, shape: [60, 61, 61], data_url: "/api/cubes/D2_269.4464_+4.7666/cube.f32" });

describe("previewUrl", () => {
  it("adds preview=1 to a job URL", () => {
    expect(previewUrl(BASE)).toBe(`${BASE}&preview=1`);
    expect(previewUrl("http://b/api/cube")).toBe("http://b/api/cube?preview=1");
  });
});

describe("waitForJob with a first look", () => {
  it("reports the preview once, keeps polling, and ends on the full cube", async () => {
    const { fetchImpl, calls } = script([running(0.05), preview(0.2), preview(0.6), done()]);
    const previews: PreviewInfo[] = [];
    const states: JobState[] = [];
    await waitForJob(previewUrl(BASE), {
      fetchImpl,
      sleep: noSleep,
      onPreview: (p) => previews.push(p),
      onUpdate: (s) => states.push(s),
    });
    expect(calls).toHaveLength(4);
    expect(previews).toEqual([
      {
        cubeUrl: "https://api.example/api/cubes/D2_269.4464_+4.7666.preview/cube.json",
        frames: 8,
        images: 61,
        progress: 0.2,
      },
    ]);
    expect(states.map((s) => s.status)).toEqual(["downloading", "preview", "preview"]);
    expect(states[2].progress).toBe(0.6);
  });

  it("without onPreview every 200 still ends the wait at once (old behaviour)", async () => {
    const { fetchImpl, calls } = script([preview(0.2)]);
    await waitForJob(BASE, { fetchImpl, sleep: noSleep });
    expect(calls).toHaveLength(1);
  });
});

describe("waitForJob across a server restart", () => {
  it("says so once and restarts the time budget", async () => {
    let t = 0;
    const { fetchImpl } = script([running(0.5, S1), running(0.7, S1), running(0.05, S2), running(0.3, S2), done()]);
    const states: JobState[] = [];
    await waitForJob(BASE, {
      fetchImpl,
      sleep: async () => {
        t += 100_000; // 100 s per poll: 5 polls would pass the 360 s budget without the reset
      },
      now: () => t,
      onUpdate: (s) => states.push(s),
      onPreview: () => {},
    });
    const statuses = states.map((s) => s.status);
    expect(statuses).toEqual(["downloading", "downloading", "restarted", "downloading"]);
    expect(states[2].message).toMatch(/restarted/);
    expect(describeJob(states[2])).toMatch(/server restarted/);
  });

  it("answers without server_started_utc never count as a restart", async () => {
    const { fetchImpl } = script([
      json(202, { status: "searching", progress: 0 }),
      running(0.1),
      json(202, { status: "downloading", progress: 0.2 }),
      done(),
    ]);
    const states: JobState[] = [];
    await waitForJob(BASE, { fetchImpl, sleep: noSleep, onUpdate: (s) => states.push(s) });
    expect(states.map((s) => s.status)).not.toContain("restarted");
  });
});

describe("describeJob for the new states", () => {
  it("has plain sentences for preview and restarted", () => {
    for (const status of ["preview", "restarted"]) {
      const text = describeJob({ status, progress: null, message: "" });
      expect(text.length).toBeGreaterThan(15);
      expect(text).not.toMatch(/IRSA|TAP|cutout/);
    }
  });
});

describe("detector ranges", () => {
  it("D4 is the mission's published Band 4 range", () => {
    // SPHEREx Archive User Guide, Data Products: "λ= 2.42 - 3.82 µm; R=35"
    expect(BAND_RANGE_UM.D4).toBe("2.42–3.82");
  });
});
