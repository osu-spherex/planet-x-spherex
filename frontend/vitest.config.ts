import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests run in plain Node by default (fast; enough for cube maths, coordinate parsing, stacking).
// A test that needs a DOM adds this as its first line:  // @vitest-environment jsdom
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**", ".next/**"],
  },
});
