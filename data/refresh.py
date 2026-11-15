"""Bring the static demo data up to date with the archive in one command (task A-12).

    python -m data.refresh [object ...] [--dry-run] [--offline] [--prune]

SPHEREx keeps observing and IRSA keeps re-releasing: new visits appear, and old exposures come
back under a new processing version with a new file name (2026-11-14: quick release -> DR1,
docs/UPDATING.md). For every object of the cache manifest this command

  1. asks IRSA which images cover the object now (one TAP query for all six detectors);
  2. compares that list with the cache BY EXPOSURE, not by file name. A file is
         level2_<week>_<pointing>_<detector>_spx_<version>.fits
     and everything before "_spx" names the exposure. A new exposure is downloaded; an exposure
     that is served under another version replaces the cached file, so no observation enters a cube
     twice; an exposure the archive no longer lists leaves the list. Deep fields keep the rule of
     data/fetch_bands.py: at most 150 images per detector, evenly spread in time;
  3. downloads what is missing (backend IRSA client: retries, at most 8 requests at a time) and
     rewrites the manifest after every detector. If the download of a replacement fails, the old
     version of that exposure stays, and nothing of the object is rebuilt: run the command again;
  4. rebuilds, for every detector of the object, cube.json, cube.f32 and flags.u8 (and quicklook.png
     where the folder has one), then the object's catalog.json, then measure.json of every
     detector with spectrum.json and motion.json (the motion fit takes the parallax of the target
     from catalog.json, so that file comes first), then coverage.json
     (data.cube, data.quicklook, data.catalog, data.measure_static, backend.coverage);
  5. prints what changed: number of frames, date of the last image, release and version.

--dry-run   do steps 1-2 only and list what would be downloaded and written.
--offline   skip the archive: rebuild cubes, measurements, spectra and motion.json from the cache
            as it is (after a change of the code, or while IRSA is down). catalog.json and
            coverage.json come from IRSA and are left alone.
--prune     delete cutouts of this object that the manifest no longer lists (superseded versions).
            Without it they stay on disk and their number is printed.

Not covered: the blank-sky control cube (python -m data.control_cube, it follows the exposures of
wise0855 D6), the backup cubes in data/cubes_qr, and objects that are not in the cache yet
(experiments/prefetch_cache.py or data.fetch_field).
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

from data import cube, fetch_bands

BANDS = fetch_bands.BANDS
# The backend client keeps a TAP answer for 24 h. For a refresh the list has to be current, but a
# dry run followed by the real run should not ask twice (a TAP query takes 8-30 s per object).
TAP_MAX_AGE_S = 3600
# The first OFFLINE_FILES of these are made from the cache alone; the rest need IRSA.
OBJECT_FILES = ("spectrum.json", "motion.json", "catalog.json", "coverage.json")
OFFLINE_FILES = 2
BAND_FILES = ("cube.json", "cube.f32", "flags.u8", "measure.json")  # plus quicklook.png where one exists
SHOW = 10  # file names listed per detector


class RefreshError(RuntimeError):
    """The refresh cannot go on for this object; the message says what to do."""


def exposure(name):
    """'.../level2_2025W35_1A_0432_4D1_spx_l2b-v27-2026-230.fits' -> 'level2_2025W35_1A_0432_4D1'."""
    return os.path.basename(name).split("_spx")[0]


def version(name):
    """Processing version in a file name or frame id: 'l2b-v27-2026-230' ('' if there is none)."""
    stem = os.path.basename(name)
    stem = stem[:-len(".fits")] if stem.endswith(".fits") else stem
    return stem.split("_spx_", 1)[1] if "_spx_" in stem else ""


def version_key(name):
    """Sort key that puts a later processing of the same exposure last: pipeline number, then the
    year and day of processing ('l2b-v27-2026-230', 'l2b_retry-v27-2026-210' -> (27, 2026, 230), (27, 2026, 210))."""
    m = re.search(r"v(\d+)-(\d{4})-(\d{3})$", version(name))
    return (int(m.group(1)), int(m.group(2)), int(m.group(3)), version(name)) if m else (0, 0, 0, version(name))


def short_version(name):
    """Version without the processing date: 'l2b-v27', 'l2b_retry-v27'."""
    return re.sub(r"-\d{4}-\d{3}$", "", version(name))


def release(uri):
    """IRSA path ibe/data/spherex/<release>/level2/...: 'qr2', 'qr3', 'dr1'."""
    return uri.split("/")[3]


def plan_band(have, archive, limit=150):
    """What to do for one detector of one object.

    `have`: manifest rows whose file is on disk. `archive`: rows {uri, mjd} IRSA lists now.
    Returns dict(n_archive, wanted, keep, download, drop): `download` is [(archive row, why)] with
    why "new" or "reprocessed <old version> -> <new version>"; `drop` is [(manifest row, why)].
    """
    if have and not archive:
        # an empty answer is far more likely a fault of the query than 60 images being withdrawn
        raise RefreshError(f"the archive lists no images where the cache has {len(have)}; nothing was changed")
    newest = {}
    for r in archive:  # one exposure, one file: if two versions are served, the later one
        e = exposure(r["uri"])
        if e not in newest or version_key(r["uri"]) > version_key(newest[e]["uri"]):
            newest[e] = r
    every = sorted(newest.values(), key=lambda r: (float(r["mjd"]), r["uri"]))
    wanted = fetch_bands.subsample(every, limit)
    by_uri = {r["uri"]: r for r in have}
    by_exposure = {exposure(r["uri"]): r for r in have}
    keep, download = [], []
    for r in wanted:
        if r["uri"] in by_uri:
            keep.append(by_uri[r["uri"]])
        else:
            old = by_exposure.get(exposure(r["uri"]))
            download.append((r, f"reprocessed {version(old['uri'])} -> {version(r['uri'])}" if old else "new"))
    wanted_uris = {r["uri"] for r in wanted}
    wanted_exposures = {exposure(r["uri"]) for r in wanted}
    drop = []
    for r in sorted(have, key=lambda r: float(r["mjd"])):
        if r["uri"] in wanted_uris:
            continue
        e = exposure(r["uri"])
        drop.append((r, "replaced" if e in wanted_exposures
                     else f"left out by the even subsample of {limit}" if e in newest
                     else "no longer in the archive"))
    return dict(n_archive=len(every), wanted=wanted, keep=keep, download=download, drop=drop)


def object_rows(obj, cache):
    rows = [r for r in fetch_bands.read_manifest(cache) if r["object"] == obj]
    if not rows:
        raise RefreshError(f"object {obj!r} is not in {Path(cache) / 'manifest.csv'}; a new object is first fetched "
                           f"with experiments/prefetch_cache.py or data.fetch_field")
    return rows


def plan_object(obj, cache, client, limit=150):
    """({band: plan_band result}, time of the archive answer). One TAP query for all detectors."""
    cache = Path(cache)
    mine = object_rows(obj, cache)
    listed, meta = client.query_images_meta(float(mine[0]["center_ra"]), float(mine[0]["center_dec"]))
    if meta.get("stale"):
        raise RefreshError(f"IRSA did not answer ({meta.get('error', 'no detail')}); the last saved list is from "
                           f"{meta.get('saved_utc')} and was not used. Try again later, or use --offline to rebuild "
                           f"from the cache as it is")
    plans = {}
    for band in BANDS:
        full = f"SPHEREx-{band}"
        have = [r for r in mine if r["band"] == full and (cache / r["file"]).exists()]
        try:
            plans[band] = plan_band(have, [r for r in listed if r["band"] == full], limit)
        except RefreshError as e:
            raise RefreshError(f"{obj} {band}: {e}") from None
    return plans, meta.get("saved_utc")


def print_plan(obj, plans, out=print):
    for band, p in plans.items():
        if not p["wanted"] and not p["drop"]:
            out(f"{obj} {band}: not covered by the archive")
            continue
        kinds = Counter("new" if why == "new" else "reprocessed" for _, why in p["download"])
        detail = f" ({', '.join(f'{n} {k}' for k, n in sorted(kinds.items()))})" if kinds else ""
        sub = f" (even subsample of {p['n_archive']})" if len(p["wanted"]) < p["n_archive"] else ""
        out(f"{obj} {band}: {len(p['wanted'])} images in the archive{sub}, {len(p['keep'])} already in the cache, "
            f"{len(p['download'])} to download{detail}, {len(p['drop'])} to drop")
        lines = [f"    + {os.path.basename(r['uri'])}  {why}" for r, why in p["download"]] \
            + [f"    - {os.path.basename(r['uri'])}  {why}" for r, why in p["drop"]]
        for line in lines[:SHOW]:
            out(line)
        if len(lines) > SHOW:
            out(f"    ... and {len(lines) - SHOW} more")


def update_cache(obj, cache, client, limit=150, out=print):
    """Steps 1-3 for one object. Returns the number of failed downloads."""
    cache = Path(cache)
    mine = object_rows(obj, cache)
    ra_s, dec_s, size_s = mine[0]["center_ra"], mine[0]["center_dec"], mine[0]["size_deg"]
    plans, asked = plan_object(obj, cache, client, limit)
    out(f"{obj}: archive list of {asked}")
    print_plan(obj, plans, out)
    failed = 0
    for band, p in plans.items():
        if not p["download"] and not p["drop"]:
            continue
        full = f"SPHEREx-{band}"
        dest = {r["uri"]: cache / obj / band / os.path.basename(r["uri"]) for r, _ in p["download"]}
        todo = [u for u, d in dest.items() if not d.exists()]
        if todo:
            (cache / obj / band).mkdir(parents=True, exist_ok=True)
            for uri, got in zip(todo, client.fetch_cutouts(todo, float(ra_s), float(dec_s), float(size_s))):
                if isinstance(got, Path):
                    shutil.move(str(got), str(dest[uri]))
                else:
                    failed += 1
                    out(f"  failed: {os.path.basename(uri)}: {got}")
        rows, arrived = list(p["keep"]), set()
        for r, _ in p["download"]:
            path = dest[r["uri"]]
            if path.exists():
                arrived.add(exposure(r["uri"]))
                stamp = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                rows.append(dict(object=obj, band=full, mjd=f"{float(r['mjd']):.6f}", uri=r["uri"], center_ra=ra_s,
                                 center_dec=dec_s, size_deg=size_s, file=f"{obj}/{band}/{path.name}",
                                 bytes=path.stat().st_size, downloaded_utc=stamp))
        # an exposure whose new version did not arrive keeps its old one, so the cube stays complete
        rows += [r for r, why in p["drop"] if why == "replaced" and exposure(r["uri"]) not in arrived]
        others = [r for r in fetch_bands.read_manifest(cache) if not (r["object"] == obj and r["band"] == full)]
        fetch_bands.write_manifest(cache, others + rows)
        marker = cache / obj / band / fetch_bands.MARKER  # left by data.fetch_bands for an unfinished detector
        if marker.exists() and len(arrived) == len(p["download"]):
            marker.unlink()
    return failed


def superseded(obj, cache):
    """Cutouts of `obj` on disk that the manifest does not list (older versions of an exposure)."""
    cache = Path(cache)
    listed = {(cache / r["file"]).resolve() for r in fetch_bands.read_manifest(cache) if r["object"] == obj}
    return sorted(p for p in (cache / obj).glob("D[1-6]/*.fits") if p.resolve() not in listed)


def _same_but_for(path, old_text, key):
    """True if the JSON file at `path` equals `old_text` in everything but `key` (the time of the query)."""
    if old_text is None:
        return False
    old, new = json.loads(old_text), json.loads(Path(path).read_text(encoding="utf-8"))
    old.pop(key, None), new.pop(key, None)
    return old == new


def rebuild(obj, cache, cubes, client=None, out=print):
    """Step 4 for one object. `client=None` means offline: catalog.json and coverage.json are left alone.
    Returns the number of things that failed (only the two IRSA files can fail softly)."""
    from data import measure_static, quicklook
    cache, obj_dir = Path(cache), Path(cubes) / obj
    bands = sorted({cube.short_band(r["band"]) for r in object_rows(obj, cache)})
    for band in bands:
        meta, data, flags = cube.build_cube(obj, band, cache, with_flags=True)
        cube.write_cube(meta, data, obj_dir / band, flags)
        if (obj_dir / band / "quicklook.png").exists():  # only the first detector of each object has one in git
            quicklook.main([obj, band, "--cube-dir", str(obj_dir / band)])
        out(f"  {obj} {band}: cube of {meta['shape'][0]} frames")
    failed = 0
    # catalog.json and coverage.json carry the time IRSA was asked. If nothing else changed the old
    # file is put back, so a refresh without news leaves the folder exactly as it was.
    from data import catalog
    if client is not None:
        # before the measurement: the motion fit takes the parallax of the target from this file (A-14)
        path = obj_dir / "catalog.json"
        before = path.read_text(encoding="utf-8") if path.exists() else None
        try:
            catalog.write_catalog(obj_dir)
            if _same_but_for(path, before, "source"):
                path.write_text(before, encoding="utf-8", newline="\n")
        except catalog.CatalogError as e:
            failed += 1
            out(f"  {obj}: catalog.json NOT updated: {e}")
    measure_static.write_object(obj_dir, [cache])
    out(f"  {obj}: measure.json for {', '.join(bands)}, spectrum.json and motion.json")
    if client is None:
        return 0
    from backend import coverage
    path = obj_dir / "coverage.json"
    before = path.read_text(encoding="utf-8") if path.exists() else None
    centre = catalog.cube_centre(obj_dir)
    try:
        cov = coverage.coverage(client, centre["ra"], centre["dec"])
        if cov["source"].get("stale"):
            raise RefreshError("IRSA failed and only a saved answer exists")
        cov["object"] = obj
        path.write_text(json.dumps(cov, indent=1) + "\n", encoding="utf-8", newline="\n")  # as backend.coverage.write_static
        if _same_but_for(path, before, "source"):
            path.write_text(before, encoding="utf-8", newline="\n")
    except Exception as e:  # IrsaError or the stale answer above; the old file stays
        failed += 1
        out(f"  {obj}: coverage.json NOT updated: {type(e).__name__}: {e}"[:300])
    return failed


# ---------- what changed ----------

def _digest(path):
    """SHA-1 of a file, None if it is missing. Text files are compared without regard to line
    endings: on Windows git checks the JSON files out with CRLF and the writers produce LF."""
    path = Path(path)
    if not path.exists():
        return None
    raw = path.read_bytes()
    return hashlib.sha1(raw.replace(b"\r\n", b"\n") if path.suffix == ".json" else raw).hexdigest()


def snapshot(obj_dir):
    """State of one object's folder: per detector a summary of cube.json plus digests, and the object files."""
    obj_dir, snap = Path(obj_dir), {}
    for path in sorted(obj_dir.glob("D[1-6]/cube.json")):
        meta = json.loads(path.read_text(encoding="utf-8"))
        ids = [f["id"] for f in meta["frames"]]
        snap[path.parent.name] = dict(
            n=len(ids), epochs=len(meta["epochs"]), last_mjd=max(f["mjd"] for f in meta["frames"]),
            releases=meta.get("source", {}).get("releases", {}),
            versions=dict(Counter(short_version(i) for i in ids)),
            pixels=_digest(path.parent / "cube.f32"), measure=_digest(path.parent / "measure.json"))
    for name in OBJECT_FILES:
        snap[name] = _digest(obj_dir / name)
    return snap


