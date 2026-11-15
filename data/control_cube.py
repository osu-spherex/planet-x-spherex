"""Control cube for the velocity search: blank sky next to WISE 0855, same exposures (GitHub issue #21).

The motion search (frontend/search/grid.ts) tries many motion vectors and keeps the brightest
stack. Trying many vectors on pure noise also produces a brightest stack, so a detection only
means something if the same search on empty sky gives clearly less. This cube is that empty sky.

Position: RA 133.72167, Dec -7.28755, which is 215" from WISE 0855 at position angle 220 deg
(south-west). Chosen on 2026-11-14 from catalogues queried through IRSA TAP within 6' of WISE 0855
(1299 CatWISE2020 sources, 270 Gaia DR3 sources), as the point 2.5'-4' away that is farthest from
any CatWISE source brighter than W2 = 16.5:
  * nearest CatWISE source with W2 < 16.5: 46" away;
  * CatWISE sources within 30": three, W2 = 16.57, 16.91 and 17.02. CatWISE lists WISE 0855
    itself at W2 = 15.72, so each is at most 46% of its flux at 4.6 um;
  * Gaia DR3 within 45": two stars, G = 19.2 and 20.6.
The 3' field is not empty: its brightest CatWISE source has W2 = 13.78. "Blank" refers to the
central 30", which is where the search looks.

Only exposures that are also in the WISE 0855 D6 cube are used, so the time sampling is the same.

Usage:  python -m data.control_cube        (downloads about 45 cutouts from IRSA on first run)
"""
import csv
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

from data import cube

OBJECT, PARENT, BAND = "wise0855_control", "wise0855", "D6"
RA, DEC = 133.72167, -7.28755
SIZE_DEG = 0.05  # same cutout size as the demo cache
FIELDS = ["object", "band", "mjd", "uri", "center_ra", "center_dec", "size_deg", "file", "bytes", "downloaded_utc"]


def cache_dir():
    return cube.cache_dir().parent / "cache_control"


def exposure(name):
    return name.split("_spx")[0]


def fetch(cache=None):
    """Download the control cutouts and write a manifest in the format of experiments/prefetch_cache.py."""
    from backend import irsa  # retry, at most 8 concurrent requests, FITS completeness check
    cache = Path(cache or cache_dir())
    parent = json.loads((cube.REPO / "data" / "cubes" / PARENT / BAND / "cube.json").read_text(encoding="utf-8"))
    wanted = {exposure(f["id"]) for f in parent["frames"]}
    client = irsa.IrsaClient(cache / "_irsa")
    rows = [r for r in client.query_images(RA, DEC, f"SPHEREx-{BAND}") if exposure(Path(r["uri"]).name) in wanted]
    print(f"{len(rows)} of the {len(wanted)} exposures of the {PARENT} {BAND} cube also cover the control position")
    got = client.fetch_cutouts([r["uri"] for r in rows], RA, DEC, SIZE_DEG)
    out, failed = [], 0
    for r, p in zip(rows, got):
        if not isinstance(p, Path):
            failed += 1
            print(f"  failed: {Path(r['uri']).name}: {p}")
            continue
        rel = f"{OBJECT}/{BAND}/{Path(r['uri']).name}"
        dest = cache / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        if not dest.exists():
            shutil.copyfile(p, dest)
        stamp = datetime.fromtimestamp(dest.stat().st_mtime, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        out.append(dict(object=OBJECT, band=f"SPHEREx-{BAND}", mjd=f"{float(r['mjd']):.6f}", uri=r["uri"],
                        center_ra=f"{RA:.7f}", center_dec=f"{DEC:.7f}", size_deg=SIZE_DEG, file=rel,
                        bytes=dest.stat().st_size, downloaded_utc=stamp))
    with open(cache / "manifest.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(sorted(out, key=lambda r: float(r["mjd"])))
    print(f"{len(out)} cutouts in {cache} ({failed} failed)")
    return failed


def main(argv=None):
    cache = cache_dir()
    if "--no-fetch" not in (argv or sys.argv[1:]):
        if fetch(cache):
            print("some downloads failed; run again to fetch the rest before building the cube")
            return 1
    meta, data, flags = cube.build_cube(OBJECT, BAND, cache, with_flags=True)
    meta["control"] = dict(of=PARENT, offset_arcsec=215, position_angle_deg=220,
                           note="blank sky: no CatWISE2020 source with W2 < 16.5 within 46 arcsec of the centre")
    out = cube.write_cube(meta, data, cube.REPO / "data" / "cubes" / OBJECT / BAND, flags)
    print(f"{OBJECT} {BAND}: {meta['shape'][0]} frames in {len(meta['epochs'])} epochs -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
