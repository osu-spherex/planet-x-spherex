import { describe, expect, it } from "vitest";
import { longDate } from "../components/ObjectStory";

describe("longDate", () => {
  it("writes an ISO date the way a person reads it", () => {
    expect(longDate("2025-08-27")).toBe("27 August 2025");
    expect(longDate("2026-11-14")).toBe("14 November 2026");
    expect(longDate("2026-01-05")).toBe("5 January 2026");
  });
});
