import { describe, expect, it } from "vitest";
import { wakeBackend, wakeUrl } from "./wake";

describe("wakeBackend", () => {
  it("requests /health of the configured backend once", () => {
    const calls: [string, RequestInit | undefined][] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push([String(input), init]);
      return new Response("{}");
    }) as typeof fetch;
    expect(wakeBackend("https://api.example.org", fetchImpl)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("https://api.example.org/health");
    expect(calls[0][1]?.mode).toBe("no-cors");
  });

  it("does nothing without a backend", () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}");
    }) as typeof fetch;
    expect(wakeUrl(null)).toBeNull();
    expect(wakeBackend(null, fetchImpl)).toBe(false);
    expect(called).toBe(false);
  });

  it("swallows a network failure (the server is still asleep)", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    expect(wakeBackend("https://api.example.org", fetchImpl)).toBe(true);
    await new Promise((r) => setTimeout(r, 0)); // an unhandled rejection would fail the run
  });

  it("swallows a fetch that throws synchronously", () => {
    const fetchImpl = (() => {
      throw new Error("no fetch here");
    }) as unknown as typeof fetch;
    expect(wakeBackend("https://api.example.org", fetchImpl)).toBe(false);
  });
});
