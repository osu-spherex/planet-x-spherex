"""Saved lists of SPHEREx images around the demo objects, for when the archive's search is down (task A-17).

Finding the images that cover a position is a search in IRSA's TAP service. On 2026-11-15 that
search answered 502 from 02:04 (UTC+8) on, while the cutout service kept working: an image whose
address is known could still be fetched. So the answers the search gave on 2026-11-14 for the
five demo objects are kept in the repository (data/listings/dr1.csv, see the README there), and

    saved_images(ra, dec, band=None, max_sep_arcmin=15.0)
        -> ([{uri, band, mjd}, ...], {object, sep_arcmin, listed})     or None

returns the list of the nearest demo object, time-ordered, in the row shape of
backend/irsa.py `query_images` (band as "SPHEREx-D6", mjd as a float). None if no demo object is
within `max_sep_arcmin` of the position: there is then nothing honest to offer.

What the list is, and is not:
  * It is IRSA's own answer for the position of the object (the cube centre), not for (ra, dec).
    A SPHEREx image is 3.5 degrees across, so nearly all of these images also cover a position
    a few arcminutes away, but not necessarily every one; the archive refuses a cutout that
    falls off an image, and the caller has to live with fewer frames.
  * It is as old as `listed`. Images taken or reprocessed since then are missing.
  * For R Draconis (a deep field) it is a selection: at most 150 images per detector, evenly
    spread in time (data/fetch_bands.py), not everything the archive has.
Whoever shows images found this way must say so (CLAUDE.md, rule 5); `listed` is there for that.

Only the standard library is used, so the backend can import this without astropy.
"""
import csv
import json
import math
from functools import lru_cache
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
LISTING = REPO / "data" / "listings" / "dr1.csv"
CUBES = REPO / "data" / "cubes"
LISTED = "2026-11-14"  # the day IRSA gave these answers (data/listings/README.md)
BANDS = tuple(f"SPHEREx-D{i}" for i in range(1, 7))


def full_band(band):
    """'D6', 'd6' or 'SPHEREx-D6' -> 'SPHEREx-D6', the name the archive uses."""
    b = "SPHEREx-" + str(band).strip().upper().replace("SPHEREX-", "")
    if b not in BANDS:
        raise ValueError(f"unknown detector {band!r}; use D1..D6 or SPHEREx-D1..SPHEREx-D6")
    return b


def separation_arcmin(ra1, dec1, ra2, dec2):
    """Angle between two positions (degrees in, arcminutes out); haversine, good at any distance."""
    r1, d1, r2, d2 = (math.radians(v) for v in (ra1, dec1, ra2, dec2))
    h = math.sin((d2 - d1) / 2) ** 2 + math.cos(d1) * math.cos(d2) * math.sin((r2 - r1) / 2) ** 2
    return math.degrees(2 * math.asin(min(1.0, math.sqrt(h)))) * 60.0


@lru_cache(maxsize=4)
def _rows(path):
    """{object: [{uri, band, mjd}] in time order} from a listing file."""
    out = {}
    with open(path, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            out.setdefault(r["object"], []).append(dict(uri=r["uri"], band=r["band"], mjd=float(r["mjd"])))
    for rows in out.values():
        rows.sort(key=lambda r: (r["mjd"], r["uri"]))
    return out


@lru_cache(maxsize=4)
def _centres(cubes):
    """{object: (ra, dec)}: the centre of each object's cubes (all detectors of an object share it)."""
    out = {}
    for path in sorted(Path(cubes).glob("*/*/cube.json")):
        obj = path.parent.parent.name
        if obj not in out:
            c = json.loads(path.read_text(encoding="utf-8"))["center"]
            out[obj] = (float(c["ra"]), float(c["dec"]))
    return out


def saved_images(ra, dec, band=None, max_sep_arcmin=15.0, listing=LISTING, cubes=CUBES):
    """The saved image list of the demo object nearest to (ra, dec) in degrees, or None if none
    is within `max_sep_arcmin`. Returns (rows, info):

        rows  [{uri, band, mjd}], time-ordered; only detector `band` if one is given
              ("D6" and "SPHEREx-D6" both work). Copies: the caller may change them.
        info  {object, sep_arcmin, listed}: which object's list this is, how far its centre is
              from the position asked for, and the date of the list.
    """
    want = full_band(band) if band is not None else None
    by_object, centres = _rows(str(listing)), _centres(str(cubes))
    near = [(separation_arcmin(ra, dec, *centres[obj]), obj) for obj in by_object if obj in centres]
    if not near:
        return None
    sep, obj = min(near)
    if sep > max_sep_arcmin:
        return None
    rows = [dict(r) for r in by_object[obj] if want is None or r["band"] == want]
    return rows, dict(object=obj, sep_arcmin=round(sep, 2), listed=LISTED)


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("ra", type=float)
    ap.add_argument("dec", type=float)
    ap.add_argument("band", nargs="?", default=None)
    args = ap.parse_args(argv)
    found = saved_images(args.ra, args.dec, args.band)
    if found is None:
        print("no demo object within 15 arcmin: nothing saved for this position")
        return 1
    rows, info = found
    print(f"{len(rows)} images of {info['object']} ({info['sep_arcmin']} arcmin away), listed {info['listed']}")
    for r in rows[:5]:
        print(f"  {r['mjd']:.4f} {r['band']} {r['uri']}")
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
