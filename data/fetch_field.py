"""Download the SPHEREx cutouts of one position into a local cache folder, with a manifest.

For fields that are not part of the pre-fetched demo cache, e.g. a wide field for task A-10.
Uses the backend's IRSA client (retry on 503, at most 8 requests at a time, complete-file check)
and writes a `manifest.csv` in the format of experiments/prefetch_cache.py, so that
`data.cube.build_cube(object, band, cache, fov_arcmin)` works on the result.

Usage:  python -m data.fetch_field wise0855_2010 133.79513 -7.24515 D6 --fov 6
        (default cache folder: data/cache_fov next to data/cache; not in git)
"""
import argparse
import csv
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

from data import cube

FIELDS = ["object", "band", "mjd", "uri", "center_ra", "center_dec", "size_deg", "file", "bytes", "downloaded_utc"]


def default_cache():
    return cube.cache_dir().parent / "cache_fov"


def listed_images(list_cache, list_object, band):
    """[{uri, mjd}] of one object and detector from the manifest of another cache: the image list
    IRSA gave when that cache was filled."""
    path = Path(list_cache) / "manifest.csv"
    with open(path, newline="", encoding="utf-8") as f:
        rows = [dict(uri=r["uri"], mjd=float(r["mjd"])) for r in csv.DictReader(f)
                if r["object"] == list_object and r["band"] == f"SPHEREx-{band}"]
    if not rows:
        raise ValueError(f"no images of {list_object!r}, detector {band} in {path}")
    return sorted(rows, key=lambda r: r["mjd"])


def fetch_field(obj, ra, dec, band, fov_arcmin=cube.DEFAULT_FOV, cache=None, limit=None, list_from=None):
    """Fetch every image of `band` covering (ra, dec) as a cutout wide enough for `fov_arcmin`.

    Returns the number of failed downloads. Rows of other objects already in the manifest are kept.
    `limit`: keep at most this many images, spread evenly in time (deep fields have hundreds).
    `list_from`: (cache folder, object) -- take the image list from that cache's manifest instead of
    asking IRSA's TAP service, for a field whose images are already known (the same position at
    another size). The cutouts themselves still come from IRSA. Needed when TAP is down while the
    cutout service works (2026-11-14 18:43 UTC: /TAP/availability answered 502, cutouts 200).
    """
    from backend import irsa  # needs `requests`; imported here so the module loads without it
    cache = Path(cache or default_cache())
    band = cube.short_band(band)
    size = cube.cutout_size_deg(fov_arcmin)
    client = irsa.IrsaClient(cache / "_irsa")
    rows = listed_images(*list_from, band) if list_from else client.query_images(ra, dec, f"SPHEREx-{band}")
    if limit and len(rows) > limit:
        step = (len(rows) - 1) / (limit - 1)
        rows = [rows[round(i * step)] for i in range(limit)]
    print(f"{obj} {band}: {len(rows)} images, cutout size {size} deg for a {fov_arcmin}' field")
    got = client.fetch_cutouts([r["uri"] for r in rows], ra, dec, size)

    out, failed = [], 0
    for r, p in zip(rows, got):
        if not isinstance(p, Path):
            failed += 1
            print(f"  failed: {Path(r['uri']).name}: {p}")
            continue
        rel = f"{obj}/{band}/{Path(r['uri']).name}"
        dest = cache / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        if not dest.exists():
            shutil.copyfile(p, dest)
        stamp = datetime.fromtimestamp(dest.stat().st_mtime, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        out.append(dict(object=obj, band=f"SPHEREx-{band}", mjd=f"{float(r['mjd']):.6f}", uri=r["uri"],
                        center_ra=f"{ra:.7f}", center_dec=f"{dec:.7f}", size_deg=size, file=rel,
                        bytes=dest.stat().st_size, downloaded_utc=stamp))

    manifest = cache / "manifest.csv"
    kept = []
    if manifest.exists():
        with open(manifest, newline="", encoding="utf-8") as f:
            kept = [r for r in csv.DictReader(f) if not (r["object"] == obj and r["band"] == f"SPHEREx-{band}")]
    with open(manifest, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(sorted(kept + out, key=lambda r: (r["object"], r["band"], float(r["mjd"]))))
    print(f"{len(out)} cutouts in {cache} ({failed} failed)")
    return failed


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("object", help="name for this field in the manifest, e.g. wise0855_2010")
    ap.add_argument("ra", type=float)
    ap.add_argument("dec", type=float)
    ap.add_argument("band")
    ap.add_argument("--fov", type=int, default=cube.DEFAULT_FOV, choices=sorted(cube.CUTOUT_SIZE_DEG))
    ap.add_argument("--cache-dir", type=Path)
    ap.add_argument("--limit", type=int)
    ap.add_argument("--list-from", nargs=2, metavar=("CACHE_DIR", "OBJECT"),
                    help="take the image list from this cache's manifest instead of IRSA TAP")
    args = ap.parse_args(argv)
    return 1 if fetch_field(args.object, args.ra, args.dec, args.band, args.fov, args.cache_dir, args.limit,
                            args.list_from) else 0


if __name__ == "__main__":
    sys.exit(main())
