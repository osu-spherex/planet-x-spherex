"""Catalogue sources around a position, for the overlay on the images (task A-11).

    sources_near(ra, dec, radius_arcsec) -> dict       Gaia DR3 + CatWISE2020 through IRSA TAP
    python -m data.catalog [object ...]                writes data/cubes/<object>/catalog.json

Result (docs/ARCHITECTURE.md, "Каталогийн давхарга"):
    { center: {ra, dec}, radius_arcsec,
      sources: [{ cat: "gaia_dr3" | "catwise2020", id, ra, dec, epoch, pm_ra, pm_dec, mag, mag_band,
                  sep_arcsec, parallax (Gaia only: arcsec, or null) }],
      source: { archive, queried_utc } }
`ra`, `dec` (degrees, ICRS) are the position at `epoch` (a year, e.g. 2016.0). `pm_ra`, `pm_dec` are
in arcsec/yr, `pm_ra` already multiplied by cos(dec); null means "do not shift this source".
To place a source in an image taken in year T:  dec + pm_dec * (T - epoch) / 3600,
ra + pm_ra * (T - epoch) / 3600 / cos(dec).

Only IRSA is used; nothing here depends on CDS (SIMBAD, VizieR), which was down on 2026-11-10.
One exception, task A-14: on 2026-11-15 IRSA's TAP service was down (502) when the Gaia parallax
was needed, so `python -m data.catalog --parallax-from-esa` adds that one column to the existing
files from the ESA Gaia Archive, the origin of the table IRSA mirrors (`add_gaia_parallax`). It
looks sources up by `source_id` and refuses a file unless the proper motions of the two archives
agree for every source. A normal run asks IRSA for the parallax together with everything else.

Columns, as IRSA's own TAP_SCHEMA.columns describes them (queried 2026-11-14):

gaia_dr3_source (Gaia DR3 main source table; data model:
https://gea.esac.esa.int/archive/documentation/GDR3/Gaia_archive/chap_datamodel/sec_dm_main_source_catalogue/ssec_dm_gaia_source.html)
    source_id         64-bit identifier; kept as a string because JavaScript numbers cannot hold it
    ra, dec           deg, at ref_epoch (2016.0 for every DR3 source)
    pmra, pmdec       mas/yr; pmra is the motion in RA times cos(dec). Null for sources with a
                      position-only solution.
    parallax          mas, "Parallax"; null with a position-only solution. Passed on in arcsec; it can
                      be negative for a distant star (it is a measurement, with noise). Used by
                      data/measure_static.py to take the yearly parallax swing out of a motion fit.
    phot_g_mean_mag   G-band mean magnitude

catwise_2020 (CatWISE2020, https://irsa.ipac.caltech.edu/Missions/wise.html)
    source_name       "source hexagesimal designation"
    ra, dec           deg, from the fit without motion; mean epoch in meanobsmjd ("mean observation epoch", d)
    ra_pm, dec_pm     deg, "at epoch MJD=57170 (2015.405) from psf model incl. motion"
    pmra, pmdec       arcsec/yr, "Apparent motion in RA / Dec"; sigpmra, sigpmdec their uncertainties
    w1mpro, w2mpro    mag, profile-fit magnitudes in W1 (3.4 um) and W2 (4.6 um)
    rchi2, rchi2_pm   reduced chi-square of the fit without and with motion
CatWISE motions cannot be taken at face value. For faint sources they are mostly noise (a few
tenths of an arcsec per year; eleven years of that moves a still star by several arcseconds).
Worse, around a bright fast star the catalogue lists fragments of its image as separate sources
with large, formally precise motions: within 150" of Barnard's Star there are 14 entries above
5 arcsec/yr and 132 that pass a plain 5-sigma test (checked 2026-11-14). So a CatWISE motion is
passed on only if the catalogue's own fit statistics support it (`catwise_motion_is_real`):
significant, a good fit with motion, and a much worse fit without. WISE 0855 passes
(rchi2 5.16 -> rchi2_pm 1.00); the fragments near Barnard's Star have rchi2_pm of 2 to 155.
For a source that passes, the motion-fit position and epoch 2015.405 are given; for all others
pm is null and the no-motion position with its own mean epoch is given.

Several entries can describe one moving object. CatWISE2020 lists WISE 0855 four times
(SELECT * within 45" of 133.7818, -7.2440, queried 2026-11-14):
    source_name            pmra    pmdec   sigpmra sigpmdec  rchi2  rchi2_pm  w2snr_pm
    J085508.34-071439.2   -7.965  +0.806   0.190   0.265     5.16   1.005     38.0     kept
    J085506.91-071437.5   -7.920  +0.494   0.152   0.235     5.27   0.777     35.9     duplicate
    J085507.96-071439.3   -8.021  +1.036   0.089   0.141     5.55   1.726     37.9     fails: rchi2_pm
    J085507.45-071437.8   -4.252  -3.610   0.222   0.221     5.41   3.649     24.0     fails: rchi2_pm
The first two pass the test and differ by 0.31 arcsec/yr in declination, 0.9 of their combined
uncertainty: the catalogue's own numbers cannot tell which is right. Of entries whose motion-fit
positions lie within 6" of each other we keep the one whose rchi2_pm is nearest to 1, the value
expected of a correct model with correct errors (0.78 is not a better fit than 1.00), and drop
the rest. That rule is a tie-break between equivalent entries, not evidence. What supports the
kept entry is outside the catalogue: Spitzer astrometry over 2014-2019 gives
(-8.1237 +- 0.0013, +0.6732 +- 0.0013) arcsec/yr (Kirkpatrick et al. 2021, ApJS 253, 7, Table 5,
arXiv:2011.11616; Luhman & Esplin 2016, AJ 152, 78, Table 4, arXiv:1605.06655, have
(-8.118 +- 0.008, +0.680 +- 0.007)). The kept motion is 0.21 arcsec/yr from it, the duplicate
0.27. It is also the value used everywhere else in the project (frontend/lib/objects.ts,
experiments/check_objects.py); see docs/DECISIONS.md, 2026-11-14 "one catalogue motion".
Both entries put the object within 2.5" of the Spitzer solution in 2026 (the duplicate 1.8",
the kept one 2.4"), less than one 3" cube pixel.
"""
import argparse
import csv
import io
import json
import math
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

