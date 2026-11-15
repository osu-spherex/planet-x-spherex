// Copy the static demo cubes (data/cubes/, role A) into frontend/public/cubes/ so the frontend
// serves them from its own origin at /cubes/<obj>/<band>/cube.json. The 5-object demo then works
// even while the free Render backend is asleep (GitHub issue #16, docs/ARCHITECTURE.md).
//
// Runs before `next build` on Vercel (frontend/vercel.json). Locally, run it once before
// `npm run dev` if the frontend should load the cubes from itself:
//     node deploy/copy-cubes.mjs
// Only the files the site needs are copied (see KEEP below), for every object and every detector
// folder D1..D6 that exists; quicklook PNGs stay out. The total size is printed for the build log.
import { cpSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = process.env.OSU_CUBES_DIR ? resolve(process.env.OSU_CUBES_DIR) : join(repo, "data", "cubes");
const dst = join(repo, "frontend", "public", "cubes");
// spectrum.json, catalog.json (per object) and flags.u8 (per detector): interface additions of 11/14 14:30
const KEEP = new Set(["cube.json", "cube.f32", "measure.json", "coverage.json", "spectrum.json", "catalog.json", "flags.u8", "motion.json"]);

if (!existsSync(src)) {
  console.error(`copy-cubes: ${src} does not exist; nothing to copy`);
  process.exit(1);
}
rmSync(dst, { recursive: true, force: true }); // never ship a stale cube

let files = 0;
let bytes = 0;
cpSync(src, dst, {
  recursive: true,
  filter: (p) => {
    if (statSync(p).isDirectory()) return true;
    const name = p.split(/[\\/]/).pop();
    if (!KEEP.has(name)) return false;
    files += 1;
    bytes += statSync(p).size;
    return true;
  },
});

const cubes = [];
const isDir = (p) => statSync(p).isDirectory();
for (const obj of readdirSync(dst).filter((o) => isDir(join(dst, o)))) {
  // an object folder holds band folders plus files such as coverage.json
  for (const band of readdirSync(join(dst, obj)).filter((b) => isDir(join(dst, obj, b)))) {
    if (existsSync(join(dst, obj, band, "cube.json"))) cubes.push(`${obj}/${band}`);
  }
}
if (cubes.length === 0) {
  console.error("copy-cubes: no cube.json found; refusing to build a demo without its cubes");
  process.exit(1);
}
console.log(`copy-cubes: ${files} files, ${(bytes / 1e6).toFixed(2)} MB -> ${relative(repo, dst)} (${cubes.join(", ")})`);
