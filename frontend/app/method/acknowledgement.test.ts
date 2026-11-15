// Issue #116: IRSA asks work that uses SPHEREx data to carry this sentence word for word
// (https://irsa.ipac.caltech.edu/Missions/spherex.html, checked 2026-11-15). The /method page must
// keep it unchanged; line breaks in the source do not matter.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const IRSA_SPHEREX_ACKNOWLEDGEMENT =
  "This publication makes use of data products from the Spectro-Photometer for the History of the Universe, " +
  "Epoch of Reionization and Ices Explorer (SPHEREx), which is a joint project of the Jet Propulsion Laboratory " +
  "and the California Institute of Technology, and is funded by the National Aeronautics and Space Administration.";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("/method data credits", () => {
  it("quote IRSA's SPHEREx acknowledgement exactly", () => {
    const source = readFileSync(path.join(here, "page.tsx"), "utf8").replace(/\s+/g, " ");
    expect(source).toContain(IRSA_SPHEREX_ACKNOWLEDGEMENT);
  });
});
