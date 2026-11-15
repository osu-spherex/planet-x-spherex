import { describe, expect, it } from "vitest";
import { BANDS, BAND_RANGE_UM, FOVS, JobError, apiUrl, backendBase, describeJob, isBand, isFov, waitForJob, type JobState } from "./backend";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A fake backend answering with the given responses in turn; an Error entry is a network failure. */
function script(answers: (Response | Error)[]) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    const next = answers.shift();
    if (next === undefined) throw new Error("test script ran out of answers");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const noSleep = async () => {};

describe("backend URLs", () => {
  it("drops trailing slashes and treats an empty setting as no backend", () => {
    expect(backendBase("https://osu-spherex-api.onrender.com/")).toBe("https://osu-spherex-api.onrender.com");
    expect(backendBase("http://127.0.0.1:8000")).toBe("http://127.0.0.1:8000");
    expect(backendBase("")).toBeNull();
    expect(backendBase("   ")).toBeNull();
    expect(backendBase(undefined)).toBeNull();
  });

  it("builds /api/cube and /api/measure URLs the backend accepts", () => {
    const p = { ra: 133.795129, dec: -7.245147 };
    expect(apiUrl("http://b", "cube", p, "D6")).toBe("http://b/api/cube?ra=133.79513&dec=-7.24515&band=D6");
    expect(apiUrl("http://b", "measure", p, "D1")).toBe("http://b/api/measure?ra=133.79513&dec=-7.24515&band=D1");
  });

  it("adds fov only when it is not the default 3 arcmin", () => {
    const p = { ra: 133.795129, dec: -7.245147 };
    expect(apiUrl("http://b", "cube", p, "D6", 3)).toBe(apiUrl("http://b", "cube", p, "D6"));
    expect(apiUrl("http://b", "cube", p, "D6", 6)).toBe("http://b/api/cube?ra=133.79513&dec=-7.24515&band=D6&fov=6");
    expect(apiUrl("http://b", "measure", p, "D6", 10)).toBe("http://b/api/measure?ra=133.79513&dec=-7.24515&band=D6&fov=10");
    expect([...FOVS]).toEqual([3, 6, 10]);
    expect(isFov(6)).toBe(true);
    expect(isFov(4)).toBe(false);
    expect(isFov(null)).toBe(false);
  });

  it("knows the six detectors, in wavelength order", () => {
    expect([...BANDS]).toEqual(["D1", "D2", "D3", "D4", "D5", "D6"]);
    expect(isBand("D3")).toBe(true);
    for (const bad of ["D7", "d1", "", null, undefined, "SPHEREx-D1"]) expect(isBand(bad)).toBe(false);
    const edges = BANDS.map((b) => BAND_RANGE_UM[b].split("–").map(Number));
    for (const [lo, hi] of edges) expect(hi).toBeGreaterThan(lo);
    for (let i = 1; i < edges.length; i++) expect(edges[i][1]).toBeGreaterThan(edges[i - 1][1]);
  });
});