def _date(mjd):
    return (datetime(1858, 11, 17) + timedelta(days=float(mjd))).strftime("%Y-%m-%d")  # MJD 0 = 1858-11-17


def _counts(d):
    return " + ".join(f"{k} {v}" for k, v in sorted(d.items())) or "?"


def describe(obj, band, old, new):
    """One line on how a cube changed. `old` is None for a detector that had no cube."""
    now = f"{new['n']} frames in {new['epochs']} visits, last image {_date(new['last_mjd'])}, {_counts(new['releases'])}, " \
          f"{' + '.join(sorted(new['versions']))}"
    if old is None:
        return f"{obj} {band}: new cube ({now})"
    if old == new:
        return f"{obj} {band}: unchanged ({now})"
    parts = []
    if old["n"] != new["n"]:
        parts.append(f"{old['n']} -> {new['n']} frames")
    if old["epochs"] != new["epochs"]:
        parts.append(f"{old['epochs']} -> {new['epochs']} visits")
    parts.append(f"last image {_date(new['last_mjd'])}" if _date(old["last_mjd"]) == _date(new["last_mjd"])
                 else f"last image {_date(old['last_mjd'])} -> {_date(new['last_mjd'])}")
    if old["releases"] != new["releases"]:
        parts.append(f"{_counts(old['releases'])} -> {_counts(new['releases'])}")
    if old["versions"] != new["versions"]:
        parts.append(f"{' + '.join(sorted(old['versions']))} -> {' + '.join(sorted(new['versions']))}")
    parts.append("pixels identical" if old["pixels"] == new["pixels"] else "pixels changed")
    parts.append("measure.json identical" if old["measure"] == new["measure"] else "measure.json changed")
    return f"{obj} {band}: " + ", ".join(parts)


