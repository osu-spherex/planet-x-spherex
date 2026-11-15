import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// A merge once dropped a closing brace in Viewer.module.css, which silently switched off every rule
// after it (the "not the target" box, the six-detector grid). Browsers do not complain, so check here.
describe("Viewer.module.css", () => {
  it("has balanced braces", () => {
    const css = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "Viewer.module.css"), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    let depth = 0;
    for (const ch of css) {
      if (ch === "{") depth++;
      if (ch === "}") depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });
});