describe("waitForJob", () => {
  it("polls while the backend says 202 and reports each state", async () => {
    const { fetchImpl, calls } = script([
      json(202, { status: "searching", progress: 0.05, message: "searching IRSA for SPHEREx images" }),
      json(202, { status: "downloading", progress: 0.4, message: "24 of 60" }),
      json(202, { status: "building", progress: 0.9, message: "aligning 60 frames" }),
      json(200, { status: "done", shape: [60, 61, 61] }),
    ]);
    const seen: JobState[] = [];
    await waitForJob("http://b/api/cube?x", { fetchImpl, sleep: noSleep, onUpdate: (s) => seen.push(s) });
    expect(calls).toHaveLength(4);
    expect(seen.map((s) => s.status)).toEqual(["searching", "downloading", "building"]);
    expect(seen[1]).toEqual({ status: "downloading", progress: 0.4, message: "24 of 60" });
  });

  it("returns at once when the cube is already there", async () => {
    const { fetchImpl, calls } = script([json(200, { status: "done" })]);
    await waitForJob("http://b/api/cube?x", { fetchImpl, sleep: noSleep });
    expect(calls).toHaveLength(1);
  });

  it("keeps trying while the sleeping server does not answer", async () => {
    const { fetchImpl } = script([new TypeError("Failed to fetch"), new TypeError("Failed to fetch"), json(200, {})]);
    const seen: JobState[] = [];
    await waitForJob("http://b/api/cube?x", { fetchImpl, sleep: noSleep, onUpdate: (s) => seen.push(s) });
    expect(seen.map((s) => s.status)).toEqual(["connecting", "connecting"]);
  });

  it("gives up after too many network failures in a row", async () => {
    const { fetchImpl } = script([new TypeError("x"), new TypeError("x"), new TypeError("x")]);
    await expect(
      waitForJob("http://b/api/cube?x", { fetchImpl, sleep: noSleep, maxNetworkFailures: 2 }),
    ).rejects.toMatchObject({ name: "JobError", status: "unreachable" });
  });

  it("turns the backend's failures into sentences for a person", async () => {
    const cases: [Response, string, RegExp][] = [
      [json(404, { status: "empty", message: "no SPHEREx images cover this position in this band" }), "empty", /no images of this position/],
      // C-12/C-13: the backend's raw detail stays off the page (it goes to the console)
      [json(502, { status: "error", message: "IRSA search failed: 503" }), "error", /^The archive could not be reached\. Try again in a minute\. The five example objects above still work\.$/],
      [json(503, { status: "unavailable", message: "" }), "unavailable", /not available right now\./],
      [json(422, { detail: "bad band" }), "http-422", /did not accept this position/],
      [new Response("<html>gateway</html>", { status: 502 }), "http-502", /archive could not be reached\./],
    ];
    for (const [res, status, text] of cases) {
      const { fetchImpl } = script([res]);
      const err = await waitForJob("http://b/api/cube?x", { fetchImpl, sleep: noSleep }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(JobError);
      expect((err as JobError).status).toBe(status);
      expect((err as JobError).message).toMatch(text);
    }
  });

  it("waits and asks again when the backend says 429 (per-address limit), then succeeds", async () => {
    const limited = new Response(JSON.stringify({ status: "limited", progress: 0, message: "busy", retry_after: 15 }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "15" },
    });
    const { fetchImpl, calls } = script([limited, json(202, { status: "searching", progress: 0.1, message: "" }), json(200, {})]);
    const states: JobState[] = [];
    const sleeps: number[] = [];
    await waitForJob("http://b/api/cube?x", {
      fetchImpl,
      sleep: async (ms) => void sleeps.push(ms),
      onUpdate: (s) => states.push(s),
    });
    expect(calls).toHaveLength(3);
    expect(states.map((s) => s.status)).toEqual(["limited", "searching"]);
    expect(sleeps[0]).toBe(15000); // the backend's retry_after, not the 3 s poll interval
    expect(describeJob(states[0])).toMatch(/starts by itself/);
  });

  it("caps a long retry_after at one minute and falls back to 15 s without one", async () => {
    const { fetchImpl } = script([
      json(429, { status: "limited", message: "", retry_after: 600 }),
      json(429, { status: "limited", message: "" }),
      json(200, {}),
    ]);
    const sleeps: number[] = [];
    await waitForJob("http://b/api/cube?x", { fetchImpl, sleep: async (ms) => void sleeps.push(ms) });
    expect(sleeps).toEqual([60000, 15000]);
  });

  it("gives up on 429 only after the time limit, with a sentence about the limit", async () => {
    let t = 0;
    const fetchImpl = (async () => json(429, { status: "limited", message: "", retry_after: 30 })) as typeof fetch;
    const err = await waitForJob("http://b/api/cube?x", {
      fetchImpl,
      timeoutMs: 100_000,
      sleep: async (ms) => void (t += ms),
      now: () => t,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JobError);
    expect((err as JobError).status).toBe("limited");
    expect((err as JobError).message).toMatch(/Too many requests/);
  });

  it("stops after the time limit", async () => {
    const answers = Array.from({ length: 10 }, () => json(202, { status: "downloading", progress: 0.2 }));
    const { fetchImpl, calls } = script(answers);
    let t = 0;
    const err = await waitForJob("http://b/api/cube?x", {
      fetchImpl,
      sleep: async (ms) => {
        t += ms;
      },
      now: () => t,
      intervalMs: 1000,
      timeoutMs: 2500,
    }).catch((e: unknown) => e);
    expect((err as JobError).status).toBe("timeout");
    expect(calls).toHaveLength(4); // t = 0, 1000, 2000, 3000: the last one is past the limit
  });

  it("stops quietly when aborted", async () => {
    const controller = new AbortController();
    const { fetchImpl, calls } = script([json(202, { status: "searching" }), json(202, { status: "searching" })]);
    const run = waitForJob("http://b/api/cube?x", {
      fetchImpl,
      signal: controller.signal,
      sleep: async () => controller.abort(),
    });
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toHaveLength(1);
  });
});

describe("describeJob", () => {
  it("has a plain sentence for every state the backend sends", () => {
    for (const status of ["connecting", "queued", "searching", "downloading", "building", "measuring"]) {
      const text = describeJob({ status, progress: null, message: "" });
      expect(text.length, status).toBeGreaterThan(15);
      expect(text).not.toMatch(/IRSA|TAP|cutout/); // words a visitor does not know
    }
    expect(describeJob(null)).toMatch(/Waking up/);
    expect(describeJob({ status: "downloading", progress: 0.4, message: "24 of 60" })).toBe("Downloading the images: 24 of 60.");
    // what the deployed backend really sends (seen 2026-11-14)
    expect(describeJob({ status: "downloading", progress: 0.9, message: "downloaded 43/45 cutouts" })).toBe(
      "Downloading the images: 43 of 45.",
    );
    expect(describeJob({ status: "downloading", progress: 0.1, message: "" })).toBe("Downloading the images.");
  });
});
