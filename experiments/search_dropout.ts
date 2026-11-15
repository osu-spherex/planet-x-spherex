// A-15 diagnostics (GitHub issue #65): how much does the velocity search's best motion change when
// a few frames are missing, as happens when IRSA fails some cutout downloads of a live cube?
// Leaves out k random frames of a cube (seeded), runs the site's search (A-13 rule, the viewer's
// options) and prints the distance of the best motion from a catalogue motion.
//
//   cd frontend
//   npx vite-node ../experiments/search_dropout.ts <pmRa> <pmDec> <cube dir> <k> <trials> [seed]
//   e.g. npx vite-node ../experiments/search_dropout.ts -0.80155 10.36239 ../data/cubes/barnard/D1 3 20
import { readFileSync } from "node:fs";
import path from "node:path";
import { velocityGrid } from "../frontend/search/grid";

const [pmRa, pmDec] = process.argv.slice(2, 4).map(Number);
const dir = process.argv[4];
const k = Number(process.argv[5] ?? 3);
const trials = Number(process.argv[6] ?? 20);
let seed = Number(process.argv[7] ?? 1);
const rand = () => {
  // mulberry32, as in frontend/search/significance.ts
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const meta = JSON.parse(readFileSync(path.join(dir, "cube.json"), "utf8"));
const buf = readFileSync(path.join(dir, meta.data_url));
const all = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const [n, h, w] = meta.shape;
const px = (arcsec: number) => arcsec / meta.pixscale_arcsec;

function subset(keep: number[]) {
  const data = new Float32Array(keep.length * h * w);
  keep.forEach((f, i) => data.set(all.subarray(f * h * w, (f + 1) * h * w), i * h * w));
  return { n: keep.length, h, w, data, meta: { ...meta, shape: [keep.length, h, w], frames: keep.map((f) => meta.frames[f]) } };
}

const offs: number[] = [];
for (let t = 0; t < trials; t++) {
  const drop = new Set<number>();
  while (drop.size < k) drop.add(Math.floor(rand() * n));
  const keep = [...Array(n).keys()].filter((f) => !drop.has(f));
  const r = velocityGrid(subset(keep), { radius: px(12), noiseBox: px(90) });
  const off = Math.hypot(r.best.pmRa - pmRa, r.best.pmDec - pmDec);
  offs.push(off);
  const visits = [...drop].sort((a, b) => a - b).map((f) => meta.frames[f].epoch).join("");
  console.log(`trial ${t + 1}: dropped frames ${[...drop].sort((a, b) => a - b).join(",")} (visits ${visits}) -> best (${r.best.pmRa.toFixed(2)}, ${r.best.pmDec.toFixed(2)}), ${off.toFixed(2)} from the catalogue`);
}
const within = offs.filter((o) => o < 2).length;
console.log(`${path.resolve(dir)}: ${n} frames, ${k} left out, ${trials} trials: within 2 arcsec/yr in ${within}, worst ${Math.max(...offs).toFixed(2)}, median ${offs.slice().sort((a, b) => a - b)[Math.floor(trials / 2)].toFixed(2)}`);
