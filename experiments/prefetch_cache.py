"""Pre-fetch SPHEREx cutouts of the 5 required test objects into data/cache/.

Purpose: the demo must keep working during the hackathon even if IRSA is slow or down.
This is data preparation only -- no measurement happens here, and the FITS files are saved
byte-for-byte as IRSA serves them.

Layout written under the cache directory:
    <object>/<D1..D6>/<original file name>.fits   cutouts, unmodified
    <object>/index.csv                            every SPHEREx image covering the object (all bands)
    manifest.csv                                  one row per cutout on disk
    prefetch_failures.csv                         only if something failed in the last run

Every cutout of an object has the same centre: the position predicted for MJD 61100 from the
catalog proper motion (check_objects.predict), so frames can be compared pixel region to pixel region.

Safe to re-run: files already on disk are skipped, so an interrupted run simply continues.

Usage:  python experiments/prefetch_cache.py [object-key ...] [--cache-dir DIR] [--dry-run]
"""
import argparse
import concurrent.futures as cf
import csv
import os
import shutil
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import requests

from check_objects import OBJECTS, predict, query_all  # same folder; do not copy these

IRSA = "https://irsa.ipac.caltech.edu/"
REF_MJD = 61100.0  # epoch of the common cutout centre
FITS_BLOCK = 2880  # a FITS file is always a whole number of 2880-byte blocks

# What to fetch. `limit` = keep this many images, spread evenly over the time-ordered list.
# R Dra sits in a SPHEREx deep field (584 D1 images), so it is subsampled; its cutout is larger
# because the wing-flux method (experiments/saturated_check.py) needs a background ring out to 15 px.
PLAN = {
    "barnard": dict(bands=["D1", "D2"], size=0.05, limit=None),
    "wise0855": dict(bands=["D5", "D6"], size=0.05, limit=None),
    "epsindb": dict(bands=["D2", "D3"], size=0.05, limit=None),
    "rwaur": dict(bands=["D1", "D2"], size=0.05, limit=None),
    "rdra": dict(bands=["D1"], size=0.07, limit=150),
}

MANIFEST_FIELDS = ["object", "band", "mjd", "uri", "center_ra", "center_dec", "size_deg",
                   "file", "bytes", "downloaded_utc"]
INDEX_FIELDS = ["uri", "band", "mjd"]


def utc_iso(ts=None):
    t = datetime.now(timezone.utc) if ts is None else datetime.fromtimestamp(ts, timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def write_csv(path, fields, rows):
    """Write through a temp file so a crash never leaves a half-written CSV."""
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)
    os.replace(tmp, path)


def read_csv(path):
    if not path.exists():
        return []
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def image_index(key, ra, dec, cache_dir, tries=4):
    """All SPHEREx images covering (ra, dec). IRSA TAP drops connections now and then, so retry;
    if it stays down, fall back to the index saved by an earlier successful run."""
    index_path = cache_dir / key / "index.csv"
    err = None
    for attempt in range(tries):
        if attempt:
            wait = 15 * attempt
            print(f"  TAP query failed ({err}); retrying in {wait}s")
            time.sleep(wait)
        try:
            t = time.time()
            table = query_all(ra, dec)
            rows = [dict(uri=str(r["uri"]), band=str(r["band"]), mjd=float(r["mjd"])) for r in table]
            print(f"  TAP: {len(rows)} images in all bands, {time.time() - t:.0f}s")
            index_path.parent.mkdir(parents=True, exist_ok=True)
            write_csv(index_path, INDEX_FIELDS, rows)
            return rows
        except Exception as e:  # network errors surface as several pyvo/requests types
            err = f"{type(e).__name__}: {e}"[:120]
    saved = read_csv(index_path)
    if saved:
        print(f"  TAP query failed {tries}x ({err}); using saved index {index_path} ({len(saved)} images)")
        return [dict(uri=r["uri"], band=r["band"], mjd=float(r["mjd"])) for r in saved]
    raise RuntimeError(f"TAP query failed {tries}x and no saved index: {err}")


