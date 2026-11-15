import { describe, expect, it } from "vitest";

// Proves the test runner works in a fresh checkout (D-01). Real tests live next to the code
// they cover: viewer/*.test.ts, search/*.test.ts, lib/*.test.ts.
describe("skeleton", () => {
  it("runs TypeScript tests", () => {
    const frame = new Float32Array([1, Number.NaN, 3]);
    expect(frame.length).toBe(3);
    expect(Number.isNaN(frame[1])).toBe(true);
  });
});
