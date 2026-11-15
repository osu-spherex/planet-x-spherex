// A-15 diagnostics (GitHub issue #65): run the site's own velocity search (frontend/search) on any
// cube folder (cube.json + cube.f32), with the options the viewer uses: 12" search radius around
// the cube centre and a 90" stacking box (frontend/viewer/Search.tsx). Prints the best motion with
// the A-13 common-brightness rule ("auto", what the site does) and without it ("off", the search
// as it was when issue #65 was written), and the distance from a catalogue motion.
//
//   cd frontend
//   npx vite-node ../experiments/search_cube.ts <pmRa> <pmDec> <cube dir> [<cube dir> ...]
//   e.g. Barnard's Star, Gaia DR3 (data/cubes/barnard/catalog.json):
//   npx vite-node ../experiments/search_cube.ts -0.80155 10.36239 ../data/cubes/barnard/D1
//
// A diagnostic tool, not part of the site; the numbers the site quotes are checked by
// frontend/search/numbers.test.ts.
import { readFileSync } from "node:fs";
import path from "node:path";
import { velocityGrid } from "../frontend/search/grid";

const [pmRa, pmDec] = process.argv.slice(2, 4).map(Number);
const dirs = process.argv.slice(4);
if (!Number.isFinite(pmRa) || !Number.isFinite(pmDec) || dirs.length === 0) {
  console.error("usage: search_cube.ts <catalogue pmRa> <catalogue pmDec> <cube dir> [<cube dir> ...]   (arcsec/yr)");
  process.exit(2);
}

for (const dir of dirs) {
  const meta = JSON.parse(readFileSync(path.join(dir, "cube.json"), "utf8"));
  const buf = readFileSync(path.join(dir, meta.data_url));
  const data = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const [n, h, w] = meta.shape;
  const cube = { n, h, w, data, meta };
  const px = (arcsec: number) => arcsec / meta.pixscale_arcsec;
  for (const normalise of ["auto", "off"] as const) {
    const r = velocityGrid(cube, { radius: px(12), noiseBox: px(90), normalise });
    const off = Math.hypot(r.best.pmRa - pmRa, r.best.pmDec - pmDec);
    console.log(
      `${path.basename(path.resolve(dir))} [${normalise}] ${n} frames, ${w} px: best (${r.best.pmRa.toFixed(2)}, ${r.best.pmDec.toFixed(2)}), ` +
        `${off.toFixed(2)} from the catalogue | grid best (${r.gridBest.pmRa.toFixed(2)}, ${r.gridBest.pmDec.toFixed(2)}) SNR ${r.gridBest.snr.toFixed(1)} ` +
        `| step ${r.step.toFixed(2)}, ${r.baselineYears.toFixed(3)} yr, common brightness ${r.normalised ? `yes (${r.framesUsed} frames)` : "no"}, peak fit ${r.fitted ? "yes" : "no"}`,
    );
  }
}