def select(rows, band, limit):
    """Images of one detector in time order; if `limit` is set, an even subsample of that order."""
    sel = sorted((r for r in rows if r["band"] == f"SPHEREx-{band}"), key=lambda r: r["mjd"])
    seen, unique = set(), []
    for r in sel:
        name = os.path.basename(r["uri"])
        if name in seen:
            print(f"  warning: duplicate file name {name}, keeping the first")
            continue
        seen.add(name)
        unique.append(r)
    if limit and len(unique) > limit:
        idx = np.unique(np.round(np.linspace(0, len(unique) - 1, limit)).astype(int))
        unique = [unique[i] for i in idx]
    return unique


def is_fits(path):
    """Cheap completeness check: starts like FITS and has a whole number of 2880-byte blocks."""
    try:
        size = path.stat().st_size
        if size == 0 or size % FITS_BLOCK:
            return False
        with open(path, "rb") as f:
            return f.read(9) == b"SIMPLE  ="
    except OSError:
        return False


_local = threading.local()


def _session():
    if not hasattr(_local, "s"):
        _local.s = requests.Session()
    return _local.s


def fetch(job, retries=2):
    """Download one cutout unless it is already on disk. Returns (status, error)."""
    dest = job["path"]
    if is_fits(dest):
        return "skipped", None
    tmp = dest.with_name(dest.name + ".part")
    err = None
    for attempt in range(retries + 1):
        if attempt:
            time.sleep(3 * attempt)
        try:
            with _session().get(job["url"], stream=True, timeout=(15, 180)) as r:
                r.raise_for_status()
                with open(tmp, "wb") as f:
                    for chunk in r.iter_content(1 << 20):
                        f.write(chunk)
                expected = r.headers.get("Content-Length")
                if expected and not r.headers.get("Content-Encoding") and int(expected) != tmp.stat().st_size:
                    raise ValueError(f"truncated: {tmp.stat().st_size} of {expected} bytes")
            if not is_fits(tmp):
                raise ValueError(f"response is not a complete FITS file ({tmp.stat().st_size} bytes)")
            os.replace(tmp, dest)  # only complete files ever get the final name
            return "downloaded", None
        except Exception as e:
            err = f"{type(e).__name__}: {e}"[:200]
            _local.__dict__.pop("s", None)  # start the next attempt on a fresh connection
    tmp.unlink(missing_ok=True)
    return "failed", err