TAP_SYNC = "https://irsa.ipac.caltech.edu/TAP/sync"
ARCHIVE = "NASA/IPAC IRSA TAP: gaia_dr3_source, catwise_2020"
CATWISE_PM_EPOCH = 2015.405  # MJD 57170, from the column description of ra_pm / dec_pm
PM_SIGMA = 5.0               # a CatWISE motion counts as real above this many sigma ...
PM_MIN = 0.1                 # ... and above this many arcsec/yr in total (0.1"/yr = 1" in ten years) ...
PM_MAX_RCHI2 = 1.5           # ... if the fit with motion is good ...
PM_MIN_IMPROVEMENT = 2.0     # ... and at least this many times better (in rchi2) than the fit without
PM_DUPLICATE_ARCSEC = 6.0    # entries this close at epoch 2015.405 are one object (a SPHEREx pixel is 6.16")
DEFAULT_RADIUS = 150.0       # arcsec: reaches the corners of a 3' cube (half diagonal 129")

GAIA_COLUMNS = "source_id, ra, dec, ref_epoch, pmra, pmdec, parallax, phot_g_mean_mag"
# https://gea.esac.esa.int/archive/ ; TAP: https://www.cosmos.esa.int/web/gaia-users/archive/programmatic-access
ESA_TAP_SYNC = "https://gea.esac.esa.int/tap-server/tap/sync"
ESA_ARCHIVE = "ESA Gaia Archive TAP: gaiadr3.gaia_source"
CATWISE_COLUMNS = ("source_name, ra, dec, meanobsmjd, ra_pm, dec_pm, pmra, pmdec, sigpmra, sigpmdec, "
                   "w1mpro, w2mpro, rchi2, rchi2_pm")

REPO = Path(__file__).resolve().parents[1]


class CatalogError(RuntimeError):
    """The catalogue service could not be queried; the message is fit to show to a person."""


def cone_query(table, columns, ra, dec, radius_arcsec):
    return (f"SELECT {columns} FROM {table} WHERE 1=CONTAINS(POINT('ICRS', ra, dec), "
            f"CIRCLE('ICRS', {ra:.7f}, {dec:.7f}, {radius_arcsec / 3600:.7f}))")


