"""Complete a cache with all six detectors of its objects (task A-08).

The demo caches hold one or two detectors per object. This adds the missing ones, with the same
cutout centre and size the object already has, so every detector's cube lands on the same grid.
Deep fields (R Dra: hundreds of images per detector) are subsampled evenly in time to at most
150 images per detector, the rule of experiments/prefetch_cache.py.

Downloads go through the backend's IRSA client (retry on 503, at most 8 requests at a time,
complete-file check). IRSA refuses part of the requests when it is busy (about one in ten on
2026-11-14), so run it again until it prints "done, 0 failed": a detector with images still
missing keeps a file named INCOMPLETE in its folder and is taken up again, files already in place
are not fetched twice, and the manifest is rewritten after every detector. A detector that was in
the cache before (from experiments/prefetch_cache.py) is never touched.

Usage:  python -m data.fetch_bands [object ...] [--cache-dir DIR] [--limit 150]
        (default cache: data/cache_dr1 next to data/cache)
"""
import argparse
import csv
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from data import cube

BANDS = [f"D{i}" for i in range(1, 7)]
FIELDS = ["object", "band", "mjd", "uri", "center_ra", "center_dec", "size_deg", "file", "bytes", "downloaded_utc"]


def read_manifest(cache):
    with open(Path(cache) / "manifest.csv", newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def write_manifest(cache, rows):
    path = Path(cache) / "manifest.csv"
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(sorted(rows, key=lambda r: (r["object"], r["band"], float(r["mjd"]))))
    os.replace(tmp, path)


def subsample(rows, limit):
    """Even subsample of a time-ordered list (same rule as experiments/prefetch_cache.py)."""
    if not limit or len(rows) <= limit:
        return rows
    idx = np.unique(np.round(np.linspace(0, len(rows) - 1, limit)).astype(int))
    return [rows[i] for i in idx]


MARKER = "INCOMPLETE"


def fetch_object(obj, cache, limit=150, bands=BANDS):
    """Fetch the detectors of `obj` that the manifest does not have yet, or that an earlier run
    left incomplete. Returns the number of failed downloads."""
    from backend import irsa
    cache = Path(cache)
    manifest = read_manifest(cache)
    mine = [r for r in manifest if r["object"] == obj]
    if not mine:
        raise ValueError(f"object {obj!r} is not in {cache / 'manifest.csv'}")
    ra_s, dec_s, size = mine[0]["center_ra"], mine[0]["center_dec"], float(mine[0]["size_deg"])
    ra, dec = float(ra_s), float(dec_s)
    have = {r["band"] for r in mine}
    client = irsa.IrsaClient(cache / "_irsa")
    every = client.query_images(ra, dec)  # one archive search for all detectors
    failed = 0
    for band in bands:
        full = f"SPHEREx-{band}"
        marker = cache / obj / band / MARKER
        if full in have and not marker.exists():
            continue
        seen, rows = set(), []
        for r in sorted((r for r in every if r["band"] == full), key=lambda r: float(r["mjd"])):
            name = os.path.basename(r["uri"])
            if name not in seen:
                seen.add(name)
                rows.append(r)
        total = len(rows)
        rows = subsample(rows, limit)
        dest = {r["uri"]: cache / obj / band / os.path.basename(r["uri"]) for r in rows}
        todo = [r["uri"] for r in rows if not dest[r["uri"]].exists()]
        print(f"{obj} {band}: {len(rows)} images" + (f" (even subsample of {total})" if len(rows) < total else "")
              + f", {len(todo)} to download", flush=True)
        if todo:
            (cache / obj / band).mkdir(parents=True, exist_ok=True)
            for uri, got in zip(todo, client.fetch_cutouts(todo, ra, dec, size)):
                if isinstance(got, Path):
                    shutil.move(str(got), str(dest[uri]))  # move, not copy: 4 MB each, thousands of files
                else:
                    failed += 1
                    print(f"  failed: {os.path.basename(uri)}: {got}", flush=True)
        new = []
        for r in rows:
            p = dest[r["uri"]]
            if p.exists():
                stamp = datetime.fromtimestamp(p.stat().st_mtime, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                new.append(dict(object=obj, band=full, mjd=f"{float(r['mjd']):.6f}", uri=r["uri"], center_ra=ra_s,
                                center_dec=dec_s, size_deg=mine[0]["size_deg"], file=f"{obj}/{band}/{p.name}",
                                bytes=p.stat().st_size, downloaded_utc=stamp))
        manifest = [r for r in read_manifest(cache) if not (r["object"] == obj and r["band"] == full)] + new
        write_manifest(cache, manifest)
        if len(new) < len(rows):
            marker.parent.mkdir(parents=True, exist_ok=True)
            marker.write_text(f"{len(new)} of {len(rows)} images on disk; run python -m data.fetch_bands again", encoding="utf-8")
        elif marker.exists():
            marker.unlink()
        print(f"  {len(new)} of {len(rows)} on disk", flush=True)
    return failed


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("objects", nargs="*")
    ap.add_argument("--cache-dir", type=Path, default=cube.cache_dir().parent / "cache_dr1")
    ap.add_argument("--limit", type=int, default=150, help="most images per detector (default 150)")
    args = ap.parse_args(argv)
    objects = args.objects or sorted({r["object"] for r in read_manifest(args.cache_dir)})
    failed = 0
    for obj in objects:
        try:
            failed += fetch_object(obj, args.cache_dir, args.limit)
        except Exception as e:  # one object failing (archive search down) must not stop the others
            failed += 1
            print(f"{obj}: FAILED: {type(e).__name__}: {e}"[:300], flush=True)
    print(f"done, {failed} failed", flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