def free_gb(path):
    while not path.exists():
        path = path.parent
    return shutil.disk_usage(path).free / 1e9


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("objects", nargs="*", default=list(PLAN), help=f"default: {' '.join(PLAN)}")
    ap.add_argument("--cache-dir", type=Path,
                    default=Path(__file__).resolve().parents[1] / "data" / "cache")
    ap.add_argument("--threads", type=int, default=8)
    ap.add_argument("--min-free-gb", type=float, default=10.0,
                    help="refuse to start with less free disk space than this (the full set needs ~3 GB)")
    ap.add_argument("--dry-run", action="store_true", help="query and report, download nothing")
    args = ap.parse_args()
    unknown = [k for k in args.objects if k not in PLAN]
    if unknown:
        ap.error(f"unknown object(s) {unknown}; choose from {list(PLAN)}")

    cache = args.cache_dir.resolve()
    free = free_gb(cache)
    print(f"cache dir: {cache}\nfree disk space: {free:.1f} GB")
    if free < args.min_free_gb:
        sys.exit(f"STOP: less than {args.min_free_gb:g} GB free. Ask a human before continuing "
                 f"(override with --min-free-gb).")

    manifest_path = cache / "manifest.csv"
    manifest = {r["file"]: r for r in read_csv(manifest_path)}
    failures, summary = [], []

    for key in args.objects:
        o, plan = OBJECTS[key], PLAN[key]
        ra, dec = predict(o, REF_MJD)
        ra_s, dec_s = f"{ra:.7f}", f"{dec:.7f}"  # the exact strings sent to IRSA and stored in the manifest
        print(f"\n=== {key} ({o['name']}): centre {ra_s}, {dec_s} at MJD {REF_MJD:.0f}, size {plan['size']} deg ===")
        try:
            rows = image_index(key, ra, dec, cache)
        except RuntimeError as e:
            print(f"  FAILED: {e}")
            for band in plan["bands"]:
                summary.append(dict(object=key, band=band, planned="?", downloaded=0, skipped=0,
                                    failed="query", bytes=0))
            failures.append(dict(object=key, band="*", mjd="", uri="", error=str(e)))
            continue

        for band in plan["bands"]:
            sel = select(rows, band, plan["limit"])
            total = sum(1 for r in rows if r["band"] == f"SPHEREx-{band}")
            jobs = []
            for r in sel:
                name = os.path.basename(r["uri"])
                jobs.append(dict(
                    row=r, rel=f"{key}/{band}/{name}", path=cache / key / band / name,
                    url=f"{IRSA}{r['uri']}?center={ra_s},{dec_s}d&size={plan['size']}"))
            note = f" (even subsample of {total})" if len(sel) < total else ""
            print(f"  {band}: {len(jobs)} images{note}"
                  + (f", MJD {sel[0]['mjd']:.1f} - {sel[-1]['mjd']:.1f}" if sel else ""))
            counts = dict(downloaded=0, skipped=0, failed=0)
            if args.dry_run:
                counts["skipped"] = sum(is_fits(j["path"]) for j in jobs)
            else:
                (cache / key / band).mkdir(parents=True, exist_ok=True)
                with cf.ThreadPoolExecutor(args.threads) as ex:
                    futures = {ex.submit(fetch, j): j for j in jobs}
                    for n, fut in enumerate(cf.as_completed(futures), 1):
                        j, (status, err) = futures[fut], fut.result()
                        counts[status] += 1
                        if status == "failed":
                            failures.append(dict(object=key, band=f"SPHEREx-{band}", mjd=f"{j['row']['mjd']:.6f}",
                                                 uri=j["row"]["uri"], error=err))
                            print(f"    failed: {os.path.basename(j['row']['uri'])}: {err}")
                        if n % 25 == 0 or n == len(jobs):
                            print(f"    {n}/{len(jobs)} done ({counts['downloaded']} new, "
                                  f"{counts['skipped']} already there, {counts['failed']} failed)")
            size_on_disk = 0
            for j in jobs:
                if not is_fits(j["path"]):
                    continue
                st = j["path"].stat()
                size_on_disk += st.st_size
                old = manifest.get(j["rel"], {})
                # keep the original download time for files fetched by an earlier run
                when = old.get("downloaded_utc") if old.get("bytes") == str(st.st_size) else None
                manifest[j["rel"]] = dict(
                    object=key, band=f"SPHEREx-{band}", mjd=f"{j['row']['mjd']:.6f}", uri=j["row"]["uri"],
                    center_ra=ra_s, center_dec=dec_s, size_deg=plan["size"], file=j["rel"],
                    bytes=st.st_size, downloaded_utc=when or utc_iso(st.st_mtime))
            summary.append(dict(object=key, band=band, planned=len(jobs), bytes=size_on_disk, **counts))
        if not args.dry_run:  # save after every object so an interrupted run loses nothing
            rows_out = [r for r in manifest.values() if (cache / r["file"]).exists()]
            rows_out.sort(key=lambda r: (r["object"], r["band"], float(r["mjd"])))
            write_csv(manifest_path, MANIFEST_FIELDS, rows_out)

    fail_path = cache / "prefetch_failures.csv"
    if not args.dry_run:
        if failures:
            write_csv(fail_path, ["object", "band", "mjd", "uri", "error"], failures)
        else:
            fail_path.unlink(missing_ok=True)

    print("\nobject    band  planned  new  already  failed  on disk [MB]")
    for s in summary:
        print(f"{s['object']:<9} {s['band']:<5} {s['planned']!s:>7} {s['downloaded']:>4} {s['skipped']:>8} "
              f"{s['failed']!s:>7} {s['bytes'] / 1e6:>13.1f}")
    n_files = sum(s["planned"] for s in summary if s["planned"] != "?") if args.dry_run else \
        sum(s["downloaded"] + s["skipped"] for s in summary)
    print(f"TOTAL: {n_files} files {'planned' if args.dry_run else 'on disk'}, "
          f"{sum(s['bytes'] for s in summary) / 1e9:.2f} GB on disk, {len(failures)} failed")
    if not args.dry_run:
        print(f"manifest: {manifest_path}" + (f"\nfailures: {fail_path}" if failures else ""))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