def report(obj, before, after, out=print):
    for band in sorted(k for k in after if k not in OBJECT_FILES):
        out(describe(obj, band, before.get(band), after[band]))
    out(f"{obj}: " + ", ".join(f"{name} {'missing' if after[name] is None else 'unchanged' if after[name] == before.get(name) else 'changed'}"
                               for name in OBJECT_FILES))


def main(argv=None, client=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("objects", nargs="*", help="objects of the cache manifest (default: all of them)")
    ap.add_argument("--dry-run", action="store_true", help="list what would be downloaded and written, change nothing")
    ap.add_argument("--offline", action="store_true", help="do not ask IRSA; rebuild from the cache as it is")
    ap.add_argument("--prune", action="store_true", help="delete cutouts the manifest no longer lists")
    ap.add_argument("--cache-dir", type=Path, default=cube.cache_dir().parent / "cache_dr1",
                    help="cache the static cubes are built from (default: data/cache_dr1 next to data/cache)")
    ap.add_argument("--cubes", type=Path, default=cube.REPO / "data" / "cubes")
    ap.add_argument("--limit", type=int, default=150, help="most images per detector (default 150)")
    args = ap.parse_args(argv)
    cache = args.cache_dir
    objects = args.objects or sorted({r["object"] for r in fetch_bands.read_manifest(cache)})
    if client is None and not args.offline:
        from backend import irsa
        client = irsa.IrsaClient(cache / "_irsa", tap_ttl=TAP_MAX_AGE_S)
    problems = 0
    for obj in objects:
        try:
            would = [str(args.cubes / obj / b / name) for b in sorted({cube.short_band(r["band"]) for r in object_rows(obj, cache)})
                     for name in BAND_FILES + ("quicklook.png",) if name in BAND_FILES or (args.cubes / obj / b / name).exists()]
            would += [str(args.cubes / obj / name) for name in (OBJECT_FILES[:OFFLINE_FILES] if args.offline else OBJECT_FILES)]
            if args.dry_run:
                if not args.offline:
                    plans, asked = plan_object(obj, cache, client, args.limit)
                    print(f"{obj}: archive list of {asked}", flush=True)
                    print_plan(obj, plans)
                print(f"{obj}: would write {len(would)} files:")
                folder = None
                for w in would:  # one line per folder
                    if os.path.dirname(w) != folder:
                        folder = os.path.dirname(w)
                        print(f"    {folder}{os.sep}: " + ", ".join(os.path.basename(x) for x in would if os.path.dirname(x) == folder))
                continue
            failed = 0 if args.offline else update_cache(obj, cache, client, args.limit)
            old = superseded(obj, cache)
            if old and args.prune:
                for p in old:
                    p.unlink()
                print(f"{obj}: deleted {len(old)} superseded cutouts")
            elif old:
                print(f"{obj}: {len(old)} superseded cutouts ({sum(p.stat().st_size for p in old) / 1e6:.0f} MB) stay in "
                      f"{cache / obj}; --prune deletes them")
            if failed:
                problems += failed
                print(f"{obj}: {failed} downloads failed, nothing rebuilt. IRSA refuses part of the requests when it is busy: "
                      f"run the same command again", flush=True)
                continue
            before = snapshot(args.cubes / obj)
            problems += rebuild(obj, cache, args.cubes, None if args.offline else client)
            report(obj, before, snapshot(args.cubes / obj))
        except RefreshError as e:
            problems += 1
            print(f"{obj}: STOPPED: {e}", flush=True)
        except Exception as e:  # one object failing (IRSA down, a broken file) must not stop the others
            problems += 1
            print(f"{obj}: FAILED: {type(e).__name__}: {e}"[:400], flush=True)
    print("dry run: nothing was changed" if args.dry_run else f"done, {problems} problems", flush=True)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