def tap_csv(query, tries=4, wait_s=10.0, timeout_s=240.0, get=None, sleep=time.sleep):
    """Run an ADQL query on IRSA and return the CSV text. IRSA answers 503 or drops the connection
    often, and was very slow on 2026-11-14 (55 s for a one-row query), so retry, then give up
    with one clear error."""
    if get is None:
        import requests  # imported here: parsing saved answers must work without it
        get = requests.get
    last = "no attempt was made"
    for attempt in range(tries):
        if attempt:
            sleep(wait_s * attempt)
        try:
            res = get(TAP_SYNC, params={"QUERY": query, "FORMAT": "CSV"}, timeout=timeout_s)
        except Exception as e:  # requests raises many types for network trouble
            last = f"{type(e).__name__}: {e}"[:200]
            continue
        if res.status_code == 200 and not res.text.lstrip().startswith("<"):
            return res.text
        last = f"HTTP {res.status_code}: {res.text[:160]!r}"
        if 400 <= res.status_code < 500 and res.status_code != 429:
            break  # the query itself is wrong: asking again will not help
    raise CatalogError(f"The catalogue service (IRSA) did not answer after {attempt + 1} attempts. Last answer: {last}")


def esa_csv(query, timeout_s=180.0, post=None):
    """Run an ADQL query on the ESA Gaia Archive and return the CSV text."""
    if post is None:
        import requests
        post = requests.post
    try:
        res = post(ESA_TAP_SYNC, data={"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "csv", "QUERY": query}, timeout=timeout_s)
    except Exception as e:
        raise CatalogError(f"The ESA Gaia Archive could not be reached: {type(e).__name__}: {e}"[:300])
    if res.status_code != 200 or res.text.lstrip().startswith("<"):
        raise CatalogError(f"The ESA Gaia Archive answered HTTP {res.status_code}: {res.text[:160]!r}")
    return res.text


def add_gaia_parallax(object_dir, fetch=esa_csv, batch=200):
    """Add `parallax` (arcsec, null if Gaia has none) to the Gaia sources of an existing catalog.json.

    The values are looked up by source_id in the ESA Gaia Archive. As a check that both archives
    hold the same rows, the proper motions that came from IRSA must equal ESA's for every source,
    to 0.02 mas/yr (the file keeps 0.01 mas/yr, and the last digit differs for a few sources,
    seen 2026-11-15: -3.57 against -3.58 mas/yr); otherwise nothing is written.
    Returns (result, path)."""
    path = Path(object_dir) / "catalog.json"
    result = json.loads(path.read_text(encoding="utf-8"))
    gaia = [s for s in result["sources"] if s["cat"] == "gaia_dr3"]
    found = {}
    for i in range(0, len(gaia), batch):
        ids = ", ".join(s["id"] for s in gaia[i:i + batch])
        for r in _rows(fetch(f"SELECT source_id, parallax, pmra, pmdec FROM gaiadr3.gaia_source WHERE source_id IN ({ids})")):
            found[r["source_id"].strip()] = r
    for s in gaia:
        r = found.get(s["id"])
        if r is None:
            raise CatalogError(f"{path}: Gaia DR3 {s['id']} is not in the ESA archive's answer")
        pmra, pmdec = _f(r["pmra"]), _f(r["pmdec"])
        theirs = (_r(pmra / 1000.0, 5), _r(pmdec / 1000.0, 5)) if pmra is not None and pmdec is not None else (None, None)
        ours = (s["pm_ra"], s["pm_dec"])
        same = theirs == ours if None in theirs + ours else max(abs(a - b) for a, b in zip(theirs, ours)) <= 2.0e-5 + 1e-12
        if not same:
            raise CatalogError(f"{path}: Gaia DR3 {s['id']} has proper motion {theirs} at ESA but "
                               f"({s['pm_ra']}, {s['pm_dec']}) in the file (from IRSA)")
    for s in gaia:
        parallax = _f(found[s["id"]]["parallax"])
        s["parallax"] = _r(parallax / 1000.0, 5) if parallax is not None else None
    result["source"]["parallax"] = dict(archive=ESA_ARCHIVE, queried_utc=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                                        note="added by source_id; proper motions of all sources agree with IRSA's")
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(result, f, indent=1, allow_nan=False)
        f.write("\n")
    return result, path


def _rows(text):
    return list(csv.DictReader(io.StringIO(text.strip())))


def _f(v):
    """CSV cell -> float, or None for an empty / null cell."""
    if v is None or v.strip() in ("", "null", "NULL", "nan", "NaN"):
        return None
    x = float(v)
    return x if math.isfinite(x) else None


def _r(v, digits):
    return None if v is None else round(v, digits)


def parse_gaia(text):
    out = []
    for r in _rows(text):
        pmra, pmdec = _f(r["pmra"]), _f(r["pmdec"])
        has_pm = pmra is not None and pmdec is not None
        out.append(dict(
            cat="gaia_dr3", id=r["source_id"].strip(), ra=_f(r["ra"]), dec=_f(r["dec"]),
            epoch=_f(r["ref_epoch"]),
            pm_ra=_r(pmra / 1000.0, 5) if has_pm else None,   # mas/yr -> arcsec/yr
            pm_dec=_r(pmdec / 1000.0, 5) if has_pm else None,
            mag=_r(_f(r["phot_g_mean_mag"]), 3), mag_band="G"))
        if "parallax" in r:  # asked for since task A-14; mas -> arcsec
            parallax = _f(r["parallax"])
            out[-1]["parallax"] = _r(parallax / 1000.0, 5) if parallax is not None else None
    return out


def mjd_to_year(mjd):
    return 2000.0 + (mjd - 51544.5) / 365.25  # Julian epoch


def catwise_motion_is_real(pmra, pmdec, sigpmra, sigpmdec, rchi2, rchi2_pm):
    """True if CatWISE's own numbers support the motion: significant, well fitted with motion,
    clearly worse without. Any missing number means no."""
    if None in (pmra, pmdec, sigpmra, sigpmdec, rchi2, rchi2_pm) or sigpmra <= 0 or sigpmdec <= 0 or rchi2_pm <= 0:
        return False
    total = math.hypot(pmra, pmdec)
    if total < PM_MIN:
        return False
    sigma = math.hypot(pmra * sigpmra, pmdec * sigpmdec) / total  # error of the total motion
    return total >= PM_SIGMA * sigma and rchi2_pm <= PM_MAX_RCHI2 and rchi2 >= PM_MIN_IMPROVEMENT * rchi2_pm


def parse_catwise(text):
    out, fits = [], []
    for r in _rows(text):
        pmra, pmdec = _f(r["pmra"]), _f(r["pmdec"])
        ra_pm, dec_pm, rchi2_pm = _f(r["ra_pm"]), _f(r["dec_pm"]), _f(r["rchi2_pm"])
        moving = (ra_pm is not None and dec_pm is not None and catwise_motion_is_real(
            pmra, pmdec, _f(r["sigpmra"]), _f(r["sigpmdec"]), _f(r["rchi2"]), rchi2_pm))
        w1, w2 = _f(r["w1mpro"]), _f(r["w2mpro"])
        mjd = _f(r["meanobsmjd"])
        out.append(dict(
            cat="catwise2020", id=r["source_name"].strip(),
            ra=ra_pm if moving else _f(r["ra"]), dec=dec_pm if moving else _f(r["dec"]),
            epoch=CATWISE_PM_EPOCH if moving else _r(mjd_to_year(mjd), 3) if mjd is not None else None,
            pm_ra=_r(pmra, 4) if moving else None, pm_dec=_r(pmdec, 4) if moving else None,
            # W2 (4.6 um) is the band nearest to what SPHEREx D5/D6 see; W1 if a source has no W2
            mag=_r(w2 if w2 is not None else w1, 3), mag_band="W2" if w2 is not None else "W1"))
        fits.append(rchi2_pm if moving else None)
    # one moving object, several catalogue entries: keep the one whose reduced chi-square with
    # motion is nearest to 1 (module docstring: why, and why it is only a tie-break)
    drop = set()
    movers = sorted((i for i, f in enumerate(fits) if f is not None), key=lambda i: abs(fits[i] - 1.0))
    for n, i in enumerate(movers):
        if i in drop:
            continue
        for j in movers[n + 1:]:
            if j not in drop and separation_arcsec(out[j]["ra"], out[j]["dec"], out[i]["ra"], out[i]["dec"]) <= PM_DUPLICATE_ARCSEC:
                drop.add(j)
    return [s for i, s in enumerate(out) if i not in drop]


def separation_arcsec(ra, dec, ra0, dec0):
    """Small-angle separation; exact enough for a few arcminutes."""
    dx = ((ra - ra0 + 180.0) % 360.0 - 180.0) * math.cos(math.radians(dec0)) * 3600.0
    return math.hypot(dx, (dec - dec0) * 3600.0)


def sources_near(ra, dec, radius_arcsec=DEFAULT_RADIUS, fetch=tap_csv):
    """Gaia DR3 and CatWISE2020 sources within `radius_arcsec` of (ra, dec), nearest first.

    `fetch(query) -> csv text` can be replaced in tests. Raises CatalogError if IRSA cannot be
    reached, ValueError for an impossible position or radius.
    """
    if not (0 <= ra < 360 and -90 <= dec <= 90):
        raise ValueError(f"position out of range: RA {ra}, Dec {dec}")
    if not (0 < radius_arcsec <= 600):
        raise ValueError("radius must be between 0 and 600 arcsec")
    sources = (parse_gaia(fetch(cone_query("gaia_dr3_source", GAIA_COLUMNS, ra, dec, radius_arcsec)))
               + parse_catwise(fetch(cone_query("catwise_2020", CATWISE_COLUMNS, ra, dec, radius_arcsec))))
    sources = [s for s in sources if s["ra"] is not None and s["dec"] is not None]
    for s in sources:
        s["sep_arcsec"] = round(separation_arcsec(s["ra"], s["dec"], ra, dec), 2)
        s["ra"], s["dec"] = round(s["ra"], 7), round(s["dec"], 7)
    sources.sort(key=lambda s: (s["sep_arcsec"], s["cat"], s["id"]))
    return dict(center=dict(ra=ra, dec=dec), radius_arcsec=radius_arcsec, sources=sources,
                source=dict(archive=ARCHIVE, queried_utc=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")))


def cube_centre(object_dir):
    """Centre of an object's cubes (all detectors of one object share it)."""
    for path in sorted(Path(object_dir).glob("*/cube.json")):
        return json.loads(path.read_text(encoding="utf-8"))["center"]
    raise FileNotFoundError(f"no cube.json under {object_dir}")


def write_catalog(object_dir, radius_arcsec=DEFAULT_RADIUS, fetch=tap_csv):
    centre = cube_centre(object_dir)
    result = sources_near(centre["ra"], centre["dec"], radius_arcsec, fetch)
    path = Path(object_dir) / "catalog.json"
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(result, f, indent=1, allow_nan=False)
        f.write("\n")
    return result, path


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("objects", nargs="*", help="folders under data/cubes (default: all)")
    ap.add_argument("--cubes", type=Path, default=REPO / "data" / "cubes")
    ap.add_argument("--radius", type=float, default=DEFAULT_RADIUS, help="arcsec (default 150)")
    ap.add_argument("--parallax-from-esa", action="store_true",
                    help="only add the Gaia parallax to the existing catalog.json files, from the ESA Gaia Archive")
    args = ap.parse_args(argv)
    if args.parallax_from_esa:
        failed = 0
        for name in args.objects or sorted(p.parent.name for p in args.cubes.glob("*/catalog.json")):
            try:
                r, path = add_gaia_parallax(args.cubes / name)
            except CatalogError as e:
                failed += 1
                print(f"{name}: FAILED: {e}")
                continue
            gaia = [s for s in r["sources"] if s["cat"] == "gaia_dr3"]
            print(f"{name}: parallax for {sum(s['parallax'] is not None for s in gaia)} of {len(gaia)} Gaia DR3 sources -> {path}")
        return 1 if failed else 0
    names = args.objects or sorted(p.name for p in args.cubes.iterdir() if p.is_dir() and any(p.glob("*/cube.json")))
    failed = 0
    for name in names:
        try:
            r, path = write_catalog(args.cubes / name, args.radius)
        except CatalogError as e:
            failed += 1
            print(f"{name}: FAILED: {e}")
            continue
        n = {c: sum(s["cat"] == c for s in r["sources"]) for c in ("gaia_dr3", "catwise2020")}
        moving = sum(s["cat"] == "catwise2020" and s["pm_ra"] is not None for s in r["sources"])
        print(f"{name}: {n['gaia_dr3']} Gaia DR3, {n['catwise2020']} CatWISE2020 ({moving} with a significant motion) "
              f"within {args.radius:g}\" -> {path}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
